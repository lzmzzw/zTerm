// Author: Liz
import { ChevronDown, ChevronRight, Pause, Play, RotateCcw, Trash2, XCircle } from "lucide-react";
import { type MouseEvent, useEffect, useRef, useState } from "react";

import { ZtConfirmDialog, ZtInlineError } from "../../components/ZtUi";
import { unknownErrorMessage } from "../../lib/unknownErrorMessage";
import type { TransferStatus, TransferTask } from "./fileTypes";
import { legacyTransferDestinationPath, legacyTransferSourcePath } from "./fileTransferPaths";
import { groupTransferTasks } from "./transferTaskGroups";

interface TransferPanelProps {
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  tasks: TransferTask[];
  onCancel: (taskId: string) => Promise<void> | void;
  onDelete: (taskId: string) => Promise<void> | void;
  onPause: (taskId: string) => Promise<void> | void;
  onRetry: (taskId: string) => Promise<void> | void;
  onResume: (taskId: string) => Promise<void> | void;
  onClearAll?: () => Promise<void> | void;
  onPauseAll?: (taskIds: string[]) => Promise<void> | void;
  onResumeAll?: (taskIds: string[]) => Promise<void> | void;
  onCollapsedChange?: (collapsed: boolean) => void;
  onResize?: (height: number) => void;
}

const activeTransferStatuses = new Set<TransferTask["status"]>(["queued", "running", "paused"]);
const pausableTransferStatuses = new Set<TransferStatus>(["queued", "running"]);
const transferStatusLabels: Record<TransferStatus, string> = {
  queued: "等待中", running: "传输中", paused: "已暂停",
  done: "已完成", failed: "失败", cancelled: "已取消",
};
const taskFilters = [["all", "全部"], ["current", "当前任务"], ["history", "历史任务"]] as const;

export function TransferPanel({
  collapsible = false,
  defaultCollapsed = false,
  tasks,
  onCancel,
  onDelete,
  onPause,
  onRetry,
  onResume,
  onClearAll,
  onPauseAll,
  onResumeAll,
  onCollapsedChange,
  onResize,
}: TransferPanelProps) {
  const activeCount = tasks.filter((task) => activeTransferStatuses.has(task.status)).length;
  const pausableTaskIds = tasks.filter((task) => pausableTransferStatuses.has(task.status)).map((task) => task.id);
  const resumableTaskIds = tasks.filter((task) => task.status === "paused").map((task) => task.id);
  const allTaskIds = tasks.map((task) => task.id);
  const hasBulkActions = Boolean(onPauseAll || onResumeAll || onClearAll);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [drawerHeight, setDrawerHeight] = useState<number | null>(null);
  const [taskFilter, setTaskFilter] = useState<"all" | "current" | "history">("all");
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(() => new Set());
  const dockRef = useRef<HTMLElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanupRef.current?.(), []);
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);
  const [busyTaskIds, setBusyTaskIds] = useState<Set<string>>(() => new Set());
  const busyTaskIdsRef = useRef<Set<string>>(new Set());
  const bulkActionRef = useRef<string | null>(null);
  const [bulkAction, setBulkAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function runTaskAction(label: string, taskId: string, action: (taskId: string) => Promise<void> | void) {
    if (busyTaskIdsRef.current.has(taskId)) return;
    setActionError(null);
    busyTaskIdsRef.current.add(taskId);
    setBusyTaskIds(new Set(busyTaskIdsRef.current));
    try {
      await action(taskId);
    } catch (error) {
      setActionError(`${label}失败：${unknownErrorMessage(error, "传输任务操作失败")}`);
    } finally {
      busyTaskIdsRef.current.delete(taskId);
      setBusyTaskIds(new Set(busyTaskIdsRef.current));
    }
  }

  async function runBulkAction(
    label: string,
    taskIds: string[],
    action: (taskIds: string[]) => Promise<void> | void,
  ) {
    if (!taskIds.length || bulkActionRef.current || taskIds.some((taskId) => busyTaskIdsRef.current.has(taskId))) return;
    setActionError(null);
    bulkActionRef.current = label;
    setBulkAction(label);
    taskIds.forEach((taskId) => busyTaskIdsRef.current.add(taskId));
    setBusyTaskIds(new Set(busyTaskIdsRef.current));
    try {
      await action(taskIds);
    } catch (error) {
      setActionError(`${label}失败：${unknownErrorMessage(error, "传输任务批量操作失败")}`);
    } finally {
      taskIds.forEach((taskId) => busyTaskIdsRef.current.delete(taskId));
      setBusyTaskIds(new Set(busyTaskIdsRef.current));
      bulkActionRef.current = null;
      setBulkAction(null);
    }
  }

  const requestDelete = (task: TransferTask) => {
    if (!activeTransferStatuses.has(task.status)) {
      void runTaskAction("删除", task.id, onDelete);
      return;
    }
    setPendingConfirm({
      title: "删除传输任务",
      message: "删除运行中传输会先取消该任务，确认删除？",
      confirmLabel: "确认删除",
      onConfirm: () => void runTaskAction("删除", task.id, onDelete),
    });
  };

  const list = renderTransferList(
    tasks.filter((task) => taskFilter === "all" || (taskFilter === "current" ? activeTransferStatuses.has(task.status) : !activeTransferStatuses.has(task.status))),
    collapsedGroupIds,
    (groupId) =>
      setCollapsedGroupIds((current) => {
        const next = new Set(current);
        if (next.has(groupId)) next.delete(groupId);
        else next.add(groupId);
        return next;
      }),
    onRetry,
    onPause,
    onResume,
    onCancel,
    requestDelete,
    busyTaskIds,
    runTaskAction,
  );

  useEffect(() => {
    onCollapsedChange?.(collapsed);
  }, [collapsed, onCollapsedChange]);

  function toggleCollapsed() {
    setCollapsed((current) => !current);
  }

  function resizeFromMouse(event: MouseEvent<HTMLButtonElement>) {
    if (collapsed) return;
    resizeCleanupRef.current?.();
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = dockRef.current?.getBoundingClientRect().height || 200;
    const onMouseMove = (moveEvent: globalThis.MouseEvent) => {
      resizeDrawer(startHeight + startY - moveEvent.clientY);
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = onMouseUp;
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp, { once: true });
  }

  function resizeDrawer(height: number) {
    const next = Math.max(160, Math.min(600, height));
    if (onResize) onResize(next);
    else setDrawerHeight(next);
  }

  const confirmDialog = pendingConfirm ? (
    <ZtConfirmDialog
      title={pendingConfirm.title}
      message={pendingConfirm.message}
      confirmLabel={pendingConfirm.confirmLabel}
      danger
      onCancel={() => setPendingConfirm(null)}
      onConfirm={() => {
        const action = pendingConfirm.onConfirm;
        setPendingConfirm(null);
        action();
      }}
    />
  ) : null;

  if (collapsible) {
    return (
      <section
        ref={dockRef}
        className={collapsed ? "zt-transfer-dock zt-transfer-dock-collapsed" : "zt-transfer-dock"}
        style={!collapsed && !onResize && drawerHeight !== null ? { flexBasis: drawerHeight } : undefined}
        aria-label="传输任务"
      >
        {collapsed ? null : (
          <button
            type="button"
            className="zt-transfer-dock-resizer"
            role="separator"
            aria-label="调整传输任务高度"
            aria-orientation="horizontal"
            tabIndex={0}
            onMouseDown={resizeFromMouse}
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              const currentHeight = dockRef.current?.getBoundingClientRect().height || 200;
              resizeDrawer(currentHeight + (event.key === "ArrowUp" ? 24 : -24));
            }}
          />
        )}
        <div className="zt-transfer-dock-header">
          <button
            type="button"
            className="zt-transfer-dock-toggle"
            aria-label={collapsed ? "展开传输任务" : "折叠传输任务"}
            aria-expanded={!collapsed}
            title={collapsed ? "展开传输任务" : "折叠传输任务"}
            onClick={toggleCollapsed}
          >
            <strong className="zt-transfer-dock-title">传输任务</strong>
            <span className="zt-transfer-dock-count">{activeCount > 0 ? `${activeCount} 个进行中` : `${tasks.length} 个任务`}</span>
            {collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          </button>
          {hasBulkActions ? (
            <div className="zt-transfer-dock-actions" aria-label="传输任务批量操作">
              {onPauseAll ? (
                <button
                  type="button"
                  aria-label="暂停全部传输任务"
                  title="暂停全部"
                  disabled={bulkAction !== null || pausableTaskIds.length === 0 || pausableTaskIds.some((taskId) => busyTaskIds.has(taskId))}
                  onClick={() => void runBulkAction("批量暂停", pausableTaskIds, onPauseAll)}
                >
                  <Pause size={14} aria-hidden="true" />
                </button>
              ) : null}
              {onResumeAll ? (
                <button
                  type="button"
                  aria-label="恢复全部传输任务"
                  title="恢复全部"
                  disabled={bulkAction !== null || resumableTaskIds.length === 0 || resumableTaskIds.some((taskId) => busyTaskIds.has(taskId))}
                  onClick={() => void runBulkAction("批量恢复", resumableTaskIds, onResumeAll)}
                >
                  <Play size={14} aria-hidden="true" />
                </button>
              ) : null}
              {onClearAll ? (
                <button
                  type="button"
                  aria-label="清理全部传输任务"
                  title="清理全部"
                  disabled={bulkAction !== null || allTaskIds.length === 0 || allTaskIds.some((taskId) => busyTaskIds.has(taskId))}
                  onClick={() =>
                    setPendingConfirm({
                      title: "清理传输任务",
                      message: "清理全部任务会取消进行中的传输并删除任务记录，确认清理？",
                      confirmLabel: "确认清理",
                      onConfirm: () => void runBulkAction("批量清理", allTaskIds, () => onClearAll()),
                    })
                  }
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {actionError ? <ZtInlineError>{actionError}</ZtInlineError> : null}
        {collapsed ? null : (
          <>
            <div className="zt-transfer-filter" aria-label="传输记录筛选">
              {taskFilters.map(([value, label]) => (
                <button key={value} type="button" aria-pressed={taskFilter === value} onClick={() => setTaskFilter(value)}>
                  {label}
                </button>
              ))}
            </div>
            {list}
          </>
        )}
        {confirmDialog}
      </section>
    );
  }

  return (
    <>
      {actionError ? <ZtInlineError>{actionError}</ZtInlineError> : null}
      {list}
      {confirmDialog}
    </>
  );
}

function renderTransferList(
  tasks: TransferTask[],
  collapsedGroupIds: ReadonlySet<string>,
  onToggleGroup: (groupId: string) => void,
  onRetry: TransferPanelProps["onRetry"],
  onPause: TransferPanelProps["onPause"],
  onResume: TransferPanelProps["onResume"],
  onCancel: TransferPanelProps["onCancel"],
  onDelete: (task: TransferTask) => void,
  busyTaskIds: ReadonlySet<string>,
  onTaskAction: (label: string, taskId: string, action: (taskId: string) => Promise<void> | void) => Promise<void>,
) {
  if (tasks.length === 0) {
    return <div className="zt-empty-line">暂无传输任务</div>;
  }

  return (
    <div className="zt-transfer-list" aria-label="传输任务列表">
      {groupTransferTasks(tasks).map((group) => {
        if (!group.id) return renderTransferRow(group.tasks[0], false, onRetry, onPause, onResume, onCancel, onDelete, busyTaskIds, onTaskAction);
        const collapsed = collapsedGroupIds.has(group.id);
        const totalBytes = group.tasks.reduce((total, task) => total + task.total_bytes, 0);
        const transferredBytes = group.tasks.reduce((total, task) => total + task.transferred_bytes, 0);
        const percent = totalBytes > 0 ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : null;
        const status = aggregateGroupStatus(group.tasks);
        return (
          <section className="zt-transfer-group" key={group.id} aria-label={`任务组 ${group.name}`}>
            <button
              type="button"
              className="zt-transfer-group-header"
              aria-label={`${collapsed ? "展开" : "折叠"}任务组 ${group.name}`}
              aria-expanded={!collapsed}
              onClick={() => onToggleGroup(group.id as string)}
            >
              {collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
              <strong>{group.name}</strong>
              <span>{group.tasks.length} 个子任务</span>
              <span className="zt-transfer-progress" aria-label={`${group.id} 聚合进度`}>
                <span style={{ width: `${percent ?? 0}%` }} />
              </span>
              <small>{percent === null ? `${transferredBytes} B` : `${percent}%`}</small>
              <span className={`zt-transfer-status ${status}`}>{transferStatusLabels[status]}</span>
            </button>
            {collapsed ? null : (
              <div className="zt-transfer-group-children">
                {group.tasks.map((task) => renderTransferRow(task, true, onRetry, onPause, onResume, onCancel, onDelete, busyTaskIds, onTaskAction))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function renderTransferRow(
  task: TransferTask,
  child: boolean,
  onRetry: TransferPanelProps["onRetry"],
  onPause: TransferPanelProps["onPause"],
  onResume: TransferPanelProps["onResume"],
  onCancel: TransferPanelProps["onCancel"],
  onDelete: (task: TransferTask) => void,
  busyTaskIds: ReadonlySet<string>,
  onTaskAction: (label: string, taskId: string, action: (taskId: string) => Promise<void> | void) => Promise<void>,
) {
  const percent = task.total_bytes > 0 ? Math.min(100, Math.round((task.transferred_bytes / task.total_bytes) * 100)) : null;
  const sourcePath = task.source_endpoint?.path ?? legacyTransferSourcePath(task);
  const destinationPath = task.destination_endpoint?.path ?? legacyTransferDestinationPath(task);
  const busy = busyTaskIds.has(task.id);
  return (
    <div className={child ? "zt-transfer-row zt-transfer-child-row" : "zt-transfer-row"} key={task.id}>
      <div className="zt-transfer-main">
        <strong title={sourcePath}>{sourcePath.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || sourcePath}</strong>
        <span title={`${sourcePath} → ${destinationPath}`}>{sourcePath} → {destinationPath}</span>
      </div>
      <div className="zt-transfer-progress" aria-label={`${task.id} 进度`}>
        <span style={{ width: `${percent ?? 0}%` }} />
      </div>
      <small>{percent === null ? `${task.transferred_bytes} B` : `${percent}%`}</small>
      <span className={`zt-transfer-status ${task.status}`}>{transferStatusLabels[task.status]}</span>
      <div className="zt-transfer-actions">
        {task.status === "queued" || task.status === "running" ? (
          <button type="button" aria-label={`暂停 ${task.id}`} title="暂停" disabled={busy} onClick={() => void onTaskAction("暂停", task.id, onPause)}>
            <Pause size={14} aria-hidden="true" />
          </button>
        ) : null}
        {task.status === "paused" ? (
          <button type="button" aria-label={`恢复 ${task.id}`} title="恢复" disabled={busy} onClick={() => void onTaskAction("恢复", task.id, onResume)}>
            <Play size={14} aria-hidden="true" />
          </button>
        ) : null}
        {activeTransferStatuses.has(task.status) ? (
          <button type="button" aria-label={`取消 ${task.id}`} title="取消" disabled={busy} onClick={() => void onTaskAction("取消", task.id, onCancel)}>
            <XCircle size={14} aria-hidden="true" />
          </button>
        ) : null}
        {task.status === "failed" ? (
          <button type="button" aria-label={`重试 ${task.id}`} title="重试" disabled={busy} onClick={() => void onTaskAction("重试", task.id, onRetry)}>
            <RotateCcw size={14} aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className="zt-delete-button"
          aria-label={`删除 ${task.id}`}
          title="删除"
          disabled={busy}
          onClick={() => onDelete(task)}
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
      {task.error_message ? <em>{task.error_message}</em> : null}
    </div>
  );
}

function aggregateGroupStatus(tasks: TransferTask[]): TransferStatus {
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => task.status === "running")) return "running";
  if (tasks.some((task) => task.status === "paused")) return "paused";
  if (tasks.some((task) => task.status === "queued")) return "queued";
  if (tasks.every((task) => task.status === "done")) return "done";
  return "cancelled";
}
