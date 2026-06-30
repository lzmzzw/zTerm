// Author: Liz
import { describe, expect, it } from "vitest";

import { resolveHistoryScope } from "./historyScopeModel";

describe("resolveHistoryScope", () => {
  it("prefers runtime-provided history scope over session fallback", () => {
    expect(
      resolveHistoryScope({
        runtimeScopeKind: "local_profile",
        runtimeScopeId: "pwsh",
        savedSessionId: "session-1",
        savedSessionType: "ssh",
        savedSessionLocalProfileId: null,
        defaultLocalProfileId: null,
      }),
    ).toEqual({ scopeKind: "local_profile", scopeId: "pwsh" });
  });

  it("falls back to saved session scope for SSH sessions", () => {
    expect(
      resolveHistoryScope({
        runtimeScopeKind: null,
        runtimeScopeId: null,
        savedSessionId: "session-ssh",
        savedSessionType: "ssh",
        savedSessionLocalProfileId: null,
        defaultLocalProfileId: "pwsh",
      }),
    ).toEqual({ scopeKind: "saved_session", scopeId: "session-ssh" });
  });

  it("uses a local session profile before the default local profile", () => {
    expect(
      resolveHistoryScope({
        runtimeScopeKind: null,
        runtimeScopeId: null,
        savedSessionId: "session-local",
        savedSessionType: "local",
        savedSessionLocalProfileId: "custom-local",
        defaultLocalProfileId: "default-local",
      }),
    ).toEqual({ scopeKind: "local_profile", scopeId: "custom-local" });
  });

  it("uses the default local profile when a local session has no profile", () => {
    expect(
      resolveHistoryScope({
        runtimeScopeKind: null,
        runtimeScopeId: null,
        savedSessionId: "session-local",
        savedSessionType: "local",
        savedSessionLocalProfileId: null,
        defaultLocalProfileId: "default-local",
      }),
    ).toEqual({ scopeKind: "local_profile", scopeId: "default-local" });
  });

  it("keeps RDP and empty sessions out of history scope", () => {
    expect(
      resolveHistoryScope({
        runtimeScopeKind: null,
        runtimeScopeId: null,
        savedSessionId: "rdp-session",
        savedSessionType: "rdp",
        savedSessionLocalProfileId: null,
        defaultLocalProfileId: "default-local",
      }),
    ).toEqual({ scopeKind: null, scopeId: null });
    expect(
      resolveHistoryScope({
        runtimeScopeKind: null,
        runtimeScopeId: null,
        savedSessionId: null,
        savedSessionType: null,
        savedSessionLocalProfileId: null,
        defaultLocalProfileId: null,
      }),
    ).toEqual({ scopeKind: null, scopeId: null });
  });
});
