// Author: Liz
import { afterEach, describe, expect, it, vi } from "vitest";

import { definitionFromDraft } from "./workspacePreviewModel";
import type { WorkspaceDefinitionDraft } from "./types";

function workspaceDraft(overrides: Partial<WorkspaceDefinitionDraft> = {}): WorkspaceDefinitionDraft {
  return {
    id: " workspace-1 ",
    name: "工作区",
    status: "running",
    active_tab_id: "tab-1",
    sort_order: 3,
    tabs: [
      {
        id: "tab-1",
        title: "主终端",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          title: "SSH",
        },
        sort_order: 0,
      },
    ],
    ...overrides,
  };
}

describe("definitionFromDraft", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves source timestamps when materializing a workspace preview draft", () => {
    vi.spyOn(Date, "now").mockReturnValue(999);

    const definition = definitionFromDraft(workspaceDraft(), {
      created_at_ms: 100,
      updated_at_ms: 200,
    });

    expect(definition).toMatchObject({
      id: "workspace-1",
      name: "工作区",
      status: "running",
      active_tab_id: "tab-1",
      sort_order: 3,
      created_at_ms: 100,
      updated_at_ms: 200,
    });
    expect(definition.tabs).toHaveLength(1);
    expect(definition.tabs[0]).toMatchObject({
      id: "tab-1",
      created_at_ms: 100,
      updated_at_ms: 200,
    });
  });

  it("uses a stable fallback id and current timestamp when draft metadata is missing", () => {
    vi.spyOn(Date, "now").mockReturnValue(12345);

    const definition = definitionFromDraft(workspaceDraft({ id: " " }));

    expect(definition.id).toBe("workspace-preview");
    expect(definition.created_at_ms).toBe(12345);
    expect(definition.updated_at_ms).toBe(12345);
    expect(definition.tabs[0].created_at_ms).toBe(12345);
    expect(definition.tabs[0].updated_at_ms).toBe(12345);
  });
});
