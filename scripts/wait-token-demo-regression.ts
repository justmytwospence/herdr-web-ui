import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import type { ConversationPart, ConversationTurn, Machine } from "../shared/protocol.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// Real App -> PaneTerminal -> ChatView, over fictional health, roster and transcript answers.
// Each base is its own token-off oracle: this deliberately knows neither main's loading guard
// nor its reserved-footer timer. The release must keep its own placement/visibility, not acquire
// those unrelated fixes in order to pass this test. No live herdr session or backend is opened.
interface Scenario {
  name: string;
  turns: ConversationTurn[];
  status?: "working" | "blocked" | "idle" | "done";
  activity?: "thinking" | "working" | "idle";
  showThinking?: boolean;
  prompt?: boolean;
  loading?: boolean;
  folded?: boolean;
  socket?: "ended" | "disconnected";
  titles: string[];
  footer?: string[];
}
interface DemoControls {
  label: string | null;
  conversationReads: number;
  offline: boolean;
  report(label: string | null): void;
  release(): void;
  push(message: object): void;
  disconnect(): void;
}
declare global { interface Window { waitTokenDemo: DemoControls } }

/** Serialized into the disposable build, after demo-transport and before the app. */
function installWaitTokenDemo(target: string, promptPane: string): void {
  const config = JSON.parse(sessionStorage.getItem("wait-token-demo")!) as Scenario;
  const sources = new Set<{ tell(message: Record<string, unknown>): void }>();
  const sockets: Array<WebSocket & { push(message: object): void }> = [];
  let last: Machine[] = [];
  const held: Array<() => void> = [];
  let hold = config.loading === true;
  const roster = (machines: Machine[]) => machines.map((machine) => {
    const copy = structuredClone(machine);
    for (const list of [copy.snapshot?.panes ?? [], copy.snapshot?.agents ?? []]) for (const entry of list) {
      if (entry.pane_id === target) Object.assign(entry, {
        agent_status: config.status ?? "working", tokens: window.waitTokenDemo.label === null ? {} : { wait: window.waitTokenDemo.label },
      });
    }
    return copy;
  });
  const tellRoster = () => {
    for (const source of sources) source.tell({ type: "machines", machines: roster(last) });
  };
  window.waitTokenDemo = {
    // Starts without a `wait` token on the pane: each base is its own token-off oracle. A roster read
    // is patched too, so it cannot erase the controlled SSE token/status.
    label: null, conversationReads: 0, offline: false,
    report(label) { this.label = label; tellRoster(); },
    release() { hold = false; for (const go of held.splice(0)) go(); },
    push(message) { for (const socket of sockets) if (socket.readyState === 1) socket.push(message); },
    disconnect() { this.offline = true; for (const socket of sockets) socket.close(); },
  };
  const demo = window.fetch;
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname === "/api/pane/conversation" && url.searchParams.get("pane_id") === target) {
      window.waitTokenDemo.conversationReads += 1;
      if (hold) await new Promise<void>((go) => held.push(go));
      const response = await demo(input, init);
      const body = await response.json();
      delete body.activity;
      return Response.json({ ...body, turns: config.turns, history_id: "wait-token-demo", cursor: null,
        ...(config.activity === undefined ? {} : { activity: config.activity }) });
    }
    if (url.pathname === "/api/pane/prompt" && url.searchParams.get("pane_id") === target) {
      return config.prompt ? demo(`/api/pane/prompt?pane_id=${encodeURIComponent(promptPane)}`)
        : Response.json({ prompt: null, outcomes: [] });
    }
    const response = await demo(input, init);
    if (url.pathname === "/api/machines") {
      const body = await response.json();
      return Response.json({ ...body, machines: roster(body.machines) });
    }
    return response;
  };
  const DemoSource = window.EventSource;
  window.EventSource = class extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    inner: EventSource;
    readyState = 1;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor(url: string | URL, options?: EventSourceInit) {
      super(); this.inner = new DemoSource(url, options); sources.add(this);
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") { last = message.machines; message.machines = roster(last); }
        this.tell(message);
      };
      this.inner.onopen = (event) => this.onopen?.(event);
      this.inner.onerror = (event) => this.onerror?.(event);
    }
    tell(message: Record<string, unknown>): void {
      const event = new MessageEvent("message", { data: JSON.stringify(message) });
      this.onmessage?.(event); this.dispatchEvent(event);
    }
    close(): void { this.inner.close(); this.readyState = 2; sources.delete(this); }
  } as unknown as typeof EventSource;
  const DemoSocket = window.WebSocket;
  // Reconnects remain connecting until this page is disposed. They never briefly open and
  // accidentally turn the disconnected frame into a connected one during a comparison.
  class OfflineSocket extends EventTarget {
    readyState = 0;
    send(): void {}
    close(): void { this.readyState = 3; }
  }
  const Watched = function (url: string | URL, protocols?: string | string[]) {
    if (window.waitTokenDemo.offline) return new OfflineSocket();
    const socket = new DemoSocket(url, protocols) as WebSocket & { push(message: object): void };
    sockets.push(socket);
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Watched, name, { value: DemoSocket[name] });
  window.WebSocket = Watched as unknown as typeof WebSocket;
}

const tool = (id: string): ConversationPart => ({ kind: "tool", name: "Bash", summary: `inspect ${id}`, input: JSON.stringify({ command: `echo ${id}` }), output: id, call_id: id, state: "ok" });
const user: ConversationTurn = { role: "user", ts: null, parts: [{ kind: "text", text: "Inspect the fictional shelves." }] };
const turns = (...parts: ConversationPart[]): ConversationTurn[] => [user, { role: "assistant", ts: null, parts }];
const interleaved = [tool("first"), { kind: "text", text: "The first shelf is ready." }, tool("second")] satisfies ConversationPart[];
const answer = { kind: "text", text: "The shelves are ready." } satisfies ConversationPart;
const reasoning = { kind: "thinking", text: "Check the index before continuing." } satisfies ConversationPart;
const scenarios: Scenario[] = [
  { name: "selected-head", turns: turns(...interleaved), titles: ["Worked", "Working…"], footer: [] },
  { name: "folded-head", turns: turns(...interleaved), folded: true, titles: ["Worked", "Working…"], footer: [] },
  { name: "hidden-trailing-reasoning", turns: turns(...interleaved, answer, reasoning), titles: ["Worked", "Working…"], footer: [] },
  { name: "shown-trailing-reasoning", turns: turns(...interleaved, answer, reasoning), showThinking: true, titles: ["Worked", "Worked", "Working…"], footer: [] },
  { name: "empty-head", turns: turns(), titles: ["Working…"], footer: [] },
  { name: "hidden-only-head", turns: turns(reasoning), titles: ["Working…"], footer: [] },
  { name: "answer-only-footer", turns: turns(answer), titles: [], footer: ["Working…"] },
  { name: "pending-footer", turns: [user], titles: [], footer: ["Working…"] },
  { name: "thinking-over-work", turns: turns(tool("thinking")), activity: "thinking", titles: ["Working…"], footer: ["Thinking…"] },
  { name: "thinking-over-answer", turns: turns(answer), activity: "thinking", titles: [], footer: ["Thinking…"] },
  { name: "blocked-precedence", turns: turns(...interleaved), status: "blocked", titles: ["Worked", "Needs you"], footer: [] },
  { name: "settled", turns: turns(...interleaved), status: "done", titles: ["Worked", "Worked"], footer: [] },
  { name: "idle-stale-token", turns: turns(answer), status: "idle", titles: [], footer: [] },
  { name: "ended", turns: turns(answer), socket: "ended", titles: [], footer: [] },
  { name: "disconnected", turns: turns(answer), socket: "disconnected", titles: [], footer: [] },
  { name: "prompt", turns: turns(answer), prompt: true, titles: [], footer: [] },
  // No assertion about whether/when these footers exist: the paired DOM is the base's oracle.
  { name: "finished-answer-reservation", turns: turns({ ...answer, phase: "final_answer" }), titles: [] },
  { name: "loading", turns: turns(...interleaved), loading: true, titles: [] },
];

const root = (page: Page) => page.locator(`.pane-frame[data-layout-pane="${panes.api}"]`);
const painted = (page: Page) => page.clock.runFor(48);
const labels = (page: Page) => root(page).evaluate((pane) => ({
  titles: [...pane.querySelectorAll("[data-chat-row] .work-block-title")].map((node) => node.textContent ?? ""),
  footer: [...pane.querySelectorAll(".chat-activity, .chat-activity-reserved")].filter((node) => node.closest("[data-chat-row]") === null).map((node) => node.textContent ?? ""),
}));

/** All chat nodes, not only the changed label: topology, placement, class, visibility and ARIA.
 * Geometry is checked separately with subpixel tolerance; the label's own inline width may differ.
 */
const snapshot = (page: Page, label: string) => root(page).locator(".chat-frame").evaluate((chat, what) => {
  const normalize = (value: string) => value.split(`Waiting on ${what}…`).join("Working…");
  const tree = (node: Node): unknown => node.nodeType === Node.TEXT_NODE ? normalize(node.textContent ?? "") : node instanceof Element ? {
    tag: node.tagName,
    attrs: [...node.attributes].filter((attr) => attr.name !== "style").map((attr) => [attr.name, normalize(attr.value)]),
    children: [...node.childNodes].map(tree),
  } : null;
  const path = (node: Element): string => node === chat ? "chat" : `${path(node.parentElement!)}/${node.tagName}:${[...node.parentElement!.children].indexOf(node)}`;
  const origin = chat.getBoundingClientRect();
  const nodes = [...chat.querySelectorAll("[data-chat-row], .work-block, .chat-activity, .chat-activity-reserved")];
  return {
    tree: tree(chat), count: chat.querySelectorAll("*").length,
    placement: nodes.map((node) => {
      const style = getComputedStyle(node);
      return { path: path(node), inTurn: node.closest("[data-chat-row]") !== null,
        classes: node.getAttribute("class"), role: node.getAttribute("role"),
        ariaHidden: node.getAttribute("aria-hidden"), expanded: node.querySelector(".work-block-head")?.getAttribute("aria-expanded") ?? null,
        hiddenAncestor: node.closest('[aria-hidden="true"], [hidden]') !== null,
        laidOut: node.getClientRects().length > 0, display: style.display, visibility: style.visibility, opacity: style.opacity };
    }),
    boxes: nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return [box.x - origin.x, box.y - origin.y, box.width, box.height];
    }),
  };
}, label);
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
const sameFrame = (off: Snapshot, on: Snapshot, step: string): void => {
  const { boxes: before, ...offDom } = off, { boxes: after, ...onDom } = on;
  assert.deepEqual(onDom, offDom, `${step}: only waiting labels may change; topology, placement, node count, visibility, classes and accessibility reservation stay the same`);
  assert.equal(after.length, before.length, step);
  for (let i = 0; i < before.length; i++) for (let axis = 0; axis < 4; axis++) {
    assert.ok(Math.abs(after[i]![axis]! - before[i]![axis]!) <= 1, `${step}: node ${i} geometry ${axis} moved: ${before[i]} -> ${after[i]}`);
  }
};
const setLabel = async (page: Page, label: string | null): Promise<void> => {
  await page.evaluate((next) => window.waitTokenDemo.report(next), label);
  await painted(page);
};

/** Starts with no `wait` token on the pane, sets it through the roster, then clears it again.
 * No component harness or direct React props can bypass the propagation under test.
 */
const compare = async (page: Page, scenario: Scenario, stage: string): Promise<void> => {
  const offLabels = await labels(page);
  const off = await snapshot(page, "indexing");
  await setLabel(page, "indexing");
  const onLabels = await labels(page);
  const eligible = (scenario.status ?? "working") === "working";
  const substitute = (value: string) => eligible && value === "Working…" ? "Waiting on indexing…" : value;
  assert.deepEqual(onLabels, { titles: offLabels.titles.map(substitute), footer: offLabels.footer.map(substitute) }, `${stage}: selected live head/footer label and Thinking/Needs you precedence`);
  sameFrame(off, await snapshot(page, "indexing"), `${stage} configured`);

  // A changed nonblank report is the same head/fold, not a second activity node or a new block.
  await setLabel(page, "tests");
  assert.deepEqual(await labels(page), {
    titles: onLabels.titles.map((value) => value.replace("Waiting on indexing…", "Waiting on tests…")),
    footer: onLabels.footer.map((value) => value.replace("Waiting on indexing…", "Waiting on tests…")),
  }, `${stage}: changed SSE token label`);
  sameFrame(off, await snapshot(page, "tests"), `${stage} relabeled`);
  await setLabel(page, null);
  assert.deepEqual(await labels(page), offLabels, `${stage}: a pane without a wait token clears waiting`);
  sameFrame(off, await snapshot(page, "tests"), `${stage} cleared`);
};

const app = mkdtempSync(join(tmpdir(), "ovis-wait-token-demo-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
try {
  await buildDemoApp(app);
  writeFileSync(join(app, "wait-token.js"), `(${installWaitTokenDemo.toString()})(${JSON.stringify(panes.api)}, ${JSON.stringify(panes.web)});`);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./wait-token.js"></script><script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    let file: string;
    try { file = decodeURIComponent(new URL(request.url).pathname.slice(1)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const phone of [false, true]) for (const scenario of scenarios) {
        const context = await browser.newContext(phone
          ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US", reducedMotion: "reduce" }
          : { viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
        try {
          await context.addInitScript((config) => {
            localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", alertsOn: false, showThinking: config.showThinking ?? false }));
            sessionStorage.setItem("wait-token-demo", JSON.stringify(config));
          }, scenario);
          const page = await context.newPage();
          page.setDefaultTimeout(10_000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.clock.install();
          await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes.api)}&view=chat`);
          if (scenario.loading) await root(page).getByText("Loading conversation…", { exact: true }).waitFor();
          else await root(page).locator("[data-chat-row]").first().waitFor();
          await root(page).locator(".composer-status:not([data-offline])").waitFor();
          await page.waitForFunction(() => window.waitTokenDemo.conversationReads > 0);
          if (scenario.prompt) await root(page).locator(".prompt-card").waitFor();
          await page.evaluate(() => document.fonts.ready);
          // Only the fixture clock moves from here. Health/roster work and paint barriers do not
          // consume wall-clock time or accidentally cross one base's activity-reservation timer.
          // Leave a small scheduling lead for the CDP round trip; Date.now() itself can
          // already be in the past by the time Playwright receives pauseAt.
          await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 100);
          await painted(page);
          if (scenario.socket === "ended") {
            await page.evaluate((pane) => window.waitTokenDemo.push({ type: "pty-exit", pane_id: pane }), panes.api);
            await painted(page);
            assert.equal(await root(page).locator(".chat-endcap").textContent(), "terminal ended");
          } else if (scenario.socket === "disconnected") {
            await page.evaluate(() => window.waitTokenDemo.disconnect());
            await painted(page);
            assert.equal(await root(page).locator(".composer-status").getAttribute("data-offline") !== null, true);
          }
          if (scenario.folded) {
            await root(page).locator('[data-chat-row] .work-block.is-live .work-block-head[aria-expanded="true"]').click();
            await painted(page);
            assert.equal(await root(page).locator("[data-chat-row] .work-block.is-live").getAttribute("class"), "work-block is-live is-folded");
          }
          const initial = await labels(page);
          assert.deepEqual(initial.titles, scenario.titles, `${scenario.name}: only the existing selected head is live`);
          if (scenario.footer !== undefined) assert.deepEqual(initial.footer, scenario.footer, `${scenario.name}: upstream activity placement`);
          const label = `${phone ? "phone" : "desktop"} ${scenario.name}`;
          await compare(page, scenario, `${label} initial`);
          if (scenario.name === "finished-answer-reservation") {
            // Advance both configurations on the same base, without asserting a main-only delay,
            // reservation class, aria-hidden value or even the existence of that reservation.
            await page.clock.runFor(1_000);
            await compare(page, scenario, `${label} later`);
          }
          if (scenario.loading) {
            await page.evaluate(() => window.waitTokenDemo.release());
            await painted(page);
            await root(page).locator("[data-chat-row] .work-block.is-live").waitFor();
            assert.deepEqual((await labels(page)).titles, ["Worked", "Working…"]);
            await compare(page, { ...scenario, loading: false }, `${label} loaded`);
          }
          if (evidence) {
            mkdirSync(evidence, { recursive: true });
            await setLabel(page, "indexing");
            await page.screenshot({ path: join(evidence, `wait-token-${phone ? "phone" : "desktop"}-${scenario.name}.png`) });
          }
          assert.deepEqual(errors, [], label);
          console.log(`PASS ${label}: roster/SSE propagation, label-only DOM and accessibility parity, absent/cleared wait token`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
