// Author: Liz
import { ArrowLeft, ChevronDown, ChevronRight, History, Plus, Send, ShieldCheck, Trash2 } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";

import { ZtSelect } from "../../components/ZtSelect";
import { t } from "../settings/i18n";
import type { AppLanguage } from "../settings/settingsStore";
import type {
  AiApprovalMode,
  AiConversationMessage,
  AiConversationPreviewState,
  AiConversationSummary,
  AiTerminalContextSnapshot,
  AiToolPendingInvocation,
} from "./aiStore";

interface AiPanelProps {
  activeRuntimeSessionId: string | null;
  activePaneId?: string | null;
  activePaneTitle?: string | null;
  activeSavedSessionId?: string | null;
  providersAvailable: boolean;
  recentOutput: string;
  loading: boolean;
  error: string | null;
  conversations?: AiConversationSummary[];
  conversationPreviews?: Record<string, AiConversationPreviewState>;
  activeConversationId?: string | null;
  approvalMode?: AiApprovalMode;
  messages?: AiConversationMessage[];
  contextSnapshot?: AiTerminalContextSnapshot | null;
  pendingInvocations?: AiToolPendingInvocation[];
  language?: AppLanguage;
  onSendChat?: (message: string) => Promise<unknown> | unknown;
  onApprovalModeChange?: (mode: AiApprovalMode) => Promise<unknown> | unknown;
  onSelectConversation?: (conversationId: string) => Promise<unknown> | unknown;
  onLoadConversationPreview?: (conversationId: string) => Promise<unknown> | unknown;
  onNewConversation?: () => Promise<unknown> | unknown;
  onDeleteConversation?: (conversationId: string) => Promise<unknown> | unknown;
  onConfirmTool?: (invocationId: string, approved: boolean) => Promise<unknown> | unknown;
}

export function AiPanel({
  activeRuntimeSessionId,
  activePaneId = null,
  activePaneTitle = null,
  activeSavedSessionId = null,
  providersAvailable,
  recentOutput: _recentOutput,
  loading,
  error,
  conversations = [],
  conversationPreviews = {},
  activeConversationId = null,
  approvalMode = "safe",
  messages = [],
  contextSnapshot = null,
  pendingInvocations = [],
  language = "zhCN",
  onSendChat,
  onApprovalModeChange,
  onSelectConversation,
  onLoadConversationPreview,
  onNewConversation,
  onDeleteConversation,
  onConfirmTool,
}: AiPanelProps) {
  const [panelView, setPanelView] = useState<"current" | "history">("current");
  const [expandedConversationIds, setExpandedConversationIds] = useState<string[]>([]);
  const [chatPrompt, setChatPrompt] = useState("");
  const promptId = useId();
  const canSendChat = providersAvailable && Boolean(chatPrompt.trim()) && !loading && Boolean(onSendChat);
  const matchingSnapshotTitle =
    contextSnapshot?.runtime_session_id === activeRuntimeSessionId ? contextSnapshot.title?.trim() : null;
  const boundTarget = activeRuntimeSessionId
    ? matchingSnapshotTitle || activePaneTitle?.trim() || activeRuntimeSessionId
    : t(language, "unboundTerminal");
  const boundTargetTitle = activeRuntimeSessionId
    ? [
        boundTarget,
        activePaneId ? `pane=${activePaneId}` : null,
        `runtime=${activeRuntimeSessionId}`,
        activeSavedSessionId ? `session=${activeSavedSessionId}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : boundTarget;
  const historyConversations = conversations.filter((conversation) => conversation.id !== activeConversationId);

  async function sendChat() {
    const message = chatPrompt.trim();
    if (!message || !onSendChat) return;
    await onSendChat(message);
    setChatPrompt("");
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    void sendChat();
  }

  function createNewConversation() {
    void onNewConversation?.();
    setPanelView("current");
  }

  async function restoreConversation(conversationId: string) {
    await onSelectConversation?.(conversationId);
    setPanelView("current");
  }

  function toggleHistoryConversation(conversationId: string) {
    const isExpanded = expandedConversationIds.includes(conversationId);
    setExpandedConversationIds((current) =>
      isExpanded ? current.filter((id) => id !== conversationId) : [...current, conversationId],
    );
    if (!isExpanded) {
      void onLoadConversationPreview?.(conversationId);
    }
  }

  function renderHistoryPreview(conversationId: string) {
    const preview = conversationPreviews[conversationId];
    if (!preview || preview.loading) {
      return <div className="zt-empty-line">{t(language, "loadingAiHistoryPreview")}</div>;
    }
    if (preview.error) {
      return <div className="zt-session-error">{preview.error}</div>;
    }
    const previewMessages = preview.messages?.slice(-4) ?? [];
    if (previewMessages.length === 0) {
      return <div className="zt-empty-line">{t(language, "noAiHistoryPreview")}</div>;
    }
    return previewMessages.map((message) => renderConversationMessage(message, language));
  }

  return (
    <section className="zt-ai-panel" aria-label="AI 操作台">
      <header className={`zt-ai-bound-target${activeRuntimeSessionId ? "" : " is-unbound"}`} aria-label="当前绑定窗格">
        <div>
          <strong title={boundTargetTitle}>{boundTarget}</strong>
        </div>
        <div className="zt-ai-toolbar" aria-label={panelView === "history" ? t(language, "aiHistory") : t(language, "currentConversation")}>
          {panelView === "history" ? (
            <button
              type="button"
              aria-label={t(language, "backToCurrentConversation")}
              title={t(language, "backToCurrentConversation")}
              onClick={() => setPanelView("current")}
            >
              <ArrowLeft size={15} aria-hidden="true" />
            </button>
          ) : null}
          {onNewConversation ? (
            <button type="button" aria-label={t(language, "newConversation")} title={t(language, "newConversation")} onClick={createNewConversation}>
              <Plus size={15} aria-hidden="true" />
            </button>
          ) : null}
          {panelView === "current" ? (
            <button
              type="button"
              aria-label={t(language, "aiHistory")}
              title={t(language, "aiHistory")}
              onClick={() => setPanelView("history")}
            >
              <History size={15} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      {panelView === "history" ? (
        <div className="zt-ai-history-view" aria-label={t(language, "aiHistory")}>
          {pendingInvocations.length > 0 ? (
            <div className="zt-ai-history-tools-notice">
              {t(language, "aiHistoryPendingToolsNotice", { count: pendingInvocations.length })}
            </div>
          ) : null}
          {error ? <div className="zt-session-error">{error}</div> : null}
          {historyConversations.length === 0 ? <div className="zt-empty-line">{t(language, "noAiConversations")}</div> : null}
          {historyConversations.map((conversation) => {
            const expanded = expandedConversationIds.includes(conversation.id);
            return (
              <article className="zt-ai-history-row" key={conversation.id}>
                <div className="zt-ai-history-row-header">
                  <button
                    type="button"
                    className="zt-ai-history-expand"
                    aria-label={t(language, expanded ? "collapseAiConversation" : "expandAiConversation", { title: conversation.title })}
                    title={t(language, expanded ? "collapseAiConversation" : "expandAiConversation", { title: conversation.title })}
                    onClick={() => toggleHistoryConversation(conversation.id)}
                  >
                    {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    className="zt-ai-history-main"
                    aria-label={t(language, "restoreAiConversation", { title: conversation.title })}
                    title={t(language, "restoreAiConversation", { title: conversation.title })}
                    onDoubleClick={() => void restoreConversation(conversation.id)}
                  >
                    <span className="zt-ai-history-title">{conversation.title}</span>
                    <time className="zt-ai-history-time" dateTime={new Date(conversation.updated_at_ms).toISOString()}>
                      {formatConversationTime(conversation.updated_at_ms)}
                    </time>
                  </button>
                  {onDeleteConversation ? (
                    <button
                      type="button"
                      className="zt-ai-conversation-delete"
                      aria-label={t(language, "deleteAiConversationTitle", { title: conversation.title })}
                      title={t(language, "deleteAiConversationTitle", { title: conversation.title })}
                      disabled={loading}
                      onClick={() => void onDeleteConversation(conversation.id)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
                {expanded ? <div className="zt-ai-history-preview">{renderHistoryPreview(conversation.id)}</div> : null}
              </article>
            );
          })}
        </div>
      ) : (
        <>
          <div className="zt-ai-messages" aria-label="AI 会话消息">
            {messages.length === 0 ? <div className="zt-empty-line">{t(language, "noAiMessages")}</div> : null}
            {messages.map((message) => renderConversationMessage(message, language))}
          </div>

          {pendingInvocations.length > 0 ? (
            <div className="zt-ai-tools" aria-label="AI 工具调用">
              {pendingInvocations.map((invocation) => {
                const toolSummary = summarizeToolInvocation(invocation, language);
                return (
                  <section className={`zt-ai-tool-card risk-${invocation.risk_level}`} title={toolSummary.rawDetails} key={invocation.id}>
                    <header>
                      <strong>{invocation.tool_title}</strong>
                      <span>{riskLabel(invocation.risk_level, language)}</span>
                    </header>
                    <div className="zt-ai-tool-summary">
                      <p>
                        <span>{t(language, "aiToolConnection")}：</span>
                        <strong>{toolSummary.connection}</strong>
                      </p>
                      <p>
                        <span>{t(language, "aiToolOperation")}：</span>
                        <strong>{toolSummary.operation}</strong>
                      </p>
                      <p>
                        <span>{toolSummary.detailLabel}：</span>
                        <code>{toolSummary.detail}</code>
                      </p>
                    </div>
                    {invocation.risk_summary ? <small className="zt-ai-tool-risk-note">{invocation.risk_summary}</small> : null}
                    <footer>
                      <button type="button" disabled={loading} onClick={() => void onConfirmTool?.(invocation.id, true)}>
                        {t(language, "approve")}
                      </button>
                      <button type="button" disabled={loading} onClick={() => void onConfirmTool?.(invocation.id, false)}>
                        {t(language, "reject")}
                      </button>
                    </footer>
                  </section>
                );
              })}
            </div>
          ) : null}

          {!providersAvailable ? <div className="zt-ai-warning">{t(language, "configureAiProvider")}</div> : null}
          {error ? <div className="zt-session-error">{error}</div> : null}

          <div className="zt-ai-composer" aria-label={t(language, "aiComposer")}>
            <div className="zt-ai-prompt zt-ai-chat-input">
              <div className="zt-ai-composer-box">
                <textarea
                  id={promptId}
                  aria-label={t(language, "aiRequest")}
                  value={chatPrompt}
                  onChange={(event) => setChatPrompt(event.currentTarget.value)}
                  onKeyDown={handlePromptKeyDown}
                />
                <div className="zt-ai-composer-footer">
                  <div className="zt-ai-approval-mode" aria-label={t(language, "approvalMode")} title={t(language, "approvalMode")}>
                    <ShieldCheck size={14} aria-hidden="true" />
                    <ZtSelect
                      ariaLabel={t(language, "approvalMode")}
                      className="zt-ai-approval-select"
                      value={approvalMode}
                      options={approvalModeOptions(language)}
                      disabled={loading}
                      onChange={(value) => void onApprovalModeChange?.(value as AiApprovalMode)}
                    />
                  </div>
                  <button
                    type="button"
                    className="zt-ai-send"
                    aria-label={t(language, "send")}
                    title={t(language, "send")}
                    disabled={!canSendChat}
                    onClick={() => void sendChat()}
                  >
                    <Send size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

    </section>
  );
}

function approvalModeOptions(language: AppLanguage): Array<{ value: AiApprovalMode; label: string }> {
  return [
    {
      value: "request_approval",
      label: t(language, "requestApproval"),
    },
    {
      value: "safe",
      label: t(language, "safeApproval"),
    },
    {
      value: "full_access",
      label: t(language, "fullAccess"),
    },
  ];
}

function renderConversationMessage(message: AiConversationMessage, language: AppLanguage) {
  return (
    <article className={`zt-ai-message role-${message.role}`} aria-label={roleLabel(message.role, language)} key={message.id}>
      <p>{message.content}</p>
    </article>
  );
}

function roleLabel(role: AiConversationMessage["role"], language: AppLanguage) {
  if (role === "user") return t(language, "userRole");
  if (role === "assistant") return t(language, "assistantRole");
  if (role === "tool") return t(language, "toolRole");
  return t(language, "systemRole");
}

function riskLabel(risk: AiToolPendingInvocation["risk_level"], language: AppLanguage) {
  if (risk === "low") return t(language, "riskLow");
  if (risk === "medium") return t(language, "riskMedium");
  if (risk === "high") return t(language, "riskHigh");
  return t(language, "riskCritical");
}

function summarizeToolInvocation(invocation: AiToolPendingInvocation, language: AppLanguage) {
  const argumentFields = parseSummaryFields(invocation.arguments_summary);
  const targetFields = parseSummaryFields(invocation.target_summary ?? "");
  const connection =
    argumentFields.target_title ??
    targetFields.target_title ??
    targetFields.cwd ??
    argumentFields.cwd ??
    t(language, "aiToolCurrentTerminal");
  const command = invocation.tool_id === "terminal.write" ? argumentFields.data : null;
  const compactArguments = compactToolArguments(argumentFields);
  const detail = command ?? compactArguments ?? invocation.arguments_summary;
  return {
    connection,
    operation: invocation.tool_title,
    detail,
    detailLabel: command ? t(language, "aiToolCommand") : t(language, "aiToolArguments"),
    rawDetails: [
      invocation.tool_id,
      invocation.target_summary ? `${t(language, "target")}: ${invocation.target_summary}` : null,
      invocation.arguments_summary,
      invocation.risk_summary,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function compactToolArguments(fields: Record<string, string>) {
  const hiddenKeys = new Set(["pane_id", "runtime_session_id", "saved_session_id", "target_title", "scope_id"]);
  const parts = Object.entries(fields)
    .filter(([key, value]) => !hiddenKeys.has(key) && value.trim().length > 0)
    .map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function parseSummaryFields(summary: string) {
  const fields: Record<string, string> = {};
  const keyPattern = /(?:^|,\s)([a-z_]+)=/g;
  const matches = Array.from(summary.matchAll(keyPattern));
  matches.forEach((match, index) => {
    const key = match[1];
    const valueStart = (match.index ?? 0) + match[0].length;
    const valueEnd = index + 1 < matches.length ? matches[index + 1].index ?? summary.length : summary.length;
    fields[key] = summary.slice(valueStart, valueEnd).replace(/,\s$/, "").trim();
  });
  return fields;
}

function formatConversationTime(updatedAtMs?: number) {
  if (!updatedAtMs) return "";
  return new Date(updatedAtMs).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
