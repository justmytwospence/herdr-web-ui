import type { CommandForm, CommandOutcome, SlashCommand } from "../shared/protocol.ts";
import { skillSyntax } from "../shared/skill-syntax.ts";
import { ANSI_RE, cleanLine, type DialogReader } from "./dialogs/shared.ts";

export interface CommandInvocation {
  readonly name: string;
  readonly argument: string;
  readonly form: CommandForm | null;
}

/** Mutable only for observations retained between polls; sends themselves never change. */
export interface CommandSend {
  readonly id: string;
  readonly text: string;
  readonly at: number;
  readonly agent: string;
  readonly identity: string;
  readonly screen: string;
  readonly form: CommandForm | null;
  readonly invocations: readonly CommandInvocation[];
  /** One-based echo positions after this snapshot's tail, reserved at submission per result reader. */
  resultEchoes?: Readonly<Record<string, number | null>>;
  /** Reserved Chat echoes after this send's anchor; null means ordering information was lost. */
  resultEchoLimit?: Readonly<Record<string, number | null>>;
  outcome?: CommandOutcome;
  dialogId?: string;
  dialogObserved?: true;
  waitingSince?: number;
  settled?: { screen: string; since: number };
}

/** Same syntax and form precedence as the composer, including the catalog's wildcard argument. */
export function commandInvocations(agent: string, text: string, commands: readonly SlashCommand[]): CommandInvocation[] {
  const syntax = skillSyntax(agent);
  const matches: CommandInvocation[] = [];
  const trimmed = text.trim();
  for (const match of trimmed.matchAll(/(?:^|\s)([/$@])([^\s/$@]\S*)/gu)) {
    const trigger = match[1];
    const name = match[2] ?? "";
    const leading = match.index === 0;
    const row = commands.find((row) => {
      if (row.name.toLocaleLowerCase() !== name.toLocaleLowerCase()) return false;
      if (trigger === "@") return agent === "opencode" && row.trigger === "@";
      if (leading) return syntax.skillTriggers.length > 1
        ? trigger === "/" || (trigger === "$" && row.source === "skill")
        : (row.trigger ?? "/") === trigger;
      if (row.source !== "skill" || (trigger !== "/" && trigger !== "$") || !syntax.inline.includes(trigger)) return false;
      if (agent === "codex") return row.trigger === "$";
      if (agent === "claude") return row.trigger === undefined;
      if (agent === "omp") return row.name.startsWith("skill:");
      return true;
    });
    if (!leading && !row) continue;
    if (leading && trigger === "$" && !syntax.skillTriggers.includes("$")) continue;
    if (trigger === "@" && (agent !== "opencode" || !row)) continue;
    if (!row && (!leading || trigger === "@")) continue;
    const argument = trimmed.slice(match.index + match[0].length).trim();
    const forms = row?.forms ?? [];
    const sub = argument.split(/\s+/u)[0]?.toLocaleLowerCase();
    const bare = forms.find((form) => form.match === "bare");
    // #1380 closed unmerged: this bridge has no omp BTW side-store reader.
    const form = row?.visibility === "terminal" || (agent === "omp" && name === "btw") ? { match: "bare" as const, interaction: "terminal" as const }
      : argument === "" ? bare
      : forms.find((form) => typeof form.match === "object" && form.match.sub.toLocaleLowerCase() === sub)
        ?? forms.find((form) => typeof form.match === "object" && form.match.sub === "*")
        ?? forms.find((form) => form.match === "other") ?? bare;
    matches.push({ name, argument, form: form ?? null });
  }
  return matches;
}

export interface OutcomeObservation {
  readonly now: number;
  readonly nextAt?: number;
  readonly screen?: string;
  /** Older sends can still own result blocks, without receiving the newest send's preview. */
  readonly resultScreen?: string;
  readonly transcript?: string;
  readonly readers?: readonly DialogReader[];
  readonly dialog?: { readonly id: string; readonly reader: string };
  readonly waitingSince?: number;
  readonly settledSince?: number;
  /** Already correlated to this send by the caller (card commit or native observer). */
  readonly evidence?: { readonly kind: "dialog" | "native" | "side-store"; readonly at: number; readonly catalogChanged?: true };
}

export const WINDOW_MS = 10 * 60_000;
const normalize = (text: string): string => text.replace(/\s+/gu, " ").trim();
const object = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

/** Native envelopes, not conversational prose or the model/effort shown in a footer. */
function transcriptEvidence(sent: CommandSend, text: string, until: number): number | null {
  let echo = false;
  const invocation = sent.invocations[0];
  for (const line of text.split("\n")) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; } // a torn native tail is not evidence
    const entry = object(parsed);
    const time = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(time) || time <= sent.at || time >= until) continue;
    const message = object(entry.message);
    if (sent.agent === "claude") {
      const local = entry.type === "system" && entry.subtype === "local_command";
      if ((entry.type === "user" && !entry.isMeta) || local) {
        const content = local ? entry.content : message.content;
        if (typeof content !== "string") { echo = false; continue; }
        // Native local commands put name before message; skill echoes put message first.
        const command = /^(?:<command-name>(\/[^<]+)<\/command-name>\s*<command-message>[^<]*<\/command-message>|<command-message>[^<]*<\/command-message>\s*<command-name>(\/[^<]+)<\/command-name>)(?:\s*<command-args>([\s\S]*)<\/command-args>)?$/u.exec(content.trim());
        if (local && echo && /^<local-command-(stdout|stderr)>[\s\S]+<\/local-command-\1>$/u.test(content.trim())) return time;
        echo = command !== null && normalize(`${command[1] ?? command[2]} ${command[3] ?? ""}`) === normalize(sent.text);
        // A native user turn with the exact command text is also explicit transcript evidence.
        if (!local && !command && normalize(content) === normalize(sent.text)) return time;
      }
      continue;
    }
    if (!invocation) continue;
    const name = invocation.name.toLocaleLowerCase();
    const argument = invocation.argument.split(/\s+/u)[0] ?? "";
    if (["pi", "omp", "gjc", "omo"].includes(sent.agent)) {
      if (entry.type === "model_change" && ["model", "models", "switch"].includes(name) && argument) {
        const model = typeof entry.model === "string" ? entry.model : entry.modelId;
        const qualified = typeof entry.provider === "string" ? `${entry.provider}/${model}` : model;
        if (argument === model || argument === qualified || (typeof model === "string" && argument === model.slice(model.indexOf("/") + 1))) return time;
      }
      if (entry.type === "thinking_level_change" && ["thinking", "effort", "efforts"].includes(name) && argument === entry.thinkingLevel) return time;
      if (entry.type === "compaction" && name === "compact") return time;
      // omp's /handoff writes its document as an in-place compaction (method "handoff" on 18.8.7)
      if (sent.agent === "omp" && entry.type === "compaction" && entry.method === "handoff" && name === "handoff") return time;
    }
    if (sent.agent === "codex" && entry.type === "compacted" && name === "compact") return time;
  }
  return null;
}

const screenLines = (screen: string): string[] => screen.replace(ANSI_RE, "").split(/\r?\n/u).map((line) => line.trimEnd());
/** Chrome belongs to the agent, not one command; the first applicable result reader supplies it. */
function withoutChrome(lines: string[], agent: string, readers: readonly DialogReader[]): string[] | null {
  const reader = readers.find((reader) => reader.kind === "result" && reader.chromeStart
    && reader.agents.some((candidate) => candidate === agent || candidate === "*"));
  const start = reader?.chromeStart ? reader.chromeStart(lines) : -1;
  if (!Number.isInteger(start) || start < -1 || start > lines.length) return null;
  if (start === -1) return lines;
  if (lines.slice(start).some((line) => {
    const command = /[/$@]\S.*$/u.exec(cleanLine(line))?.[0];
    return command !== undefined && readers.some((candidate) => candidate.agents.some((name) => name === agent || name === "*")
      && (candidate.echoOf ?? defaultEchoOf)(line, command));
  })) return null;
  return lines.slice(0, start);
}

/** Ignore persistent status clocks when checking whether an expected dialog's output has settled. */
export function dialogSettlingScreen(screen: string, agent: string, readers: readonly DialogReader[]): string {
  const lines = screenLines(screen);
  return (withoutChrome(lines, agent, readers) ?? lines).join("\n");
}

const defaultEchoOf = (line: string, command: string): boolean => {
  const match = /^[❯›>]\s+(.+)$/u.exec(cleanLine(line));
  return match !== null && normalize(match[1] ?? "") === normalize(command);
};

/**
 * Locate the snapshot's nonblank tail, not a count of old result blocks. Require its last three
 * lines (all lines for a shorter snapshot), extending backwards to distinguish repeated tails.
 * Equally good matches are ambiguous: a redraw duplicating the anchor proves nothing.
 */
function anchorEnd(snapshot: readonly string[], lines: readonly string[]): number | null {
  const before = snapshot.filter((line) => line.trim());
  if (before.length === 0) return null;
  const shown = lines.flatMap((line, index) => line.trim() ? [{ line, index }] : []);
  let best = Math.min(3, before.length) - 1;
  let end: number | null = null;
  for (let at = 0; at < shown.length; at++) {
    let matched = 0;
    while (matched < before.length && matched <= at && before[before.length - 1 - matched] === shown[at - matched]?.line) matched++;
    if (matched > best) { best = matched; end = shown[at]?.index ?? null; }
    else if (matched === best) end = null;
  }
  return end;
}

/**
 * Reserve before trimming the pane's send ledger. If the previous same-command send still lacks
 * echoes, those echoes belong to it first, including when the next snapshot has a later tail.
 * A lost previous anchor leaves ownership unknown rather than silently restarting at echo one.
 */
export function reserveResultEchoes(sent: CommandSend, previous: readonly CommandSend[], readers: readonly DialogReader[]): Readonly<Record<string, number | null>> {
  const reservations: Record<string, number | null> = {};
  const prior = [...previous].reverse().find((candidate) => candidate.agent === sent.agent && candidate.identity === sent.identity && normalize(candidate.text) === normalize(sent.text));
  const lines = withoutChrome(screenLines(sent.screen), sent.agent, readers);
  for (const reader of readers) {
    if (reader.kind !== "result") continue;
    if (lines === null) { reservations[reader.id] = null; continue; }
    const echoOf = reader.echoOf ?? defaultEchoOf;
    const priorOrdinal = prior?.resultEchoes?.[reader.id];
    const priorLimit = prior?.resultEchoLimit?.[reader.id];
    if (!prior) { reservations[reader.id] = 1; continue; }
    if (priorOrdinal === null || priorLimit === null) { reservations[reader.id] = null; continue; }
    const before = withoutChrome(screenLines(prior.screen), sent.agent, readers);
    if (before === null) { reservations[reader.id] = null; continue; }
    const anchor = anchorEnd(before, lines);
    if (anchor === null) {
      reservations[reader.id] = prior.outcome?.state === "result-observed" ? 1 : null;
      continue;
    }
    const echoed = lines.slice(anchor + 1).filter((line) => echoOf(line, sent.text)).length;
    reservations[reader.id] = Math.max(0, (priorLimit ?? priorOrdinal ?? 1) - echoed) + 1;
  }
  return reservations;
}

const RESULT_RESERVATION_CAP = 64;
const reservationKey = (sent: CommandSend): string => JSON.stringify([sent.agent, sent.identity, normalize(sent.text)]);

/** Ownership outlives the five displayed outcomes, but never its ten-minute deadline. */
export class CommandReservations {
  private sends: CommandSend[] = [];
  private dropped = new Map<string, number>();
  /** If even the bounded loss markers fill, no new ownership is guessed until they expire. */
  private overflowUntil = 0;

  prune(now: number): void {
    // Settled ordinals remain as bounded bookkeeping too: an in-flight send may have captured
    // its screen before that result was observed and must not reuse the settled echo's position.
    this.sends = this.sends.filter((sent) => sent.at + WINDOW_MS > now);
    for (const [key, until] of this.dropped) if (until <= now) this.dropped.delete(key);
  }

  private ambiguous(sent: CommandSend): void {
    sent.resultEchoLimit = Object.fromEntries(Object.keys(sent.resultEchoes ?? {}).map((id) => [id, null]));
  }

  add(sent: CommandSend, readers: readonly DialogReader[]): void {
    this.prune(sent.at);
    const key = reservationKey(sent);
    sent.resultEchoes = reserveResultEchoes(sent, this.sends, readers);
    sent.resultEchoLimit = { ...sent.resultEchoes };
    // Each earlier same-command anchor now has one more reserved Chat echo after it.
    for (const prior of this.sends) {
      if (reservationKey(prior) !== key) continue;
      prior.resultEchoLimit = Object.fromEntries(Object.entries(prior.resultEchoLimit ?? prior.resultEchoes ?? {})
        .map(([id, count]) => [id, count === null ? null : count + 1]));
    }
    if (this.overflowUntil > sent.at || (this.dropped.get(key) ?? 0) > sent.at) this.ambiguous(sent);
    this.sends.push(sent);
    if (this.sends.length <= RESULT_RESERVATION_CAP) return;
    const dropped = this.sends.shift();
    if (!dropped) return;
    const droppedKey = reservationKey(dropped);
    const until = Math.max(dropped.at + WINDOW_MS, this.dropped.get(droppedKey) ?? 0);
    if (this.dropped.size >= RESULT_RESERVATION_CAP && !this.dropped.has(droppedKey)) {
      this.overflowUntil = Math.max(this.overflowUntil, until, ...this.dropped.values());
      this.dropped.clear();
      for (const pending of this.sends) this.ambiguous(pending);
    } else {
      this.dropped.set(droppedKey, until);
      for (const pending of this.sends) if (reservationKey(pending) === droppedKey) this.ambiguous(pending);
    }
  }
}

function recognizedResult(sent: CommandSend, screen: string, readers: readonly DialogReader[]): { text: string; catalogChanged?: true } | null {
  const fullLines = screenLines(screen);
  const lines = withoutChrome(fullLines, sent.agent, readers);
  const before = withoutChrome(screenLines(sent.screen), sent.agent, readers);
  if (lines === null || before === null) return null;
  const anchor = anchorEnd(before, lines);
  if (anchor === null) return null;
  const context = { agent: sent.agent, omoAsk: null, omoTrusted: false, omoOpen: [], sent: sent.text, working: false };
  for (const reader of readers) {
    if (reader.kind !== "result" || !reader.agents.some((agent) => agent === sent.agent || agent === "*")
      || (sent.form?.dialog && sent.form.dialog !== reader.id)) continue;
    const ordinal = sent.resultEchoes?.[reader.id];
    if (ordinal === null) continue;
    const echoOf = reader.echoOf ?? defaultEchoOf;
    const echoes = lines.flatMap((line, index) => index > anchor && echoOf(line, sent.text) ? [index] : []);
    const reserved = sent.resultEchoLimit?.[reader.id];
    // Position alone cannot distinguish a terminal echo from Chat. Extra echoes invalidate ownership.
    // Accepted limitation: a same-command terminal result before the Chat echo is indistinguishable.
    if (reserved === null || echoes.length > (reserved ?? ordinal ?? 1)) continue;
    const echo = echoes[(ordinal ?? 1) - 1];
    if (echo === undefined) continue;
    // Parse only our own echo's block, never the complete result below a later terminal echo.
    const next = lines.findIndex((line, index) => {
      if (index <= echo) return false;
      const command = /[/$@]\S.*$/u.exec(cleanLine(line))?.[0];
      return command !== undefined && echoOf(line, command);
    });
    // The idle input/status area can prove completion even though it cannot anchor an echo.
    const below = fullLines.slice(echo + 1, next === -1 ? undefined : next + 1).join("\n");
    const parsed = reader.parse(below, context);
    const block = parsed?.resultText?.replace(ANSI_RE, "").replace(/\r\n/gu, "\n");
    if (!block || !below.includes(block) || below.slice(0, below.indexOf(block)).trim()) continue;
    return { text: block, ...(parsed?.catalogChanged ? { catalogChanged: true as const } : {}) };
  }
  return null;
}

/** Pure state calculation. Neither forms, idle, deadlines nor screen deltas prove completion. */
export function commandOutcome(paneId: string, sent: CommandSend, observation: OutcomeObservation): CommandOutcome {
  const now = observation.now;
  const until = Math.min(observation.nextAt ?? Infinity, sent.at + WINDOW_MS);
  const previous = sent.outcome;
  let state: CommandOutcome["state"] = sent.form?.interaction === "terminal" ? "terminal-required" : "accepted";
  let evidence = previous?.evidence ?? [];
  let catalogChanged = previous?.catalog_changed;
  let resultText = previous?.result_text;
  if (previous?.state === "result-observed") state = previous.state;
  else if (state !== "terminal-required") {
    const recorded = transcriptEvidence(sent, observation.transcript ?? "", until);
    const external = observation.evidence;
    const validExternal = external && external.at > sent.at && external.at < until ? external : undefined;
    // Echo ownership, unlike timestamp-only transcript evidence, survives a later Chat send.
    const result = now < sent.at + WINDOW_MS
      ? recognizedResult(sent, observation.resultScreen ?? observation.screen ?? "", observation.readers ?? []) : null;
    if (recorded !== null || validExternal || result) {
      state = "result-observed";
      evidence = [{ kind: recorded !== null ? "transcript" : validExternal?.kind ?? "recognized-result",
        at: new Date(recorded ?? validExternal?.at ?? now).toISOString() }];
      catalogChanged = validExternal?.catalogChanged ?? result?.catalogChanged;
      // what the reader recognized, shown verbatim; bounded like the preview
      resultText = recorded === null && !validExternal ? result?.text.slice(0, 2000) : undefined;
    } else if (sent.form?.interaction === "dialog" && previous?.state === "terminal-required") state = previous.state;
    else if (observation.nextAt !== undefined || now >= until) state = "unknown";
    else if (observation.dialog && (!sent.form?.dialog || sent.form.dialog === observation.dialog.reader)) state = "interaction-required";
    else if (sent.form?.interaction === "dialog" && !sent.dialogObserved && !observation.dialog
      && observation.settledSince !== undefined && observation.settledSince >= sent.at
      && now - observation.settledSince >= 2000) state = "terminal-required";
    else if (observation.waitingSince !== undefined && now - observation.waitingSince >= 2000) state = "terminal-required";
  }
  const preview = observation.screen !== undefined && observation.screen !== sent.screen
    ? observation.screen.replace(ANSI_RE, "").slice(-2000) : undefined;
  const changed = previous?.state !== state || previous.preview !== preview || previous.catalog_changed !== catalogChanged;
  return {
    id: sent.id, pane_id: paneId, text: sent.text, state, evidence,
    ...(preview ? { preview } : {}), ...(resultText ? { result_text: resultText } : {}), ...(catalogChanged ? { catalog_changed: true } : {}),
    created_at: new Date(sent.at).toISOString(), updated_at: changed ? new Date(now).toISOString() : previous.updated_at,
  };
}
