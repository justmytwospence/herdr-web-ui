import type { AgentStatus } from "../../shared/protocol.ts";

/**
 * The herdr pane token that marks a working turn as only waiting: the `HERDR_WEB_WAIT_TOKEN` of the
 * PC serving this page, read from /api/health's `web_ui.wait_token` (lib/useLocalHealth.ts) and
 * applied to the panes of every PC, as herdr's copy_on_select is (lib/herdrUi.ts). An agent that
 * keeps its turn open while it only waits on background work (a long job) sets the token through
 * herdr's pane metadata, with what it waits on as the value, and clears it when the wait ends;
 * typed input ends the wait as well, so the browser sends to such a pane as to a resting one.
 * Null until the server names one, and on a server that names none: every working pane then
 * queues, as before.
 */
let name: string | null = null;

/** The server's token name, from its newest health answer; null clears it. */
export function setWaitToken(next: string | null | undefined): void {
  name = next?.trim() || null;
}

export function waitToken(): string | null {
  return name;
}

/** The longest value shown: a token is a few words, and the chat's line holds no more. */
const WAIT_VALUE_CHARS = 80;

/**
 * What a working pane's agent only waits on: the wait token's value on the pane, trimmed. Null while
 * the pane is not working (a blocked or resting pane is read as it is), while no token is named, and
 * while the pane's value is missing, not a string or blank.
 */
export function waitingOn(pane: { agent_status?: AgentStatus; tokens?: Record<string, unknown> }, token: string | null = name): string | null {
  if (token === null || pane.agent_status !== "working") return null;
  const value = pane.tokens?.[token];
  if (typeof value !== "string") return null;
  const what = value.trim();
  if (what.length === 0) return null;
  return what.length > WAIT_VALUE_CHARS ? `${what.slice(0, WAIT_VALUE_CHARS - 1)}…` : what;
}
