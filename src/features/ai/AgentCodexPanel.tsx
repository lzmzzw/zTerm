// Author: Liz
import { ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ZtSelect } from "../../components/ZtSelect";
import { ZtInlineError } from "../../components/ZtUi";
import { unknownErrorMessage } from "../../lib/unknownErrorMessage";
import { XtermPane } from "../terminal/XtermPane";
import { useTerminalStore } from "../terminal/terminalStore";
import type { McpApprovalMode, McpToolSecretInputs } from "./mcpStore";
import type { AgentCodexSession, AgentPendingInvocation } from "./agentCodexApi";

const EMPTY_LIVE_OUTPUT_CHUNKS: never[] = [];

export function AgentCodexPanel({
  session,
  active = true,
  activeTargetLabel,
  loading,
  error,
  approvalMode,
  pendingInvocations,
  onApprovalModeChange,
  onClose,
  onConfirmTool,
  onRestart,
}: {
  session: AgentCodexSession | null;
  active?: boolean;
  activeTargetLabel?: string | null;
  loading: boolean;
  error: string | null;
  approvalMode: McpApprovalMode;
  pendingInvocations: AgentPendingInvocation[];
  onApprovalModeChange: (mode: McpApprovalMode) => Promise<unknown> | unknown;
  onClose: () => Promise<unknown> | unknown;
  onConfirmTool: (invocationId: string, approved: boolean, secretInputs?: McpToolSecretInputs) => Promise<unknown> | unknown;
  onRestart: () => Promise<unknown> | unknown;
}) {
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [selectedInvocationId, setSelectedInvocationId] = useState<string | null>(null);
  const [confirmationStates, setConfirmationStates] = useState<Record<string, "approving" | "rejecting">>({});
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const confirmingInvocations = useRef(new Set<string>());
  const selectedIndex = Math.max(0, pendingInvocations.findIndex((invocation) => invocation.id === selectedInvocationId));
  const invocation = pendingInvocations[selectedIndex];
  const confirmationState = invocation ? confirmationStates[invocation.id] : undefined;
  const runtimeSessionId = session?.runtime.runtime_session_id ?? null;
  const outputChunks = useTerminalStore((state) =>
    runtimeSessionId ? (state.outputChunks[runtimeSessionId] ?? EMPTY_LIVE_OUTPUT_CHUNKS) : EMPTY_LIVE_OUTPUT_CHUNKS,
  );
  const discardLiveOutputChunks = useTerminalStore((state) => state.discardLiveOutputChunks);
  const writeTerminal = useTerminalStore((state) => state.writeTerminal);
  const resizeTerminal = useTerminalStore((state) => state.resizeTerminal);
  const initialOutput = useMemo(
    () => (runtimeSessionId ? useTerminalStore.getState().getOutputTail(runtimeSessionId) : ""),
    [runtimeSessionId],
  );

  useEffect(() => {
    if (!runtimeSessionId) return undefined;
    return useTerminalStore.getState().beginLiveOutput(runtimeSessionId);
  }, [runtimeSessionId]);

  useEffect(() => {
    setSelectedInvocationId((current) =>
      pendingInvocations.some((pending) => pending.id === current) ? current : pendingInvocations[0]?.id ?? null,
    );
  }, [pendingInvocations]);

  async function confirmInvocation(approved: boolean) {
    if (!invocation || confirmingInvocations.current.has(invocation.id)) return;
    const invocationId = invocation.id;
    const password = secretInputs[invocationId];
    confirmingInvocations.current.add(invocationId);
    setConfirmationStates((current) => ({ ...current, [invocationId]: approved ? "approving" : "rejecting" }));
    setConfirmationError(null);
    setSecretInputs((current) => {
      const next = { ...current };
      delete next[invocationId];
      return next;
    });
    try {
      await onConfirmTool(invocationId, approved, approved && invocation.requires_secret_input ? { password } : undefined);
    } catch (error) {
      setConfirmationError(unknownErrorMessage(error, "MCP 工具确认失败"));
    } finally {
      confirmingInvocations.current.delete(invocationId);
      setConfirmationStates((current) => {
        const next = { ...current };
        delete next[invocationId];
        return next;
      });
    }
  }

  return (
    <div className="zt-agent-codex-panel">
      <header className="zt-agent-codex-header">
        <strong className="zt-agent-codex-title">Codex CLI</strong>
        <label className="zt-ai-approval-mode">
          <span>审批模式</span>
          <ZtSelect
            ariaLabel="审批模式"
            className={`zt-ai-approval-select mode-${approvalMode}`}
            value={approvalMode}
            options={approvalOptions}
            onChange={(value) => void onApprovalModeChange(value as McpApprovalMode)}
          />
        </label>
        <span className="zt-agent-codex-target">关联连接：{activeTargetLabel ?? session?.target_label ?? "尚未选择终端"}</span>
      </header>

      {session && runtimeSessionId && loading ? (
        <div className="zt-agent-codex-state"><LoaderCircle className="zt-spin" size={18} />正在启动本机 Codex CLI...</div>
      ) : null}
      {session && runtimeSessionId && error ? (
        <div className="zt-agent-codex-state is-error">
          <ZtInlineError>{error}</ZtInlineError>
        </div>
      ) : null}

      <div className="zt-agent-codex-terminal">
        {session && runtimeSessionId ? (
          <XtermPane
            applicationMode
            autoFocus={active}
            followOutput
            contextMenuEnabled
            contextMenuClearEnabled={false}
            contextMenuSearchEnabled={false}
            data={initialOutput}
            replayKind="raw"
            replayKey={runtimeSessionId}
            streamId={runtimeSessionId}
            liveChunks={outputChunks}
            onLiveChunksQueued={(throughSerial) => discardLiveOutputChunks(runtimeSessionId, throughSerial)}
            onInput={(data) => void writeTerminal(runtimeSessionId, data)}
            onCloseTerminal={() => void onClose()}
            onResize={(cols, rows) => void resizeTerminal(runtimeSessionId, cols, rows)}
            onRestart={() => void onRestart()}
          />
        ) : loading ? (
          <div className="zt-agent-codex-state"><LoaderCircle className="zt-spin" size={18} />正在启动本机 Codex CLI...</div>
        ) : error ? (
          <div className="zt-agent-codex-state is-error">
            <ZtInlineError>{error}</ZtInlineError>
          </div>
        ) : (
          <div className="zt-agent-codex-state">请先选择一个可操作的终端标签页。</div>
        )}
      </div>
      {invocation ? (
        <div className="zt-agent-codex-approvals" aria-label="待审批操作">
          <section key={invocation.id} className={`zt-ai-tool-card risk-${invocation.risk_level}`} aria-busy={Boolean(confirmationState)}>
            <header>
              <strong title={invocation.tool_id}>{invocation.tool_id}</strong>
              {pendingInvocations.length > 1 ? (
                <nav className="zt-ai-tool-queue" aria-label="切换待审批操作">
                  <button type="button" aria-label="上一项待审批操作" disabled={selectedIndex === 0} onClick={() => setSelectedInvocationId(pendingInvocations[selectedIndex - 1].id)}><ChevronLeft size={14} /></button>
                  <span>{selectedIndex + 1} / {pendingInvocations.length}</span>
                  <button type="button" aria-label="下一项待审批操作" disabled={selectedIndex === pendingInvocations.length - 1} onClick={() => setSelectedInvocationId(pendingInvocations[selectedIndex + 1].id)}><ChevronRight size={14} /></button>
                </nav>
              ) : null}
            </header>
            <div className="zt-ai-tool-details" tabIndex={0} role="region" aria-label="审批操作详情">
              <div className="zt-ai-tool-summary">
                {invocation.target_summary ? (
                  <p><span>目标</span><strong>{invocation.target_summary}</strong></p>
                ) : null}
                <p><span>参数</span><code>{invocation.arguments_summary}</code></p>
              </div>
              <p className="zt-ai-tool-risk-note">{invocation.risk_summary || invocation.reason || "Codex 请求操作当前终端"}</p>
            </div>
            <footer>
              {confirmationError ? <ZtInlineError>{confirmationError}</ZtInlineError> : null}
              {invocation.requires_secret_input ? (
                <label className="zt-ai-tool-secret">
                  <span>{invocation.secret_input_label || "本次操作所需密码"}</span>
                  <input
                    type="password"
                    autoComplete="off"
                    aria-required="true"
                    disabled={Boolean(confirmationState)}
                    value={secretInputs[invocation.id] ?? ""}
                    onChange={(event) => {
                      const password = event.currentTarget.value;
                      setSecretInputs((current) => ({ ...current, [invocation.id]: password }));
                    }}
                  />
                </label>
              ) : null}
              <div className="zt-ai-tool-actions">
                <button
                  type="button"
                  disabled={Boolean(confirmationState) || (Boolean(invocation.requires_secret_input) && !secretInputs[invocation.id]?.trim())}
                  onClick={() => void confirmInvocation(true)}
                >{confirmationState === "approving" ? <><LoaderCircle className="zt-spin" size={14} />执行中...</> : "批准"}</button>
                <button type="button" disabled={Boolean(confirmationState)} onClick={() => void confirmInvocation(false)}>{confirmationState === "rejecting" ? <><LoaderCircle className="zt-spin" size={14} />拒绝中...</> : "拒绝"}</button>
              </div>
            </footer>
          </section>
        </div>
      ) : null}

    </div>
  );
}

const approvalOptions = [
  { value: "request_approval", label: "每次批准" },
  { value: "safe", label: "高效审批" },
  { value: "full_access", label: "完全自动" },
];
