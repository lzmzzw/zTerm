export type DesktopPlatform = "macos" | "windows" | "linux" | "unknown";

export function currentDesktopPlatform(navigatorLike: Pick<Navigator, "platform" | "userAgent"> = navigator): DesktopPlatform {
  const value = `${navigatorLike.platform} ${navigatorLike.userAgent}`.toLowerCase();
  if (value.includes("mac")) return "macos";
  if (value.includes("win")) return "windows";
  if (value.includes("linux")) return "linux";
  return "unknown";
}

export function isMacOS(): boolean {
  return currentDesktopPlatform() === "macos";
}

export function displayAccelerator(accelerator: string, macOS = isMacOS()): string {
  if (!macOS) return accelerator;
  return accelerator
    .split("+")
    .map((part) => {
      const value = part.trim().toLowerCase();
      if (value === "meta" || value === "cmd" || value === "command") return "⌘";
      if (value === "alt" || value === "option") return "⌥";
      if (value === "shift") return "⇧";
      if (value === "ctrl" || value === "control") return "⌃";
      return part.trim().toUpperCase();
    })
    .join("");
}
