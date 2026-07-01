// Author: Liz
import { ZtDialog } from "../../components/ZtUi";
import type { AppLanguage } from "../settings/settingsStore";
import { FileTransferPanel } from "./FileTransferPanel";

interface FileTransferDialogProps {
  language?: AppLanguage;
  onClose: () => void;
}

export function FileTransferDialog({ language = "zhCN", onClose }: FileTransferDialogProps) {
  return (
    <ZtDialog
      ariaLabel="文件传输"
      title="文件传输"
      size="large"
      className="zt-file-transfer-dialog"
      bodyClassName="zt-file-transfer-dialog-body"
      onClose={onClose}
    >
      <FileTransferPanel language={language} />
    </ZtDialog>
  );
}
