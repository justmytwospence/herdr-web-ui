import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { HealthInfo } from "./api.ts";
import { useLocalHealth } from "./useLocalHealth.ts";
import { setWaitToken, waitToken } from "./waitToken.ts";

type Hook = ReturnType<typeof useLocalHealth>;
const health = (wait_token?: string): HealthInfo => ({
  ok: true,
  herdr: { version: "fixture", protocol: 22, terminal_attach: false, terminal_mirror: true },
  web_ui: { boot_id: "fixture-boot", revision: null, ...(wait_token === undefined ? {} : { wait_token }) },
});

// The real hook and health evidence reducer, with controlled HTTP replies instead of timers.
describe("the confirmed local health wait token", () => {
  let saved: PropertyDescriptor | undefined;
  let renderer: ReactTestRenderer | undefined;
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  let replies: Array<ReturnType<typeof Promise.withResolvers<Response>>>;
  let reads: Promise<void>[];
  let hook: Hook | undefined;
  let published: Array<{ health: HealthInfo | null; token: string | null }>;

  beforeEach(async () => {
    setWaitToken(null);
    replies = [];
    reads = [];
    published = [];
    hook = undefined;
    saved = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign((url: RequestInfo | URL) => {
      expect(url).toBe("/api/health");
      const reply = Promise.withResolvers<Response>();
      replies.push(reply);
      return reply.promise;
    }, { preconnect: globalThis.fetch.preconnect }));
    function Probe() {
      hook = useLocalHealth();
      published.push({ health: hook.health, token: waitToken() });
      return null;
    }
    await act(async () => { renderer = create(createElement(Probe)); });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    fetchSpy.mockRestore();
    setWaitToken(null);
    if (saved) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", saved);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  const live = (): Hook => {
    if (!hook) throw new Error("not rendered");
    return hook;
  };
  const read = (): number => {
    reads.push(live().readLocalHealth());
    return reads.length - 1;
  };
  const answer = async (id: number, body: HealthInfo): Promise<void> => {
    await act(async () => { replies[id]!.resolve(Response.json(body)); await reads[id]; });
  };
  const fail = async (id: number): Promise<void> => {
    await act(async () => { replies[id]!.reject(new TypeError("offline")); await reads[id]; });
  };

  it("sets the accepted name before publishing the confirmed health", async () => {
    await answer(read(), health(" first "));
    expect(waitToken()).toBe("first");
    expect(live().health).toEqual(health(" first "));
    expect(published.at(-1)).toEqual({ health: health(" first "), token: "first" });
    expect(live().localFreshness).toBe("fresh");
  });

  for (const missing of ["field", "web_ui"] as const) {
    it(`clears the setting after a successful answer without ${missing}`, async () => {
      await answer(read(), health("wait"));
      const cleared = health();
      if (missing === "web_ui") delete cleared.web_ui;
      await answer(read(), cleared);
      expect(waitToken()).toBeNull();
      expect(published.at(-1)).toEqual({ health: cleared, token: null });
    });
  }

  for (const next of ["second", undefined]) {
    it(`a late older answer cannot restore a name after a newer ${next ?? "clearing"} answer`, async () => {
      await answer(read(), health("first"));
      const older = read();
      const newer = read();
      await answer(newer, health(next));
      const accepted = live().localHealth;
      const renders = published.length;
      await answer(older, health("obsolete"));
      expect(waitToken()).toBe(next ?? null);
      expect(live().localHealth).toBe(accepted);
      expect(published.length).toBe(renders);
    });
  }

  it("keeps the latest confirmed name through failed reads, even when unavailable", async () => {
    await answer(read(), health("wait"));
    await fail(read());
    expect(waitToken()).toBe("wait");
    expect(live().localFreshness).toBe("unknown");
    await fail(read());
    expect(waitToken()).toBe("wait");
    expect(live().localFreshness).toBe("unavailable");
    expect(live().shownHealth).toBeNull();
    expect(live().health).toEqual(health("wait"));
  });

  it("an initial failure leaves the setting unset", async () => {
    await fail(read());
    expect(waitToken()).toBeNull();
    expect(live().health).toBeNull();
    expect(live().localFreshness).toBe("unknown");
  });

  it("accepts an older successful answer after a newer failure without forgetting that failure", async () => {
    const older = read();
    const newer = read();
    await fail(newer);
    await answer(older, health("wait"));
    expect(waitToken()).toBe("wait");
    expect(live().health).toEqual(health("wait"));
    expect(live().localHealth.failures).toBe(1);
    expect(live().localFreshness).toBe("unknown");
  });

  it("ignores an older failed read after a newer confirmed name", async () => {
    const older = read();
    const newer = read();
    await answer(newer, health("latest"));
    await fail(older);
    expect(waitToken()).toBe("latest");
    expect(live().localHealth.failures).toBe(0);
    expect(live().localFreshness).toBe("fresh");
  });
});
