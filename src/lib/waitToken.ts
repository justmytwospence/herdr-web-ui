import type { AgentStatus } from "../../shared/protocol.ts";

/**
 * The herdr pane token that marks a working turn as only waiting. A tool that keeps an agent's turn
 * open while it only waits on background work sets it with
 * `herdr pane report-metadata <pane_id> --source <id> --token wait=<what>`, with what it waits on as
 * the value, and clears it when the wait ends.
 */
export const WAIT_TOKEN = "wait";

/** The longest value shown: a token is a few words, and the chat's line holds no more. */
const WAIT_VALUE_CHARS = 80;

/**
 * A working pane's wait label, never a replacement for its raw agent status. Changing the label
 * while it stays nonblank does not start a new queue-drain episode.
 */
export function waitingOn(pane: { agent_status?: AgentStatus; tokens?: Record<string, unknown> }): string | null {
  if (pane.agent_status !== "working") return null;
  const value = pane.tokens?.[WAIT_TOKEN];
  if (typeof value !== "string") return null;
  const what = value.trim();
  if (what.length === 0) return null;
  return what.length > WAIT_VALUE_CHARS ? `${what.slice(0, WAIT_VALUE_CHARS - 1)}…` : what;
}
