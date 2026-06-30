// Author: Liz
import { joinRemotePath, parentRemotePath, remoteFileName } from "../features/files/remotePath";

interface TextInputOptions {
  title: string;
  label: string;
  initialValue?: string;
  requiredMessage: string;
  confirmLabel?: string;
}

interface RemoteFileActionDependencies {
  activeSshSessionId: string | null;
  filePath: string;
  setFilePath: (path: string) => void;
  requestTextInput: (options: TextInputOptions) => Promise<string | null>;
  listFiles: (savedSessionId: string, path: string) => Promise<unknown> | unknown;
  mkdir: (savedSessionId: string, path: string) => Promise<unknown> | unknown;
  upload: (savedSessionId: string, localPath: string, remotePath: string) => Promise<unknown> | unknown;
  download: (savedSessionId: string, remotePath: string, localPath: string) => Promise<unknown> | unknown;
  deletePath: (savedSessionId: string, path: string, recursive: boolean) => Promise<unknown> | unknown;
  renamePath: (savedSessionId: string, from: string, to: string) => Promise<unknown> | unknown;
}

export function createRemoteFileActions({
  activeSshSessionId,
  filePath,
  setFilePath,
  requestTextInput,
  listFiles,
  mkdir,
  upload,
  download,
  deletePath,
  renamePath,
}: RemoteFileActionDependencies) {
  async function refreshFiles(path = filePath) {
    if (activeSshSessionId) {
      await listFiles(activeSshSessionId, path);
    }
  }

  async function openDirectory(path: string) {
    setFilePath(path);
    await refreshFiles(path);
  }

  async function openParentDirectory() {
    await openDirectory(parentRemotePath(filePath));
  }

  async function createRemoteDirectory() {
    if (!activeSshSessionId) return;
    const path = await requestTextInput({
      title: "新建文件夹",
      label: "文件夹路径",
      initialValue: joinRemotePath(filePath, "new-folder"),
      requiredMessage: "请填写文件夹路径",
    });
    if (!path) return;
    await mkdir(activeSshSessionId, path);
  }

  async function uploadPath() {
    if (!activeSshSessionId) return;
    const localPath = await requestTextInput({
      title: "上传",
      label: "本地上传路径",
      requiredMessage: "请填写本地上传路径",
    });
    if (!localPath) return;
    const remotePath = await requestTextInput({
      title: "上传目标",
      label: "远程目标路径",
      initialValue: joinRemotePath(filePath, remoteFileName(localPath)),
      requiredMessage: "请填写远程目标路径",
    });
    if (!remotePath) return;
    await upload(activeSshSessionId, localPath, remotePath);
  }

  async function downloadRemotePath(remotePath: string) {
    if (!activeSshSessionId) return;
    const localPath = await requestTextInput({
      title: "下载",
      label: "本地保存路径",
      initialValue: remoteFileName(remotePath),
      requiredMessage: "请填写本地保存路径",
    });
    if (!localPath) return;
    await download(activeSshSessionId, remotePath, localPath);
  }

  async function renameRemotePath(from: string) {
    if (!activeSshSessionId) return;
    const to = await requestTextInput({
      title: "重命名",
      label: "重命名为",
      initialValue: from,
      requiredMessage: "请填写新路径",
    });
    if (!to || to === from) return;
    await renamePath(activeSshSessionId, from, to);
  }

  async function deleteRemotePath(path: string, recursive: boolean) {
    if (!activeSshSessionId) return;
    await deletePath(activeSshSessionId, path, recursive);
  }

  return {
    refreshFiles,
    openDirectory,
    openParentDirectory,
    createRemoteDirectory,
    uploadPath,
    downloadRemotePath,
    renameRemotePath,
    deleteRemotePath,
  };
}
