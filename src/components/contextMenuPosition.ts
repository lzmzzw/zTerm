export const CONTEXT_MENU_VIEWPORT_GUTTER = 8;

export function resolveContextMenuPosition({
  anchor,
  menu,
  viewport,
}: {
  anchor: { x: number; y: number };
  menu: { width: number; height: number };
  viewport: { width: number; height: number };
}) {
  return {
    left: clampToViewport(anchor.x, menu.width, viewport.width),
    top: clampToViewport(anchor.y, menu.height, viewport.height),
  };
}

function clampToViewport(anchor: number, contentSize: number, viewportSize: number) {
  const minimum = CONTEXT_MENU_VIEWPORT_GUTTER;
  const maximum = Math.max(minimum, viewportSize - contentSize - CONTEXT_MENU_VIEWPORT_GUTTER);
  return Math.min(Math.max(anchor, minimum), maximum);
}
