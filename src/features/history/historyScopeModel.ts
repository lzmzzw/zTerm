// Author: Liz
import type { HistoryScopeKind } from "./types";

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
  if (input.runtimeScopeKind && input.runtimeScopeId) {
    return { scopeKind: input.runtimeScopeKind, scopeId: input.runtimeScopeId };
  }
  if (input.savedSessionType === "rdp") {
    return { scopeKind: null, scopeId: null };
  }
  if (input.savedSessionId) {
    return { scopeKind: "saved_session", scopeId: input.savedSessionId };
  }
  const profileId = input.savedSessionType === "local"
    ? input.savedSessionLocalProfileId ?? input.defaultLocalProfileId
    : null;
  return profileId
    ? { scopeKind: "local_profile", scopeId: profileId }
    : { scopeKind: null, scopeId: null };
}
