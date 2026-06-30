// Author: Liz
import { RotateCcw } from "lucide-react";

import type { TransferTask } from "./fileStore";

interface TransferPanelProps {
  tasks: TransferTask[];
  onRetry: (taskId: string) => Promise<void> | void;
}

export function TransferPanel({ tasks, onRetry }: TransferPanelProps) {
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
            {task.error_message ? <em>{task.error_message}</em> : null}
            {task.status === "failed" ? (
              <button type="button" aria-label={`重试 ${task.id}`} onClick={() => void onRetry(task.id)}>
                <RotateCcw size={14} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
