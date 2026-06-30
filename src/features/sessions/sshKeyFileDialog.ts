// Author: Liz
import { open } from "@tauri-apps/plugin-dialog";

export async function selectSshKeyFile() {
  const selected = await open({
    title: "选择 SSH 身份文件",
    multiple: false,
    directory: false,
  });

  if (typeof selected === "string") {
    return selected;
  }
  return null;
}
