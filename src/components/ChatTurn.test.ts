import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
import { ChatRowMemoryContext, type ChatRowMemory } from "../lib/chatRowState.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { Turn } from "./ChatView.tsx";

const text = (value: string): ConversationPart => ({ kind: "text", text: value });
const tool = (command: string): ConversationPart => ({ kind: "tool", name: "Bash", summary: command, input: JSON.stringify({ command }), output: "" });
const reasoning: ConversationPart = { kind: "thinking", text: "Weighing it." };
type ViewOptions = { showThinking?: boolean };
type TurnState = { live: boolean; waiting?: boolean; waitingOn?: string | null };

const render = (parts: ConversationPart[], state: TurnState, role: ConversationTurn["role"] = "assistant", options: ViewOptions = {}): string => {
  const turn: ConversationTurn = { role, ts: "2026-01-01T12:00:00Z", end_ts: "2026-01-01T12:01:00Z", parts };
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(Turn, {
      paneId: "w1:p1", turn, rowKey: "turn:1", live: state.live, waiting: state.waiting ?? false, waitingOn: state.waitingOn ?? null, showThinking: false, ...options,
    }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

const titles = (html: string) => [...html.matchAll(/class="work-block-title">([^<]*)</g)].map((match) => match[1]);
const expanded = (html: string) => [...html.matchAll(/class="work-block-head" aria-expanded="(true|false)"/g)].map((match) => match[1] === "true");

describe("a bash-mode command", () => {
  it("shows the command, then what it printed, and the output of a failed one as an error", () => {
    const html = render([{ kind: "shell", command: "ls missing", stdout: "", stderr: "ls: missing: No such file or directory" }], { live: false }, "user");
    expect(html).toContain('<code>ls missing</code>');
    expect(html).toContain('<pre class="chat-tool-io chat-shell-stderr">ls: missing: No such file or directory</pre>');
    // a command whose output is not recorded yet, or printed nothing, has no empty box
    expect(render([{ kind: "shell", command: "true" }], { live: false }, "user")).not.toContain("<pre");
    expect(render([{ kind: "shell", command: "true", stdout: "", stderr: "" }], { live: false }, "user")).not.toContain("<pre");
  });
});

describe("an agent turn's work blocks", () => {
  it("says Working… for a running turn that has written no work or words yet", () => {
    for (const parts of [[], [text("\n\n")]]) {
      const html = render(parts, { live: true });
      expect(html).toContain("work-block is-live is-pending");
      expect(titles(html)).toEqual(["Working…"]);
      expect(titles(render(parts, { live: false }))).toEqual([]);
    }
  });

  it("draws each run where the agent ran it, with the turn's state and duration on the last", () => {
    const parts = [text("Checking first."), tool("ls"), text("Now the loans."), tool("cat loans"), text("No book is on loan.")];
    const settled = render(parts, { live: false });
    const order = ["Checking first.", "Worked<", "Now the loans.", "Worked for 1m", "No book is on loan."].map((needle) => settled.indexOf(needle));
    expect(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!))).toBe(true);
    expect(titles(settled)).toEqual(["Worked", "Worked for 1m"]);
    expect(expanded(settled)).toEqual([false, false]);
    const live = render(parts, { live: true });
    expect(titles(live)).toEqual(["Worked", "Working…"]);
    expect(expanded(live)).toEqual([false, true]);
    expect(titles(render(parts, { live: true, waiting: true }))).toEqual(["Worked", "Needs you"]);
  });

  it("keeps one block for tools followed by the answer", () => {
    const html = render([tool("ls"), tool("cat a"), text("Done.")], { live: false });
    expect(titles(html)).toEqual(["Worked for 1m"]);
    expect(html.indexOf("Worked for 1m")).toBeLessThan(html.indexOf("Done."));
  });
});

describe("background-wait labels on the existing work head", () => {
  const wait = { live: true, waitingOn: "indexing" };

  it("changes only the selected live title in interleaved prose and tools, never their order or folds", () => {
    const parts = [text("Checking first."), tool("ls"), text("Now the loans."), tool("cat loans"), text("No book is on loan.")];
    const native = render(parts, { live: true });
    const waiting = render(parts, wait);
    expect(titles(waiting)).toEqual(["Worked", "Waiting on indexing…"]);
    expect(expanded(waiting)).toEqual([false, true]);
    expect(waiting.replace("Waiting on indexing…", "Working…")).toBe(native);
    expect(titles(render(parts, { live: true, waitingOn: null }))).toEqual(["Worked", "Working…"]);
    expect(titles(render(parts, { live: false, waitingOn: "indexing" }))).toEqual(["Worked", "Worked for 1m"]);
    expect(titles(render(parts, { ...wait, waiting: true }))).toEqual(["Worked", "Needs you"]);
  });

  it("labels empty, whitespace and hidden-only pending heads without inventing settled or blocked heads", () => {
    for (const parts of [[], [text("\n\n")], [reasoning]]) {
      const html = render(parts, wait);
      expect(titles(html)).toEqual(["Waiting on indexing…"]);
      expect(html).toContain("work-block is-live is-pending");
      expect(html.replace("Waiting on indexing…", "Working…")).toBe(render(parts, { live: true }));
      expect(titles(render(parts, { live: false, waitingOn: "indexing" }))).toEqual([]);
      expect(titles(render(parts, { ...wait, waiting: true }))).toEqual([]);
    }
    // When reasoning is shown it is the normal head, not the empty stand-in.
    expect(titles(render([reasoning], wait, "assistant", { showThinking: true }))).toEqual(["Waiting on indexing…"]);
    expect(titles(render([reasoning], { ...wait, waiting: true }, "assistant", { showThinking: true }))).toEqual(["Needs you"]);
    expect(titles(render([reasoning], { live: false, waitingOn: "indexing" }, "assistant", { showThinking: true }))).toEqual(["Worked for 1m"]);
  });

  it("leaves answer-only turns without a work head, for the existing activity footer to label", () => {
    for (const state of [wait, { ...wait, waiting: true }, { live: false, waitingOn: "indexing" }, { live: true }]) {
      const html = render([text("An answer alone.")], state);
      expect(titles(html)).toEqual([]);
      expect(expanded(html)).toEqual([]);
      expect(html).toContain("An answer alone.");
      expect(html).not.toContain("Waiting on");
    }
  });

  it("does not let hidden trailing reasoning steal the visible head", () => {
    const parts = [tool("ls"), text("The shelf is full."), reasoning];
    const hidden = render(parts, wait);
    expect(titles(hidden)).toEqual(["Waiting on indexing…"]);
    expect(expanded(hidden)).toEqual([true]);
    expect(hidden.indexOf("Waiting on indexing…")).toBeLessThan(hidden.indexOf("The shelf is full."));
    expect(titles(render(parts, { live: true }))).toEqual(["Working…"]);
    expect(titles(render(parts, { live: false, waitingOn: "indexing" }))).toEqual(["Worked for 1m"]);
    expect(titles(render(parts, { ...wait, waiting: true }))).toEqual(["Needs you"]);
    const shown = render(parts, wait, "assistant", { showThinking: true });
    expect(titles(shown)).toEqual(["Worked", "Waiting on indexing…"]);
    expect(expanded(shown)).toEqual([false, true]);
    expect(titles(render(parts, { live: true }, "assistant", { showThinking: true }))).toEqual(["Worked", "Working…"]);
    expect(shown.indexOf("The shelf is full.")).toBeLessThan(shown.indexOf("Waiting on indexing…"));
    expect(titles(render(parts, { live: false, waitingOn: "indexing" }, "assistant", { showThinking: true }))).toEqual(["Worked", "Worked for 1m"]);
    expect(titles(render(parts, { ...wait, waiting: true }, "assistant", { showThinking: true }))).toEqual(["Worked", "Needs you"]);
  });

  it("keeps the release's default folds for background work and a head that needs you", () => {
    const parts = [tool("ls"), text("Still looking."), tool("cat a")];
    const html = render(parts, wait);
    expect(titles(html)).toEqual(["Worked", "Waiting on indexing…"]);
    expect(expanded(html)).toEqual([false, true]);
    expect(html.replace("Waiting on indexing…", "Working…")).toBe(render(parts, { live: true }));
    expect(expanded(render(parts, { ...wait, waiting: true }))).toEqual([false, true]);
  });
});

describe("a run of todo updates, opened", () => {
  // omp's todo: operations in, the whole list as it now stands out
  const LIST = ["Read the fixture", "Patch the parser"];
  const todo = (id: string, ops: unknown[], done: number): ConversationPart => ({
    kind: "tool", name: "todo", summary: "todo", input: JSON.stringify({ ops }), call_id: id,
    output: `Overall: ${done}/${LIST.length} done.\n  Fix:\n${LIST.map((item, index) => `    - [${index < done ? "X" : " "}] ${item}`).join("\n")}`,
  });

  it("shows each update's own input and output, not only the list it left (#1601)", () => {
    const parts = [todo("t1", [{ op: "init", list: [{ phase: "Fix", items: LIST }] }], 0), todo("t2", [{ op: "done", task: LIST[0] }], 1)];
    // the reader opened both updates: the run opens with them
    const memory: ChatRowMemory = { toggles: new Map([["tool:0", true], ["tool:1", true]]), outputs: new Map(), runs: new Map(), dormant: new Map() };
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    let html: string;
    try {
      html = renderToStaticMarkup(createElement(ChatRowMemoryContext.Provider, { value: memory, children: createElement(SettingsProvider, { children: createElement(Turn, {
        paneId: "w1:p1", turn: { role: "assistant", ts: "2026-01-01T12:00:00Z", parts }, rowKey: "turn:1", live: true, waiting: false, showThinking: false,
      }) }) }));
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
    const attempts = html.slice(html.indexOf("work-todo-attempts"));
    expect(html).toContain("work-todo-attempts");
    expect(attempts.match(/aria-expanded="true"/g)?.length).toBe(2);
    for (const [op, done] of [["init", 0], ["done", 1]] as const) {
      expect(attempts).toContain(`&quot;op&quot;: &quot;${op}&quot;`);
      expect(attempts).toContain(`Overall: ${done}/2 done.`);
    }
  });
});

describe("an agent turn's folded work, drawn again", () => {
  const commentary = (value: string): ConversationPart => ({ kind: "text", text: value, phase: "commentary" });
  const answer = (value: string): ConversationPart => ({ kind: "text", text: value, phase: "final_answer" });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let memory: ChatRowMemory;
  let renderer: ReactTestRenderer | undefined;

  const view = (parts: ConversationPart[], options: ViewOptions = {}, state: TurnState = { live: true }) => createElement(ChatRowMemoryContext.Provider, { value: memory, children: createElement(SettingsProvider, { children: createElement(Turn, {
    paneId: "w1:p1", turn: { role: "assistant", ts: "2026-01-01T12:00:00Z", parts }, rowKey: "turn:1", live: state.live, waiting: state.waiting ?? false, waitingOn: state.waitingOn ?? null, showThinking: false, ...options,
  }) }) });
  const draw = async (parts: ConversationPart[], options: ViewOptions = {}, state: TurnState = { live: true }) => {
    await act(async () => { if (renderer) renderer.update(view(parts, options, state)); else renderer = create(view(parts, options, state)); });
  };
  const heads = () => renderer!.root.findAll((node) => node.props.className === "work-block-head");
  const opened = () => heads().map((node) => node.props["aria-expanded"] as boolean);
  const headTitles = () => renderer!.root.findAll((node) => node.props.className === "work-block-title").map((node) => node.children.join(""));
  const toggle = async (index: number) => { await act(async () => { heads()[index]!.props.onClick(); }); };
  // the row scrolled out of the list and back: only its memory is left
  const remount = async (parts: ConversationPart[], options: ViewOptions = {}, state: TurnState = { live: true }) => {
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    await draw(parts, options, state);
  };

  it("keeps the chosen fold and run identity through label changes, clearing, hidden trailing runs and remounts", async () => {
    const parts = [tool("ls"), text("The shelf is full."), reasoning];
    const indexing = { live: true, waitingOn: "indexing" };
    await draw(parts, {}, indexing);
    expect(headTitles()).toEqual(["Waiting on indexing…"]);
    await toggle(0);
    expect(opened()).toEqual([false]);
    const runMemory = [...memory.runs];
    const dormantMemory = [...memory.dormant];
    for (const state of [{ live: true, waitingOn: "tests" }, { live: true, waitingOn: null }, indexing]) {
      await draw(parts, {}, state);
      expect(headTitles()).toEqual([state.waitingOn === null ? "Working…" : `Waiting on ${state.waitingOn}…`]);
      expect(opened()).toEqual([false]);
      expect([...memory.runs]).toEqual(runMemory);
      expect([...memory.dormant]).toEqual(dormantMemory);
      await remount(parts, {}, state);
      expect(headTitles()).toEqual([state.waitingOn === null ? "Working…" : `Waiting on ${state.waitingOn}…`]);
      expect(opened()).toEqual([false]);
      expect([...memory.runs]).toEqual(runMemory);
      expect([...memory.dormant]).toEqual(dormantMemory);
    }
    // Showing the trailing reasoning chooses its existing head; hiding it restores the tools' fold.
    await draw(parts, { showThinking: true }, indexing);
    expect(headTitles()).toEqual(["Worked", "Waiting on indexing…"]);
    expect(opened()).toEqual([false, true]);
    await toggle(1);
    await remount(parts, { showThinking: true }, { live: true, waitingOn: "tests" });
    expect(headTitles()).toEqual(["Worked", "Waiting on tests…"]);
    expect(opened()).toEqual([false, false]);
    await remount(parts, {}, indexing);
    expect(headTitles()).toEqual(["Waiting on indexing…"]);
    expect(opened()).toEqual([false]);
  });

  beforeEach(() => {
    for (const key of ["window", "document", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    descriptors.set("languages", Object.getOwnPropertyDescriptor(navigator, "languages"));
    const listeners = { addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(globalThis, "window", { configurable: true, value: { ...listeners, matchMedia: () => ({ matches: false, ...listeners }) } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { ...listeners, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    memory = { toggles: new Map(), outputs: new Map(), runs: new Map(), dormant: new Map() };
  });

  afterEach(async () => {
    if (renderer) await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      const target = key === "languages" ? navigator : globalThis;
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
  });

  it("keeps a block folded when the words before its tools join it (#2063)", async () => {
    // a later Codex record marks the words commentary; an empty commentary record is filled in
    for (const [before, after] of [[text("Checking."), commentary("Checking.")], [commentary(""), commentary("Checking.")]] as const) {
      memory = { toggles: new Map(), outputs: new Map(), runs: new Map(), dormant: new Map() };
      await draw([before, tool("ls")]);
      await toggle(0);
      expect(opened()).toEqual([false]);
      await draw([after, tool("ls")]);
      expect(opened()).toEqual([false]);
      await remount([after, tool("ls")]);
      expect(opened()).toEqual([false]);
      await act(async () => { renderer!.unmount(); });
      renderer = undefined;
    }
  });

  it("keeps a block folded when it merges with reasoning the chat does not show (#2111)", async () => {
    const reasoning: ConversationPart = { kind: "thinking", text: "Weighing it." };
    // the hidden reasoning is a run of its own that draws no block: one block, the tools'
    await draw([reasoning, text("Checking."), tool("ls")]);
    expect(opened()).toEqual([true]);
    await toggle(0);
    expect(opened()).toEqual([false]);
    // the words become commentary: reasoning, words and tools are one run, still the folded block
    await draw([reasoning, commentary("Checking."), tool("ls")]);
    expect(opened()).toEqual([false]);
    await remount([reasoning, commentary("Checking."), tool("ls")]);
    expect(opened()).toEqual([false]);
    // the words become the answer: the reasoning is a hidden run again, and the tools keep the fold
    await draw([reasoning, answer("Checking."), tool("ls")]);
    expect(opened()).toEqual([false]);
    await remount([reasoning, answer("Checking."), tool("ls")]);
    expect(opened()).toEqual([false]);
  });

  it("keeps a block's fold while its run is hidden reasoning alone, until it draws again", async () => {
    const reasoning: ConversationPart = { kind: "thinking", text: "Weighing it." };
    await draw([commentary("Checking."), reasoning]);
    await toggle(0);
    expect(opened()).toEqual([false]);
    // the words become the answer: what is left of the run draws no block, through every redraw
    // while the reasoning streams
    await draw([answer("Checking."), reasoning]);
    expect(opened()).toEqual([]);
    await draw([answer("Checking."), { ...reasoning, text: "Weighing it again." }]);
    expect(opened()).toEqual([]);
    // a tool joins the reasoning: the block is drawn again, as the reader left it
    await draw([answer("Checking."), { ...reasoning, text: "Weighing it again." }, tool("ls")]);
    expect(opened()).toEqual([false]);
    await remount([answer("Checking."), { ...reasoning, text: "Weighing it again." }, tool("ls")]);
    expect(opened()).toEqual([false]);
  });

  it("keeps a merged block's fold when a part leaves it", async () => {
    await draw([tool("ls"), text("One shelf."), commentary("Checking it.")]);
    expect(opened()).toEqual([false, true]);
    // the reader folds the working run and opens it again
    await toggle(1);
    await toggle(1);
    // the words between become commentary: one run, which the reader folds
    await draw([tool("ls"), commentary("One shelf."), commentary("Checking it.")]);
    expect(opened()).toEqual([true]);
    await toggle(0);
    expect(opened()).toEqual([false]);
    // its last words become the answer and leave it
    await draw([tool("ls"), commentary("One shelf."), answer("Checking it.")]);
    expect(opened()).toEqual([false]);
    await remount([tool("ls"), commentary("One shelf."), answer("Checking it.")]);
    expect(opened()).toEqual([false]);
  });
});
