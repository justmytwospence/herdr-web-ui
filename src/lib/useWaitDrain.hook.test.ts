import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createElement, StrictMode, useSyncExternalStore } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useWaitDrain, type WaitDrainOptions } from "./useWaitDrain.ts";
import { pendingMessages, type PendingMessageView } from "./pendingMessages.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { useComposerSends, type ComposerSendsDeps } from "./useComposerSends.ts";
import type { HerdrSocket } from "./ws.ts";

const row = (id: string, extra: Partial<PendingMessageView> = {}): PendingMessageView => ({ id, text: id, state: "queued", serverOwned: true, request_id: 1, created_at: "2026-10-30T00:00:00Z", ...extra });

describe("waiting episode drain", () => {
  let renderer: ReactTestRenderer | undefined;
  let saved: PropertyDescriptor | undefined;
  let options: WaitDrainOptions;
  let sent: string[];
  let receipts: ReturnType<typeof Promise.withResolvers<boolean>>[];
  let guards: (() => boolean)[];
  let strict: boolean;
  function Probe({ label: _label }: { label: string }) { useWaitDrain(options); return null; }
  const tree = (label = "indexing") => strict ? createElement(StrictMode, null, createElement(Probe, { label })) : createElement(Probe, { label });
  const redraw = async (patch: Partial<WaitDrainOptions> = {}, label?: string) => {
    options = { ...options, ...patch };
    await act(async () => { if (renderer) renderer.update(tree(label)); else renderer = create(tree(label)); });
  };
  const settle = async (index: number, reject = false, result = true) => {
    await act(async () => { if (reject) receipts[index]!.reject(new Error("lost receipt")); else receipts[index]!.resolve(result); });
  };
  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    sent = []; receipts = []; guards = []; strict = false;
    options = { waiting: true, owner: "pane", scope: "connection", pending: [row("a"), row("b")], owned: () => true, canSend: () => true,
      send: (id, guard) => { sent.push(id); guards.push(guard); const receipt = Promise.withResolvers<boolean>(); receipts.push(receipt); return receipt.promise; } };
  });
  afterEach(async () => {
    await act(async () => { renderer?.unmount(); }); renderer = undefined;
    if (saved) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", saved);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("drains in order, never starting another row before the prior receipt", async () => {
    await redraw(); expect(sent).toEqual(["a"]);
    await redraw(); expect(sent).toEqual(["a"]);
    await settle(0); expect(sent).toEqual(["a", "b"]);
    await settle(1); await redraw(); expect(sent).toEqual(["a", "b"]);
  });
  for (const key of ["owner", "scope"] as const) it(`stops the old ${key} while its receipt settles and serializes the next episode`, async () => {
    await redraw();
    await redraw({ [key]: "new", pending: [row("new-row")] });
    expect(sent).toEqual(["a"]);
    await settle(0); expect(sent).toEqual(["a", "new-row"]);
    await settle(1);
  });
  it("wait end mid-receipt stops future sends; a later episode gets a new ledger", async () => {
    await redraw(); await redraw({ waiting: false }); await settle(0);
    expect(sent).toEqual(["a"]);
    await redraw({ waiting: true }); expect(sent).toEqual(["a", "a"]);
    await redraw({ waiting: false }); await settle(1);
  });
  it("a visible label change neither duplicates nor resets an attempt", async () => {
    await redraw(); await redraw({}, "building"); expect(sent).toEqual(["a"]);
    await settle(0); await redraw({}, "testing"); expect(sent).toEqual(["a", "b"]);
    await settle(1); await redraw({}, "indexing"); expect(sent).toEqual(["a", "b"]);
  });
  it("guard blocking consumes no row and resumes when cleared, including between receipts", async () => {
    let allowed = false;
    await redraw({ canSend: () => allowed }); expect(sent).toEqual([]);
    allowed = true; await redraw(); expect(sent).toEqual(["a"]);
    allowed = false; await settle(0); expect(sent).toEqual(["a"]);
    allowed = true; await redraw(); expect(sent).toEqual(["a", "b"]);
    await settle(1);
  });
  it("yields after a send returns false, then retries the released row on a committed update", async () => {
    await redraw(); expect(sent).toEqual(["a"]);
    await settle(0, false, false); expect(sent).toEqual(["a"]);
    await redraw(); expect(sent).toEqual(["a", "a"]);
    await settle(1); expect(sent).toEqual(["a", "a", "b"]);
    await settle(2); await redraw(); expect(sent).toEqual(["a", "a", "b"]);
  });
  it("retries a false send only after a blocking guard clears and a render commits", async () => {
    let allowed = true;
    await redraw({ canSend: () => allowed });
    allowed = false; expect(guards[0]!()).toBe(false);
    await settle(0, false, false); expect(sent).toEqual(["a"]);
    await redraw(); expect(sent).toEqual(["a"]);
    allowed = true; await redraw(); expect(sent).toEqual(["a", "a"]);
    await settle(1); await settle(2);
  });
  it("invalidates the old callback across a wait restart with the same owner and scope", async () => {
    await redraw(); expect(guards[0]!()).toBe(true);
    await redraw({ waiting: false }); expect(guards[0]!()).toBe(false);
    await redraw({ waiting: true }); expect(guards[0]!()).toBe(false);
    expect(sent).toEqual(["a"]);
    await settle(0, false, false); expect(sent).toEqual(["a", "a"]);
    expect(guards[1]!()).toBe(true);
    await settle(1); expect(sent).toEqual(["a", "a", "b"]);
    await settle(2); await redraw(); expect(sent).toEqual(["a", "a", "b"]);
  });
  it("a restarted wait rejects the old Web Lock and sends once through the new lock for the same owner and scope", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const pane = "wait-restart-lock", owner = paneStorageId("local", pane), scope = "wait-restart-scope", id = "wait-restart-row";
    const storage = paneLifetimes.paneStorage, data = new Map<string, string>();
    const spies = [
      spyOn(storage, "getItem").mockImplementation((key) => data.get(key) ?? null),
      spyOn(storage, "setItem").mockImplementation((key, value) => { data.set(key, value); }),
      spyOn(storage, "removeItem").mockImplementation((key) => { data.delete(key); }),
    ];
    const locks: { name: string; gate: ReturnType<typeof Promise.withResolvers<void>> }[] = [];
    const calls: Parameters<HerdrSocket["pendingAction"]>[] = [], results: boolean[] = [];
    const socket = { connected: true, on: () => () => {}, pendingAction: (...args: Parameters<HerdrSocket["pendingAction"]>) => {
      calls.push(args); return Promise.resolve({ ok: true });
    } } as unknown as HerdrSocket;
    let waiting = true;
    const deps: ComposerSendsDeps = {
      agent: "pi", agentStatus: "working", waitingOn: "indexing", paneId: pane, paneRef: { current: pane }, machineId: "local", queueOwner: owner,
      socketRef: { current: socket }, sessionRef: { current: null }, pendingScopeRef: { current: scope }, queueStore: null,
      heldRef: { current: false }, secretRef: { current: null }, observeRef: { current: false }, draftHeldForRef: { current: null },
      stillOpenRef: { current: null }, stillOpenNotedRef: { current: false }, chatNavigation: { current: 0 }, setChatLocalSend: () => {},
      ended: false, heldByOpenQueue: false, answering: null, answerPending: false, pendingAnswer: null, settings: { autoSendQueued: false },
      knownOutcomes: () => [], inputRowNow: () => "ready", showSentCommand: () => {}, submitComposerMessage: () => null,
      answerPanePrompt: async () => {}, setPendingAnswer: () => {}, setPromptRefresh: () => {}, stillOpenNote: () => "", submitRetention: null, t: (key) => key,
    };
    function CombinedProbe() {
      const pending = useSyncExternalStore(pendingMessages.subscribe, () => pendingMessages.read(owner));
      const { actOnPending } = useComposerSends(deps);
      useWaitDrain({ waiting, owner, scope, pending, owned: (rowId) => pendingMessages.isOwned(owner, rowId, scope), canSend: () => true,
        send: async (rowId, eligible) => { const result = await actOnPending(rowId, "steer", eligible); results.push(result); return result; } });
      return null;
    }
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: {
      request: (name: string, callback: () => Promise<void>) => {
        const gate = Promise.withResolvers<void>(); locks.push({ name, gate }); return gate.promise.then(callback);
      },
    } } });
    try {
      pendingMessages.accept(owner, row(id), scope);
      const before = structuredClone(pendingMessages.read(owner));
      expect(before).toMatchObject([{ id, state: "queued", serverOwned: true }]);
      await act(async () => { renderer = create(createElement(CombinedProbe)); });
      expect(locks.map((lock) => lock.name)).toEqual([`pending:${owner}:${id}`]);
      expect(calls).toEqual([]);
      waiting = false;
      await act(async () => { renderer!.update(createElement(CombinedProbe)); });
      waiting = true;
      await act(async () => { renderer!.update(createElement(CombinedProbe)); });
      expect(locks).toHaveLength(1);
      expect(calls).toEqual([]);

      await act(async () => { locks[0]!.gate.resolve(); });
      expect(results).toEqual([false]);
      expect(calls).toEqual([]);
      expect(pendingMessages.read(owner)).toEqual(before);
      expect(pendingMessages.isBusy(owner, id)).toBe(false);
      expect(locks.map((lock) => lock.name)).toEqual([`pending:${owner}:${id}`, `pending:${owner}:${id}`]);

      await act(async () => { locks[1]!.gate.resolve(); });
      expect(results).toEqual([false, true]);
      expect(calls).toEqual([[pane, id, "steer", 0, false]]);
      await act(async () => { renderer!.update(createElement(CombinedProbe)); });
      expect(locks).toHaveLength(2);
      expect(calls).toHaveLength(1);
      expect(pendingMessages.read(owner)).toEqual(before);
      expect(pendingMessages.isBusy(owner, id)).toBe(false);
    } finally {
      await act(async () => { renderer?.unmount(); }); renderer = undefined;
      await act(async () => { for (const lock of locks) lock.gate.resolve(); });
      pendingMessages.suspend(owner, scope);
      pendingMessages.removeCopy(owner, id);
      for (const spy of spies) spy.mockRestore();
      if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor); else Reflect.deleteProperty(globalThis, "navigator");
    }
  });
  for (const key of ["owner", "scope"] as const) it(`keeps the new ${key} ledger after an old false settlement`, async () => {
    await redraw({ pending: [row("a")] });
    await redraw({ [key]: "new" }); expect(guards[0]!()).toBe(false);
    await settle(0, false, false); expect(sent).toEqual(["a", "a"]);
    await settle(1); await redraw(); expect(sent).toEqual(["a", "a"]);
  });
  it("the callback reads current send and ownership guards, and becomes false on unmount", async () => {
    let allowed = true, owned = true;
    await redraw({ canSend: () => allowed, owned: () => owned });
    const guard = guards[0]!; expect(guard()).toBe(true);
    allowed = false; expect(guard()).toBe(false);
    allowed = true; owned = false; expect(guard()).toBe(false);
    owned = true; expect(guard()).toBe(true);
    await redraw({ canSend: () => false }); expect(guard()).toBe(false);
    await redraw({ canSend: () => true, owned: () => false }); expect(guard()).toBe(false);
    await redraw({ owned: () => true }); expect(guard()).toBe(true);
    await act(async () => { renderer!.unmount(); }); renderer = undefined;
    expect(guard()).toBe(false);
    await settle(0, false, false); expect(sent).toEqual(["a"]);
  });
  it("an unexpected rejected callback is caught and not retried in this episode", async () => {
    await redraw(); await settle(0, true); expect(sent).toEqual(["a", "b"]);
    await settle(1); await redraw(); expect(sent).toEqual(["a", "b"]);
  });
  it("reads late rows and current ownership after each receipt", async () => {
    await redraw({ pending: [row("a")] });
    await redraw({ pending: [row("a"), row("foreign"), row("late")], owned: (id) => id !== "foreign" });
    await settle(0); expect(sent).toEqual(["a", "late"]);
    await settle(1); await redraw({ pending: [...options.pending, row("later")] });
    expect(sent).toEqual(["a", "late", "later"]); await settle(2);
  });
  it("never sends held, uncertain, sending, copied, foreign or resend-in-flight rows", async () => {
    await redraw({ pending: [row("held", { state: "held" }), row("uncertain", { state: "uncertain" }), row("sending", { state: "sending" }), row("copy", { serverOwned: false }), row("foreign"), row("resend", { resendInFlight: true }), row("own")], owned: (id) => id !== "foreign" });
    expect(sent).toEqual(["own"]); await settle(0); expect(sent).toEqual(["own"]);
  });
  it("unmount leaves the transmitted request alone but sends no next row", async () => {
    await redraw(); await act(async () => { renderer!.unmount(); }); renderer = undefined;
    await settle(0); expect(sent).toEqual(["a"]);
  });
  it("StrictMode setup/cleanup and pending-store rerenders never overlap or duplicate", async () => {
    strict = true; await redraw();
    for (let index = 0; index < 4; index++) await redraw({ pending: [...options.pending] });
    expect(sent).toEqual(["a"]); await settle(0); expect(sent).toEqual(["a", "b"]);
    await settle(1); await redraw(); expect(sent).toEqual(["a", "b"]);
  });
  it("StrictMode retries an unstarted deferred lock before later rows, without replaying begun actions", async () => {
    const delivered: string[] = [], deferred = options.send;
    options.send = async (id, guard) => {
      const began = await deferred(id, guard);
      if (!guard()) return false;
      if (began) delivered.push(id);
      return began;
    };
    strict = true;
    await redraw();
    expect(sent).toEqual(["a"]);
    expect(guards[0]!()).toBe(false);
    await settle(0);
    expect(delivered).toEqual([]);
    expect(sent).toEqual(["a", "a"]);
    expect(guards[1]!()).toBe(true);
    await settle(1);
    expect(delivered).toEqual(["a"]);
    expect(sent).toEqual(["a", "a", "b"]);
    await settle(2);
    await redraw();
    expect(delivered).toEqual(["a", "b"]);
    expect(sent).toEqual(["a", "a", "b"]);
  });
  it("requires both an owner and connection scope", async () => {
    await redraw({ owner: null }); expect(sent).toEqual([]);
    await redraw({ owner: "pane", scope: null }); expect(sent).toEqual([]);
    await redraw({ scope: "connection" }); expect(sent).toEqual(["a"]);
    await redraw({ scope: null }); await settle(0); expect(sent).toEqual(["a"]);
  });
});
