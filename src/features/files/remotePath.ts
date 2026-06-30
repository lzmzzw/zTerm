// Author: Liz
export function parentRemotePath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized === "/" || normalized === ".") return ".";
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return ".";
  return normalized.slice(0, index);
}

export function joinRemotePath(parent: string, name: string) {
  if (!parent || parent === ".") return name;
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

export function remoteFileName(path: string) {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? "download";
}
