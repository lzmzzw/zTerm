// Author: Liz
import type { HistoryScopeKind } from "./historyStore";

type HistoryScopeSessionType = "ssh" | "local" | "rdp";

interface HistoryScopeResolutionInput {
  runtimeScopeKind: HistoryScopeKind | null | undefined;
  runtimeScopeId: string | null | undefined;
  savedSessionId: string | null | undefined;
  savedSessionType: HistoryScopeSessionType | null | undefined;
  savedSessionLocalProfileId: string | null | undefined;
  defaultLocalProfileId: string | null | undefined;
}

interface HistoryScopeResolution {
  scopeKind: HistoryScopeKind | null;
  scopeId: string | null;
}

export function resolveHistoryScope(input: HistoryScopeResolutionInput): HistoryScopeResolution {
  const localProfileScopeId =
    input.savedSessionType === "local"
      ? input.savedSessionLocalProfileId ?? input.defaultLocalProfileId ?? null
      : null;
  const fallbackScopeKind: HistoryScopeKind | null =
    input.savedSessionType === "rdp"
      ? null
      : input.savedSessionType === "local"
        ? localProfileScopeId
          ? "local_profile"
          : null
        : input.savedSessionId
          ? "saved_session"
          : null;
  const fallbackScopeId: string | null =
    input.savedSessionType === "rdp"
      ? null
      : input.savedSessionType === "local"
        ? localProfileScopeId
        : input.savedSessionId ?? null;

  return {
    scopeKind: input.runtimeScopeKind ?? fallbackScopeKind,
    scopeId: input.runtimeScopeId ?? fallbackScopeId,
  };
}
