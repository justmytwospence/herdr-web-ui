import { describe, expect, it } from "bun:test";

import { paneStatus, rollupStatus, statusEdgeRead } from "./status.ts";
import { setWaitToken, waitingOn } from "./waitToken.ts";

describe("rollupStatus", () => {
  it("rolls a workspace's panes up as herdr does: blocked, then done, then working, then ready", () => {
    expect(rollupStatus(["idle", "blocked", "working"])).toBe("blocked");
    expect(rollupStatus(["blocked", "done"])).toBe("blocked");
    expect(rollupStatus(["done", "working"])).toBe("done");
    expect(rollupStatus(["idle", "working"])).toBe("working");
    expect(rollupStatus(["idle", "done"])).toBe("done");
    expect(rollupStatus(["idle", undefined])).toBe("idle");
  });

  it("puts a pane waiting on its background work after working and before ready", () => {
    expect(rollupStatus(["waiting", "idle"])).toBe("waiting");
    expect(rollupStatus(["waiting", "working"])).toBe("working");
    expect(rollupStatus(["done", "waiting", "idle"])).toBe("done");
  });
});

describe("paneStatus", () => {
  it("reads a pane at rest that waits on its turn's background work as BG, and any other as its status", () => {
    expect(paneStatus({ agent_status: "done", background_wait: true })).toBe("waiting");
    expect(paneStatus({ agent_status: "idle", background_wait: true })).toBe("waiting");
    expect(paneStatus({ agent_status: "working", background_wait: true })).toBe("working");
    expect(paneStatus({ agent_status: "blocked", background_wait: true })).toBe("blocked");
    expect(paneStatus({ agent_status: "done" })).toBe("done");
  });

  it("reads a working pane whose wait token holds a value as BG, once the server named the token", () => {
    const pane = { agent_status: "working" as const, tokens: { wait: "the test suite" } };
    expect(paneStatus(pane)).toBe("working");
    setWaitToken("wait");
    try {
      expect(paneStatus(pane)).toBe("waiting");
      expect(paneStatus({ ...pane, tokens: { wait: " " } })).toBe("working");
      expect(paneStatus({ ...pane, tokens: {} })).toBe("working");
      // the wait token says nothing about a pane at rest or asking: those read as they are
      expect(paneStatus({ ...pane, agent_status: "done" })).toBe("done");
      expect(paneStatus({ ...pane, agent_status: "blocked" })).toBe("blocked");
      expect(paneStatus({ ...pane, agent_status: "idle", background_wait: true })).toBe("waiting");
    } finally { setWaitToken(null); }
    expect(paneStatus(pane)).toBe("working");
  });

  it("is unknown only when no pane says more", () => {
    expect(rollupStatus([undefined, "unknown", "something-new"])).toBe("unknown");
    expect(rollupStatus([])).toBe("unknown");
  });
});

describe("waitingOn", () => {
  it("is the token's trimmed value on a working pane, and nothing without a token, a string, or work", () => {
    const pane = { agent_status: "working" as const, tokens: { wait: "  a long job  ", other: 3 } };
    expect(waitingOn(pane, "wait")).toBe("a long job");
    expect(waitingOn(pane, "other")).toBeNull();
    expect(waitingOn(pane, "missing")).toBeNull();
    expect(waitingOn(pane, null)).toBeNull();
    expect(waitingOn({ ...pane, agent_status: "idle" }, "wait")).toBeNull();
    expect(waitingOn({ agent_status: "working" }, "wait")).toBeNull();
    expect(waitingOn({ agent_status: "working", tokens: { wait: "" } }, "wait")).toBeNull();
  });

  it("caps a long value for the chat's line", () => {
    const what = waitingOn({ agent_status: "working", tokens: { wait: "x".repeat(200) } }, "wait")!;
    expect(what.length).toBe(80);
    expect(what.endsWith("…")).toBe(true);
  });

  it("takes the server's name as given, trimmed, and forgets a blank one", () => {
    setWaitToken(" wait ");
    try { expect(waitingOn({ agent_status: "working", tokens: { wait: "job" } })).toBe("job"); } finally { setWaitToken("") }
    expect(waitingOn({ agent_status: "working", tokens: { wait: "job" } })).toBeNull();
  });
});

describe("statusEdgeRead", () => {
  it("reads at once when a turn starts or ends", () => {
    expect(statusEdgeRead("working", "done")).toBe(true);
    expect(statusEdgeRead("working", "idle")).toBe(true);
    expect(statusEdgeRead("working", "blocked")).toBe(true);
    expect(statusEdgeRead("idle", "working")).toBe(true);
    expect(statusEdgeRead("done", "working")).toBe(true);
    expect(statusEdgeRead(undefined, "working")).toBe(true);
  });

  it("leaves an unchanged status and changes that neither start nor end a turn to the regular reads", () => {
    expect(statusEdgeRead("working", "working")).toBe(false);
    expect(statusEdgeRead("idle", "idle")).toBe(false);
    expect(statusEdgeRead("idle", "done")).toBe(false);
    expect(statusEdgeRead("blocked", "idle")).toBe(false);
    expect(statusEdgeRead(undefined, undefined)).toBe(false);
  });
});
