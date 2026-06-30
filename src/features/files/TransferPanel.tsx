// Author: Liz
import { ChevronDown, ChevronUp, Pause, Play, RotateCcw, Trash2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { TransferTask } from "./fileStore";

interface TransferPanelProps {
  collapsible?: boolean;
  tasks: TransferTask[];
  onCancel: (taskId: string) => Promise<void> | void;
  onDelete: (taskId: string) => Promise<void> | void;
  onPause: (taskId: string) => Promise<void> | void;
  onRetry: (taskId: string) => Promise<void> | void;
  onResume: (taskId: string) => Promise<void> | void;
}

const activeTransferStatuses = new Set<TransferTask["status"]>(["queued", "running", "paused"]);

export function TransferPanel({
  collapsible = false,
  tasks,
  onCancel,
  onDelete,
  onPause,
  onRetry,
  onResume,
}: TransferPanelProps) {
  const activeCount = tasks.filter((task) => activeTransferStatuses.has(task.status)).length;
  const previousActiveCountRef = useRef(activeCount);
  const [collapsed, setCollapsed] = useState(collapsible && tasks.length === 0);

  useEffect(() => {
    if (!collapsible) return;
    if (activeCount > 0 && previousActiveCountRef.current === 0) {
      setCollapsed(false);
    }
    previousActiveCountRef.current = activeCount;
  }, [activeCount, collapsible]);

  const list = renderTransferList(tasks, onRetry, onPause, onResume, onCancel, onDelete);

  if (collapsible) {
    return (
      <section
        className={collapsed ? "zt-transfer-dock zt-transfer-dock-collapsed" : "zt-transfer-dock"}
        aria-label="传输任务"
      >
        <div className="zt-transfer-dock-header">
          <strong>传输任务</strong>
          <span>{activeCount > 0 ? `${activeCount} 个进行中` : `${tasks.length} 个任务`}</span>
          <button
            type="button"
            aria-label={collapsed ? "展开传输任务" : "折叠传输任务"}
            title={collapsed ? "展开传输任务" : "折叠传输任务"}
            onClick={() => setCollapsed((current) => !current)}
          >
            {collapsed ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          </button>
        </div>
        {collapsed ? null : list}
      </section>
    );
  }

  return list;
}

function renderTransferList(
  tasks: TransferTask[],
  onRetry: TransferPanelProps["onRetry"],
  onPause: TransferPanelProps["onPause"],
  onResume: TransferPanelProps["onResume"],
  onCancel: TransferPanelProps["onCancel"],
  onDelete: TransferPanelProps["onDelete"],
) {
  if (tasks.length === 0) {
    return <div className="zt-empty-line">暂无传输任务</div>;
  }

  return (
    <div className="zt-transfer-list" aria-label="传输任务列表">
      {tasks.map((task) => {
        const percent = task.total_bytes > 0 ? Math.min(100, Math.round((task.transferred_bytes / task.total_bytes) * 100)) : null;
        return (
          <div className="zt-transfer-row" key={task.id}>
            <div className="zt-transfer-main">
              <strong>{task.direction === "upload" ? task.local_path : task.remote_path}</strong>
              <span>{task.direction === "upload" ? task.remote_path : task.local_path}</span>
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
                aria-label={`删除 ${task.id}`}
                title="删除"
                onClick={() => {
                  if (activeTransferStatuses.has(task.status) && !window.confirm("删除运行中传输会先取消该任务，确认删除？")) {
                    return;
                  }
                  void onDelete(task.id);
                }}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
            {task.error_message ? <em>{task.error_message}</em> : null}
          </div>
        );
      })}
    </div>
  );
}
