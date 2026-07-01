// Author: Liz
import type { AppLanguage } from "../settings/settingsStore";
import { FileTransferPanel } from "./FileTransferPanel";

interface FileTransferDialogProps {
  language?: AppLanguage;
  onClose: () => void;
}

export function FileTransferDialog({ language = "zhCN", onClose }: FileTransferDialogProps) {
  return (
    <div className="zt-session-modal-backdrop">
      <div className="zt-session-dialog zt-file-transfer-dialog" role="dialog" aria-modal="true" aria-label="文件传输">
        <header>
          <strong>文件传输</strong>
          <button type="button" aria-label="关闭文件传输" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="zt-file-transfer-dialog-body">
          <FileTransferPanel language={language} />
        </div>
      </div>
    </div>
  );
}
