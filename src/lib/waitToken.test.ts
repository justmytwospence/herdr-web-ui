import { describe, expect, it } from "bun:test";
import { waitingOn } from "./waitToken.ts";

describe("waiting pane token", () => {
  const pane = { agent_status: "working", tokens: { wait: "indexing", other: "a build" } };

  it("reads the pane's `wait` token, and no other", () => {
    expect(waitingOn(pane)).toBe("indexing");
    expect(waitingOn({ agent_status: "working", tokens: { other: "a build" } })).toBeNull();
  });

  for (const status of ["working", "idle", "done", "blocked", "unknown", "future", undefined]) {
    it(`only labels a raw working pane, not ${status}`, () => {
      expect(waitingOn({ ...pane, agent_status: status })).toBe(status === "working" ? "indexing" : null);
    });
  }

  it("does not label a missing token map or token value", () => {
    expect(waitingOn({ agent_status: "working" })).toBeNull();
    expect(waitingOn({ agent_status: "working", tokens: {} })).toBeNull();
  });

  for (const value of [undefined, null, true, false, 0, 42, {}, [], "", " \t\n "]) {
    it(`ignores a nonstring or blank value ${JSON.stringify(value)}`, () => {
      expect(waitingOn({ agent_status: "working", tokens: { wait: value } })).toBeNull();
    });
  }

  it("trims a label and clips only labels longer than 80 characters", () => {
    const label = (value: string) => waitingOn({ agent_status: "working", tokens: { wait: value } });
    expect(label("  indexing \n")).toBe("indexing");
    expect(label("x".repeat(80))).toBe("x".repeat(80));
    expect(label(`  ${"x".repeat(81)}  `)).toBe(`${"x".repeat(79)}…`);
    expect(label("a new job")).toBe("a new job");
  });
});
