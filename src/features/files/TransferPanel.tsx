// Author: Liz
import { ChevronDown, ChevronRight, ChevronUp, Pause, Play, RotateCcw, Trash2, XCircle } from "lucide-react";
import { type MouseEvent, useEffect, useRef, useState } from "react";

import { ZtConfirmDialog } from "../../components/ZtUi";
import type { TransferStatus, TransferTask } from "./fileStore";
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
  onClearAll?: (taskIds: string[]) => Promise<void> | void;
  onPauseAll?: (taskIds: string[]) => Promise<void> | void;
  onResumeAll?: (taskIds: string[]) => Promise<void> | void;
  onCollapsedChange?: (collapsed: boolean) => void;
  onResize?: (height: number) => void;
}

const activeTransferStatuses = new Set<TransferTask["status"]>(["queued", "running", "paused"]);
const pausableTransferStatuses = new Set<TransferStatus>(["queued", "running"]);

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
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(() => new Set());
  const dockRef = useRef<HTMLElement | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);

  const requestDelete = (task: TransferTask) => {
    if (!activeTransferStatuses.has(task.status)) {
      void onDelete(task.id);
      return;
    }
    setPendingConfirm({
      title: "删除传输任务",
      message: "删除运行中传输会先取消该任务，确认删除？",
      confirmLabel: "确认删除",
      onConfirm: () => void onDelete(task.id),
    });
  };

  const list = renderTransferList(
    tasks,
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
  );

  useEffect(() => {
    onCollapsedChange?.(collapsed);
  }, [collapsed, onCollapsedChange]);

  function toggleCollapsed() {
    setCollapsed((current) => !current);
  }

  function resizeFromMouse(event: MouseEvent<HTMLButtonElement>) {
    if (collapsed || !onResize) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = dockRef.current?.getBoundingClientRect().height || 200;
    const onMouseMove = (moveEvent: globalThis.MouseEvent) => {
      onResize(startHeight + startY - moveEvent.clientY);
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp, { once: true });
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
              if (!onResize || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
              event.preventDefault();
              const currentHeight = dockRef.current?.getBoundingClientRect().height || 200;
              onResize(currentHeight + (event.key === "ArrowUp" ? 24 : -24));
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
            {collapsed ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          </button>
          {hasBulkActions ? (
            <div className="zt-transfer-dock-actions" aria-label="传输任务批量操作">
              {onPauseAll ? (
                <button
                  type="button"
                  aria-label="暂停全部传输任务"
                  title="暂停全部"
                  disabled={pausableTaskIds.length === 0}
                  onClick={() => void onPauseAll(pausableTaskIds)}
                >
                  <Pause size={14} aria-hidden="true" />
                </button>
              ) : null}
              {onResumeAll ? (
                <button
                  type="button"
                  aria-label="恢复全部传输任务"
                  title="恢复全部"
                  disabled={resumableTaskIds.length === 0}
                  onClick={() => void onResumeAll(resumableTaskIds)}
                >
                  <Play size={14} aria-hidden="true" />
                </button>
              ) : null}
              {onClearAll ? (
                <button
                  type="button"
                  aria-label="清理全部传输任务"
                  title="清理全部"
                  disabled={allTaskIds.length === 0}
                  onClick={() =>
                    setPendingConfirm({
                      title: "清理传输任务",
                      message: "清理全部任务会取消进行中的传输并删除任务记录，确认清理？",
                      confirmLabel: "确认清理",
                      onConfirm: () => void onClearAll(allTaskIds),
                    })
                  }
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {collapsed ? null : list}
        {confirmDialog}
      </section>
    );
  }

  return (
    <>
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
) {
  if (tasks.length === 0) {
    return <div className="zt-empty-line">暂无传输任务</div>;
  }

  return (
    <div className="zt-transfer-list" aria-label="传输任务列表">
      {groupTransferTasks(tasks).map((group) => {
        if (!group.id) return renderTransferRow(group.tasks[0], false, onRetry, onPause, onResume, onCancel, onDelete);
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
              <span className={`zt-transfer-status ${status}`}>{status}</span>
            </button>
            {collapsed ? null : (
              <div className="zt-transfer-group-children">
                {group.tasks.map((task) => renderTransferRow(task, true, onRetry, onPause, onResume, onCancel, onDelete))}
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
) {
  const percent = task.total_bytes > 0 ? Math.min(100, Math.round((task.transferred_bytes / task.total_bytes) * 100)) : null;
  const sourcePath = task.source_endpoint?.path ?? legacyTransferSourcePath(task);
  const destinationPath = task.destination_endpoint?.path ?? legacyTransferDestinationPath(task);
  return (
    <div className={child ? "zt-transfer-row zt-transfer-child-row" : "zt-transfer-row"} key={task.id}>
      <div className="zt-transfer-main">
        <strong>{sourcePath}</strong>
        <span>{destinationPath}</span>
      </div>
      <div className="zt-transfer-progress" aria-label={`${task.id} 进度`}>
        <span style={{ width: `${percent ?? 0}%` }} />
      </div>
      <small>{percent === null ? `${task.transferred_bytes} B` : `${percent}%`}</small>
      <span className={`zt-transfer-status ${task.status}`}>{task.status}</span>
      <div className="zt-transfer-actions">
        {task.status === "queued" || task.status === "running" ? (
          <button type="button" aria-label={`暂停 ${task.id}`} title="暂停" onClick={() => void onPause(task.id)}>
            <Pause size={14} aria-hidden="true" />
          </button>
        ) : null}
        {task.status === "paused" ? (
          <button type="button" aria-label={`恢复 ${task.id}`} title="恢复" onClick={() => void onResume(task.id)}>
            <Play size={14} aria-hidden="true" />
          </button>
        ) : null}
        {activeTransferStatuses.has(task.status) ? (
          <button type="button" aria-label={`取消 ${task.id}`} title="取消" onClick={() => void onCancel(task.id)}>
            <XCircle size={14} aria-hidden="true" />
          </button>
        ) : null}
        {task.status === "failed" ? (
          <button type="button" aria-label={`重试 ${task.id}`} title="重试" onClick={() => void onRetry(task.id)}>
            <RotateCcw size={14} aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className="zt-delete-button"
          aria-label={`删除 ${task.id}`}
          title="删除"
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
