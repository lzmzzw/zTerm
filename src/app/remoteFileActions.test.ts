// Author: Liz
import { describe, expect, it, vi } from "vitest";

import { createRemoteFileActions } from "./remoteFileActions";

describe("remoteFileActions", () => {
  it("opens the parent directory and refreshes it for the active SSH session", async () => {
    const deps = dependencies({ filePath: "/home/ops/logs" });
    const actions = createRemoteFileActions(deps);

    await actions.openParentDirectory();

    expect(deps.setFilePath).toHaveBeenCalledWith("/home/ops");
    expect(deps.listFiles).toHaveBeenCalledWith("session-1", "/home/ops");
  });

  it("prompts for a new directory path before creating it", async () => {
    const deps = dependencies({
      filePath: "/home/ops",
      textInputResults: ["/home/ops/new-folder"],
    });
    const actions = createRemoteFileActions(deps);

    await actions.createRemoteDirectory();

    expect(deps.requestTextInput).toHaveBeenCalledWith({
      title: "新建文件夹",
      label: "文件夹路径",
      initialValue: "/home/ops/new-folder",
      requiredMessage: "请填写文件夹路径",
    });
    expect(deps.mkdir).toHaveBeenCalledWith("session-1", "/home/ops/new-folder");
  });

  it("prompts for local and remote paths before uploading", async () => {
    const deps = dependencies({
      filePath: "/tmp",
      textInputResults: ["C:\\build\\bundle.zip", "/tmp/bundle.zip"],
    });
    const actions = createRemoteFileActions(deps);

    await actions.uploadPath();

    expect(deps.requestTextInput).toHaveBeenNthCalledWith(1, {
      title: "上传",
      label: "本地上传路径",
      requiredMessage: "请填写本地上传路径",
    });
    expect(deps.requestTextInput).toHaveBeenNthCalledWith(2, {
      title: "上传目标",
      label: "远程目标路径",
      initialValue: "/tmp/bundle.zip",
      requiredMessage: "请填写远程目标路径",
    });
    expect(deps.upload).toHaveBeenCalledWith("session-1", "C:\\build\\bundle.zip", "/tmp/bundle.zip");
  });

  it("does not prompt or mutate when there is no active SSH session", async () => {
    const deps = dependencies({ activeSshSessionId: null });
    const actions = createRemoteFileActions(deps);

    await actions.uploadPath();
    await actions.createRemoteDirectory();
    await actions.downloadRemotePath("/tmp/file.txt");
    await actions.renameRemotePath("/tmp/file.txt");
    await actions.deleteRemotePath("/tmp/file.txt", false);

    expect(deps.requestTextInput).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.renamePath).not.toHaveBeenCalled();
    expect(deps.deletePath).not.toHaveBeenCalled();
  });
});

function dependencies({
  activeSshSessionId = "session-1",
  filePath = ".",
  textInputResults = [],
}: {
  activeSshSessionId?: string | null;
  filePath?: string;
  textInputResults?: Array<string | null>;
} = {}) {
  const pendingInputs = [...textInputResults];
  return {
    activeSshSessionId,
    filePath,
    setFilePath: vi.fn(),
    requestTextInput: vi.fn(async () => pendingInputs.shift() ?? null),
    listFiles: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    upload: vi.fn(async () => undefined),
    download: vi.fn(async () => undefined),
    deletePath: vi.fn(async () => undefined),
    renamePath: vi.fn(async () => undefined),
  };
}
