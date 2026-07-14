// Author: Liz
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useMemo } from "react";

import { ZtSelect } from "../../components/ZtSelect";
import { buildJumpHostOptions, normalizeJumpHosts } from "./sshSessionModel";
import type { SavedSession, SshOptions } from "./types";

interface SshJumpHostSectionProps {
  sshOptions: SshOptions;
  savedSessions: SavedSession[];
  currentSessionId: string | null;
  selectedJumpHostId: string;
  onSelectedJumpHostIdChange: (id: string) => void;
  onSshOptionsChange: (options: SshOptions) => void;
}

export function SshJumpHostSection({
  sshOptions,
  savedSessions,
  currentSessionId,
  selectedJumpHostId,
  onSelectedJumpHostIdChange,
  onSshOptionsChange,
}: SshJumpHostSectionProps) {
  const jumpHostOptions = useMemo(
    () => buildJumpHostOptions(savedSessions, currentSessionId),
    [currentSessionId, savedSessions],
  );
  const jumpHosts = normalizeJumpHosts(sshOptions.jump_hosts);
  const selectedJumpHost = jumpHostOptions.find((option) => option.id === selectedJumpHostId) ?? null;
  const selectedJumpHostAlreadyAdded = selectedJumpHost ? jumpHosts.includes(selectedJumpHost.value) : false;

  function updateJumpHosts(nextJumpHosts: string[]) {
    onSshOptionsChange({ ...sshOptions, jump_hosts: nextJumpHosts });
  }

  function handleAddJumpHost() {
    if (!selectedJumpHost || selectedJumpHostAlreadyAdded) return;
    updateJumpHosts([...jumpHosts, selectedJumpHost.value]);
    onSelectedJumpHostIdChange("");
  }

  function moveJumpHost(index: number, offset: -1 | 1) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= jumpHosts.length) return;
    const nextJumpHosts = [...jumpHosts];
    const [item] = nextJumpHosts.splice(index, 1);
    nextJumpHosts.splice(targetIndex, 0, item);
    updateJumpHosts(nextJumpHosts);
  }

  function removeJumpHost(index: number) {
    updateJumpHosts(jumpHosts.filter((_, itemIndex) => itemIndex !== index));
  }

  return (
    <section className="zt-session-form-section zt-session-form-wide" aria-label="跳板机">
      <div className="zt-session-form-section-title">跳板机</div>
      <div className="zt-ssh-jump-host-editor">
        <div className="zt-ssh-jump-host-picker">
          <ZtSelect
            ariaLabel="已有 SSH 主机"
            value={selectedJumpHostId}
            disabled={jumpHostOptions.length === 0}
            placeholder="请选择 SSH 主机"
            options={[{ value: "", label: "请选择 SSH 主机" }, ...jumpHostOptions.map((option) => ({ value: option.id, label: option.label }))]}
            searchable
            onChange={onSelectedJumpHostIdChange}
          />
          <button
            type="button"
            onClick={handleAddJumpHost}
            disabled={!selectedJumpHost || selectedJumpHostAlreadyAdded}
          >
            <Plus size={14} aria-hidden="true" />
            添加跳板机
          </button>
        </div>
        {jumpHostOptions.length === 0 ? <div className="zt-empty-line">暂无其他 SSH 主机</div> : null}
        {jumpHosts.length === 0 ? (
          <div className="zt-empty-line">暂无跳板机</div>
        ) : (
          <ul className="zt-ssh-jump-host-list">
            {jumpHosts.map((jumpHost, index) => (
              <li key={`${jumpHost}-${index}`} className="zt-ssh-jump-host-row">
                <span className="zt-ssh-jump-host-label">{jumpHost}</span>
                <div className="zt-ssh-jump-host-actions">
                  <button
                    type="button"
                    aria-label={`上移跳板机 ${jumpHost}`}
                    title="上移"
                    disabled={index === 0}
                    onClick={() => moveJumpHost(index, -1)}
                  >
                    <ArrowUp size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={`下移跳板机 ${jumpHost}`}
                    title="下移"
                    disabled={index === jumpHosts.length - 1}
                    onClick={() => moveJumpHost(index, 1)}
                  >
                    <ArrowDown size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="zt-delete-button"
                    aria-label={`删除跳板机 ${jumpHost}`}
                    title="删除"
                    onClick={() => removeJumpHost(index)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
