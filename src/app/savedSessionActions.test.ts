// Author: Liz
import { describe, expect, it, vi } from "vitest";

import type { SavedSession } from "../features/sessions/types";
import { openSavedSessionTarget } from "./savedSessionActions";

function session(type: SavedSession["type"], overrides: Partial<SavedSession> = {}): SavedSession {
  return {
    id: `${type}-1`, name: type.toUpperCase(), type, group_id: null, host: "files.example.test", port: 22,
    username: "ops", auth_mode: "password", credential_ref: null, description: null, tags: [], sort_order: 0,
    created_at_ms: 1, updated_at_ms: 1, last_used_at_ms: null, ...overrides,
  };
}

describe("openSavedSessionTarget", () => {
  it("opens FTP and SFTP sessions in file transfer with their initial remote paths", async () => {
    const dependencies = {
      openTerminalSession: vi.fn(), prepareFileTransfer: vi.fn(), openFileTransferDialog: vi.fn(),
    };
    await openSavedSessionTarget(session("ftp", { ftp_options: { initial_directory: "/incoming", passive_mode: true, anonymous: false } }), dependencies);
    await openSavedSessionTarget(session("sftp"), dependencies);

    expect(dependencies.prepareFileTransfer).toHaveBeenNthCalledWith(1, "ftp-1", "/incoming");
    expect(dependencies.prepareFileTransfer).toHaveBeenNthCalledWith(2, "sftp-1", "/");
    expect(dependencies.openFileTransferDialog).toHaveBeenCalledTimes(2);
    expect(dependencies.openTerminalSession).not.toHaveBeenCalled();
  });

  it("keeps SSH, local and RDP sessions on the existing terminal action", async () => {
    const dependencies = {
      openTerminalSession: vi.fn(), prepareFileTransfer: vi.fn(), openFileTransferDialog: vi.fn(),
    };
    await openSavedSessionTarget(session("ssh"), dependencies);
    expect(dependencies.openTerminalSession).toHaveBeenCalledWith(expect.objectContaining({ type: "ssh" }));
    expect(dependencies.prepareFileTransfer).not.toHaveBeenCalled();
  });
});
