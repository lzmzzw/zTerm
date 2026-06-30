// Author: Liz
export type FileDragDropDecision =
  | { active: boolean; kind: "hover" }
  | { kind: "upload"; paths: string[] }
  | { kind: "clear" }
  | { kind: "ignore" };

type DragDropLike =
  | { type: "enter"; paths?: string[]; position?: { x: number; y: number } }
  | { type: "over"; paths?: string[]; position?: { x: number; y: number } }
  | { type: "drop"; paths?: string[]; position?: { x: number; y: number } }
  | { type: "leave" };

export function resolveFileDragDropEvent(event: DragDropLike, dropZone: HTMLElement | null): FileDragDropDecision {
  if (event.type === "leave") return { kind: "clear" };

  const inside = isInsideDropZone(event.position, dropZone);
  if (event.type === "enter" || event.type === "over") {
    return { active: inside, kind: "hover" };
  }

  if (!inside) return { kind: "ignore" };
  const paths = Array.isArray(event.paths) ? event.paths.filter((path) => path.trim()) : [];
  return paths.length > 0 ? { kind: "upload", paths } : { kind: "ignore" };
}

function isInsideDropZone(position: { x: number; y: number } | undefined, dropZone: HTMLElement | null) {
  if (!position || !dropZone) return false;
  const rect = dropZone.getBoundingClientRect();
  return position.x >= rect.left && position.x <= rect.right && position.y >= rect.top && position.y <= rect.bottom;
}
