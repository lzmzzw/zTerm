// Author: Liz
import { X } from "lucide-react";
import { ZtSurfaceFrame } from "../../components/ZtUi";
import { ZtSelect } from "../../components/ZtSelect";
import type { AppLanguage } from "../settings/settingsStore";
import { useFileTransferStore } from "./fileTransferStore";
import type { TransferConflictPolicy } from "./fileTypes";
import { FileTransferPanel } from "./FileTransferPanel";

interface FileTransferDialogProps {
  language?: AppLanguage;
  onClose: () => void;
}

export function FileTransferDialog({ language = "zhCN", onClose }: FileTransferDialogProps) {
  const conflictPolicy = useFileTransferStore((state) => state.conflictPolicy);
  const setConflictPolicy = useFileTransferStore((state) => state.setConflictPolicy);

  return (
    <ZtSurfaceFrame className="zt-file-transfer-dialog zt-file-transfer-page" role="region" aria-label="文件传输">
      <header className="zt-settings-page-header">
        <strong className="zt-dialog-title">
          <span className="zt-file-transfer-dialog-title">
            <span className="zt-file-transfer-dialog-heading">文件传输</span>
            <label className="zt-file-transfer-policy">
              <span className="zt-file-transfer-policy-label">冲突策略</span>
              <ZtSelect
                ariaLabel="文件传输冲突策略"
                className="zt-file-transfer-policy-select"
                value={conflictPolicy}
                options={[
                  { value: "overwrite", label: "覆盖" },
                  { value: "skip", label: "跳过" },
                  { value: "rename", label: "自动重命名" },
                ]}
                onChange={(value) => setConflictPolicy(value as TransferConflictPolicy)}
              />
            </label>
          </span>
        </strong>
        <button type="button" aria-label="关闭文件传输" onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </header>
      <div className="zt-file-transfer-dialog-body"><FileTransferPanel language={language} /></div>
    </ZtSurfaceFrame>
  );
}
