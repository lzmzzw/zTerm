// Author: Liz
import type { SavedSession } from "../features/sessions/types";

interface SavedSessionActionDependencies {
  openTerminalSession: (session: SavedSession) => Promise<void> | void;
  prepareFileTransfer: (savedSessionId: string, remotePath: string) => Promise<void> | void;
  openFileTransferDialog: () => void;
}

export async function openSavedSessionTarget(session: SavedSession, dependencies: SavedSessionActionDependencies) {
  if (session.type === "ftp" || session.type === "sftp") {
    const remotePath = session.type === "ftp" ? session.ftp_options?.initial_directory?.trim() || "/" : "/";
    await dependencies.prepareFileTransfer(session.id, remotePath);
    dependencies.openFileTransferDialog();
    return;
  }
  await dependencies.openTerminalSession(session);
}
