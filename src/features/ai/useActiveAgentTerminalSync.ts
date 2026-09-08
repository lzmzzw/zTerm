// Author: Liz
import { useEffect, useRef } from "react";

import { setActiveAgentTerminal } from "./agentCodexApi";

type SetActiveTerminal = (runtimeSessionId: string | null) => Promise<void>;

export function useActiveAgentTerminalSync(
  runtimeSessionId: string | null,
  setActiveTerminal: SetActiveTerminal = setActiveAgentTerminal,
) {
  const setActiveTerminalRef = useRef(setActiveTerminal);
  const syncEpochRef = useRef(0);
  const syncChainRef = useRef(Promise.resolve());
  setActiveTerminalRef.current = setActiveTerminal;

  useEffect(() => {
    const epoch = ++syncEpochRef.current;
    syncChainRef.current = syncChainRef.current
      .then(async () => {
        try {
          await setActiveTerminalRef.current(runtimeSessionId);
        } catch {
          if (epoch === syncEpochRef.current) {
            await setActiveTerminalRef.current(null).catch(() => undefined);
          }
        }
      })
      .catch(() => undefined);
  }, [runtimeSessionId]);

  useEffect(
    () => () => {
      ++syncEpochRef.current;
      syncChainRef.current = syncChainRef.current
        .then(() => setActiveTerminalRef.current(null))
        .catch(() => undefined);
    },
    [],
  );
}
