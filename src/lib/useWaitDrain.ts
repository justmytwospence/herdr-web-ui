import { useCallback, useLayoutEffect, useRef } from "react";
import { waitDrain } from "./compose.ts";
import type { PendingMessageView } from "./pendingMessages.ts";

export interface WaitDrainOptions {
  waiting: boolean;
  owner: string | null;
  scope: string | null;
  pending: readonly PendingMessageView[];
  owned(id: string): boolean;
  canSend(): boolean;
  send(id: string, autoEligibility: () => boolean): Promise<boolean>;
}

/** Serial, receipt-bound attempts, never a replay of a captured queue or of an uncertain send. */
export function useWaitDrain(options: WaitDrainOptions): void {
  const latest = useRef(options);
  const mounted = useRef(false);
  const busy = useRef(false);
  const episode = useRef({ waiting: false, owner: null as string | null, scope: null as string | null, generation: 0, attempted: new Set<string>() });
  const kick = useCallback((): void => {
    const eligible = (): string | undefined => {
      const now = latest.current;
      if (!mounted.current || !now.waiting || now.owner === null || now.scope === null || !now.canSend()) return;
      return waitDrain(now.pending, (id) => !episode.current.attempted.has(id) && now.owned(id))[0];
    };
    if (busy.current || eligible() === undefined) return;
    busy.current = true;
    const generation = episode.current.generation;
    void (async () => {
      try {
        while (mounted.current && episode.current.generation === generation) {
          const id = eligible();
          if (id === undefined) break;
          const attempted = episode.current.attempted;
          attempted.add(id);
          const owner = episode.current.owner, scope = episode.current.scope;
          const autoEligibility = (): boolean => {
            const now = latest.current, current = episode.current;
            return mounted.current && current.generation === generation && current.waiting && current.owner === owner && current.scope === scope
              && now.waiting && now.owner === owner && now.scope === scope && now.canSend() && now.owned(id);
          };
          try {
            if (!await latest.current.send(id, autoEligibility)) {
              // Release only this request's ledger: StrictMode may retain it after invalidating
              // the generation, while a new waiting episode owns a different set.
              attempted.delete(id);
              break;
            }
          } catch { /* The receipt path owns retention; a rejected attempt is never retried here. */ }
        }
      } finally {
        busy.current = false;
        // An owner/scope switch (or StrictMode cleanup/setup) may have waited on the old receipt.
        // A guard or empty queue returns above without starting another operation or spinning.
        if (mounted.current && episode.current.generation !== generation) kick();
      }
    })();
  }, []);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; episode.current.generation++; };
  }, []);
  useLayoutEffect(() => {
    latest.current = options;
    const previous = episode.current;
    if (previous.waiting !== options.waiting || previous.owner !== options.owner || previous.scope !== options.scope) {
      episode.current = { waiting: options.waiting, owner: options.owner, scope: options.scope, generation: previous.generation + 1, attempted: new Set() };
    }
    kick();
  });
}
