// Author: Liz
import { ZtDialog } from "../../components/ZtUi";
import { ZtSelect } from "../../components/ZtSelect";
import type { AppLanguage } from "../settings/settingsStore";
import { useFileTransferStore } from "./fileTransferStore";
import type { TransferConflictPolicy } from "./fileStore";
import { FileTransferPanel } from "./FileTransferPanel";

interface FileTransferDialogProps {
  language?: AppLanguage;
  onClose: () => void;
}

export function FileTransferDialog({ language = "zhCN", onClose }: FileTransferDialogProps) {
  const conflictPolicy = useFileTransferStore((state) => state.conflictPolicy);
  const setConflictPolicy = useFileTransferStore((state) => state.setConflictPolicy);

  return (
    <ZtDialog
      ariaLabel="文件传输"
      title={
        <span className="zt-file-transfer-dialog-title">
          <span>文件传输</span>
          <label>
            <span>冲突策略</span>
            <ZtSelect
              ariaLabel="文件传输冲突策略"
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
      }
      size="large"
      className="zt-file-transfer-dialog"
      bodyClassName="zt-file-transfer-dialog-body"
      onClose={onClose}
    >
      <FileTransferPanel language={language} />
    </ZtDialog>
  );
}
