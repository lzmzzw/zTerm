// Author: Liz

interface CloseTerminalRuntimesResult {
  failedReason: unknown | null;
  closedRuntimeSessionIds: string[];
}

export async function closeTerminalRuntimes(
  runtimeSessionIds: string[],
  closeTerminal: (runtimeSessionId: string) => Promise<unknown>,
): Promise<CloseTerminalRuntimesResult> {
  const uniqueRuntimeSessionIds = [...new Set(runtimeSessionIds)];
  const closeResults = await Promise.allSettled(
    uniqueRuntimeSessionIds.map((runtimeSessionId) => closeTerminal(runtimeSessionId)),
  );
  const closedRuntimeSessionIds: string[] = [];
  let failedReason: unknown | null = null;
  closeResults.forEach((result, index) => {
    if (result.status === "fulfilled") {
      closedRuntimeSessionIds.push(uniqueRuntimeSessionIds[index]);
    } else if (failedReason === null) {
      failedReason = result.reason;
    }
  });
  return { closedRuntimeSessionIds, failedReason };
}
