// Author: Liz
export function parentRemotePath(path: string) {
  const normalized = normalizeRemotePath(path).replace(/\/+$/, "");
  if (!normalized || normalized === "/") return "/";
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}

export function joinRemotePath(parent: string, name: string) {
  const normalizedParent = normalizeRemotePath(parent);
  const safeName = name.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? name;
  if (normalizedParent === "/") return `/${safeName}`;
  return normalizedParent.endsWith("/") ? `${normalizedParent}${safeName}` : `${normalizedParent}/${safeName}`;
}

export function remoteFileName(path: string) {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? "download";
}

export function normalizeRemotePath(path: string) {
  const normalized = path.trim().replace(/\\/g, "/");
  if (!normalized || normalized === ".") return "/";
  const withRoot = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return withRoot.length > 1 ? withRoot.replace(/\/+$/, "") : "/";
}
