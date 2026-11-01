import type { AgentStatus } from "../../shared/protocol.ts";

/**
 * The herdr pane token that marks a working turn as only waiting: the `OVIS_WAIT_TOKEN` of the
 * PC serving this page, read from /api/health's `web_ui.wait_token` (lib/useLocalHealth.ts) and
 * applied to the panes of every PC, as herdr's copy_on_select is (lib/herdrUi.ts). An agent that
 * keeps its turn open while it only waits on background work sets the token through herdr's pane
 * metadata, with what it waits on as the value, and clears it when the wait ends.
 * Null until the server names one, and on a server that names none.
 */
let name: string | null = null;

/** The server's token name, from its newest confirmed local health answer; null clears it. */
export function setWaitToken(next: string | null | undefined): void {
  name = next?.trim() || null;
}

export function waitToken(): string | null {
  return name;
}

/** The longest value shown: a token is a few words, and the chat's line holds no more. */
const WAIT_VALUE_CHARS = 80;

/**
 * A working pane's wait label, never a replacement for its raw agent status. Changing the label
 * while it stays nonblank does not start a new queue-drain episode.
 */
export function waitingOn(pane: { agent_status?: AgentStatus; tokens?: Record<string, unknown> }, token: string | null = waitToken()): string | null {
  if (token === null || pane.agent_status !== "working") return null;
  const value = pane.tokens?.[token];
  if (typeof value !== "string") return null;
  const what = value.trim();
  if (what.length === 0) return null;
  return what.length > WAIT_VALUE_CHARS ? `${what.slice(0, WAIT_VALUE_CHARS - 1)}…` : what;
}
