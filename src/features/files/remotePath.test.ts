// Author: Liz
import { describe, expect, it } from "vitest";

import { joinRemotePath, parentRemotePath, remoteFileName } from "./remotePath";

describe("remote path helpers", () => {
  it("normalizes parent paths without escaping above the remote root", () => {
    expect(parentRemotePath("/home/ops")).toBe("/home");
    expect(parentRemotePath("/home/ops/")).toBe("/home");
    expect(parentRemotePath("/")).toBe(".");
    expect(parentRemotePath(".")).toBe(".");
    expect(parentRemotePath("logs")).toBe(".");
  });

  it("joins remote path segments using forward slashes", () => {
    expect(joinRemotePath(".", "new-folder")).toBe("new-folder");
    expect(joinRemotePath("", "new-folder")).toBe("new-folder");
    expect(joinRemotePath("/home/ops", "deploy.sh")).toBe("/home/ops/deploy.sh");
    expect(joinRemotePath("/home/ops/", "deploy.sh")).toBe("/home/ops/deploy.sh");
  });

  it("extracts file names from remote or local-looking paths", () => {
    expect(remoteFileName("/home/ops/deploy.sh")).toBe("deploy.sh");
    expect(remoteFileName("C:\\temp\\bundle.zip")).toBe("bundle.zip");
    expect(remoteFileName("/")).toBe("download");
  });
});
