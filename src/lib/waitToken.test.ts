import { afterEach, describe, expect, it } from "bun:test";
import { setWaitToken, waitingOn, waitToken } from "./waitToken.ts";

afterEach(() => { setWaitToken(null); });

describe("waiting pane token", () => {
  const pane = { agent_status: "working", tokens: { wait: "indexing", other: "a build" } };

  it("starts unset and trims the configured name", () => {
    expect(waitToken()).toBeNull();
    expect(waitingOn(pane)).toBeNull();
    setWaitToken("  wait \n");
    expect(waitToken()).toBe("wait");
    expect(waitingOn(pane)).toBe("indexing");
  });

  for (const next of [undefined, null, "", " \t\n "]) {
    it(`clears the setting with ${JSON.stringify(next)}`, () => {
      setWaitToken("wait");
      setWaitToken(next);
      expect(waitToken()).toBeNull();
      expect(waitingOn(pane)).toBeNull();
    });
  }

  it("permits an explicit name or null without changing the configured name", () => {
    setWaitToken("wait");
    expect(waitingOn(pane, "other")).toBe("a build");
    expect(waitingOn(pane, null)).toBeNull();
    expect(waitToken()).toBe("wait");
  });

  for (const status of ["working", "idle", "done", "blocked", "unknown", "future", undefined]) {
    it(`only labels a raw working pane, not ${status}`, () => {
      setWaitToken("wait");
      expect(waitingOn({ ...pane, agent_status: status })).toBe(status === "working" ? "indexing" : null);
    });
  }

  it("does not label a missing token map or token value", () => {
    setWaitToken("wait");
    expect(waitingOn({ agent_status: "working" })).toBeNull();
    expect(waitingOn({ agent_status: "working", tokens: {} })).toBeNull();
    expect(waitingOn(pane, "missing")).toBeNull();
  });

  for (const value of [undefined, null, true, false, 0, 42, {}, [], "", " \t\n "]) {
    it(`ignores a nonstring or blank value ${JSON.stringify(value)}`, () => {
      setWaitToken("wait");
      expect(waitingOn({ agent_status: "working", tokens: { wait: value } })).toBeNull();
    });
  }

  it("trims a label and clips only labels longer than 80 characters", () => {
    setWaitToken("wait");
    const label = (value: string) => waitingOn({ agent_status: "working", tokens: { wait: value } });
    expect(label("  indexing \n")).toBe("indexing");
    expect(label("x".repeat(80))).toBe("x".repeat(80));
    expect(label(`  ${"x".repeat(81)}  `)).toBe(`${"x".repeat(79)}…`);
    expect(label("a new job")).toBe("a new job");
  });
});
