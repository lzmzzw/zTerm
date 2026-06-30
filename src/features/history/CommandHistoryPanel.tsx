// Author: Liz
import { CheckSquare, Copy, Edit3, Play, Plus, Save, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { unknownErrorMessage } from "../../lib/unknownErrorMessage";
import { t } from "../settings/i18n";
import type { AppLanguage } from "../settings/settingsStore";
import type {
  CommandHistoryEntry,
  HistoryScopeKind,
  SessionCommandGroup,
  SessionCommandGroupDraft,
} from "./historyStore";

export type CommandHistoryView = "history" | "deduplicated" | "groups";

interface CommandHistoryPanelProps {
  activeView: CommandHistoryView;
  commandGroups: SessionCommandGroup[];
  entries: CommandHistoryEntry[];
  query: string;
  loading: boolean;
  error: string | null;
  groupLoading: boolean;
  groupError: string | null;
  language?: AppLanguage;
  historyScopeKind: HistoryScopeKind | null;
  historyScopeId: string | null;
  onViewChange: (view: CommandHistoryView) => void;
  onQueryChange: (query: string) => void;
  onSearch: (options?: { deduplicate?: boolean }) => void;
  onCopy: (command: string) => void;
  onSend: (command: string) => void;
  onClear: () => void;
  onSaveCommandGroup: (draft: SessionCommandGroupDraft) => Promise<unknown> | unknown;
  onDeleteCommandGroup: (groupId: string) => Promise<unknown> | unknown;
}

export function CommandHistoryPanel({
  activeView,
  commandGroups,
  entries,
  query,
  loading,
  error,
  groupLoading,
  groupError,
  language = "zhCN",
  historyScopeKind,
  historyScopeId,
  onViewChange,
  onQueryChange,
  onSearch,
  onCopy,
  onSend,
  onClear,
  onSaveCommandGroup,
  onDeleteCommandGroup,
}: CommandHistoryPanelProps) {
  const [selectedEntryIds, setSelectedEntryIds] = useState<string[]>([]);
  const [editingGroup, setEditingGroup] = useState<SessionCommandGroup | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formCommands, setFormCommands] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const selectedCommands = useMemo(
    () =>
      selectedEntryIds
        .map((id) => entries.find((entry) => entry.id === id)?.command)
        .filter((command): command is string => Boolean(command)),
    [entries, selectedEntryIds],
  );
  const hasHistoryScope = Boolean(historyScopeKind && historyScopeId);

  useEffect(() => {
    setSelectedEntryIds([]);
    resetForm();
  }, [activeView, historyScopeKind, historyScopeId]);

  function changeView(view: CommandHistoryView) {
    onViewChange(view);
    if (view === "history") {
      onSearch({ deduplicate: false });
    }
    if (view === "deduplicated") {
      onSearch({ deduplicate: true });
    }
  }

  function toggleEntry(entryId: string, checked: boolean) {
    setSelectedEntryIds((current) =>
      checked ? [...new Set([...current, entryId])] : current.filter((id) => id !== entryId),
    );
  }

  function openSelectedGroupForm() {
    if (!hasHistoryScope || selectedCommands.length === 0) return;
    setEditingGroup(null);
    setFormName("");
    setFormCommands(selectedCommands.join("\n"));
    setFormError(null);
    setFormOpen(true);
  }

  function openNewGroupForm() {
    if (!hasHistoryScope) return;
    setEditingGroup(null);
    setFormName("");
    setFormCommands("");
    setFormError(null);
    setFormOpen(true);
  }

  function openEditGroupForm(group: SessionCommandGroup) {
    setEditingGroup(group);
    setFormName(group.name);
    setFormCommands(group.items.map((item) => item.command).join("\n"));
    setFormError(null);
    setFormOpen(true);
  }

  async function saveGroup() {
    if (!historyScopeKind || !historyScopeId) {
      setFormError("当前终端没有历史作用域，不能保存指令组");
      return;
    }
    const name = formName.trim();
    const commands = normalizeCommands(formCommands);
    if (!name) {
      setFormError("请输入指令组名称");
      return;
    }
    if (commands.length === 0) {
      setFormError("请输入至少一条命令");
      return;
    }
    setFormError(null);
    try {
      await onSaveCommandGroup({
        id: editingGroup?.id,
        saved_session_id: historyScopeKind === "saved_session" ? historyScopeId : null,
        scope_kind: historyScopeKind,
        scope_id: historyScopeId,
        name,
        commands,
      });
      setSelectedEntryIds([]);
      resetForm();
    } catch (error) {
      setFormError(unknownErrorMessage(error, "指令组保存失败"));
    }
  }

  function resetForm() {
    setEditingGroup(null);
    setFormOpen(false);
    setFormName("");
    setFormCommands("");
    setFormError(null);
  }

  return (
    <section className="zt-history-panel" aria-label={t(language, "history")}>
      <div className="zt-history-mode-tabs" role="tablist" aria-label={t(language, "history")}>
        <button type="button" aria-selected={activeView === "history"} onClick={() => changeView("history")}>
          {t(language, "history")}
        </button>
        <button type="button" aria-selected={activeView === "deduplicated"} onClick={() => changeView("deduplicated")}>
          {t(language, "deduplicated")}
        </button>
        <button type="button" aria-selected={activeView === "groups"} onClick={() => changeView("groups")}>
          {t(language, "commandGroups")}
        </button>
      </div>

      {activeView === "groups" ? (
        <CommandGroupView
          commandGroups={commandGroups}
          formCommands={formCommands}
          formError={formError}
          formName={formName}
          formOpen={formOpen}
          groupError={groupError}
          groupLoading={groupLoading}
          language={language}
          hasHistoryScope={hasHistoryScope}
          onCancelForm={resetForm}
          onCopy={onCopy}
          onDeleteCommandGroup={onDeleteCommandGroup}
          onEditGroup={openEditGroupForm}
          onFormCommandsChange={setFormCommands}
          onFormNameChange={setFormName}
          onNewGroup={openNewGroupForm}
          onSaveGroup={() => void saveGroup()}
          onSend={onSend}
        />
      ) : (
        <>
          <div className="zt-history-toolbar">
            <label className="zt-history-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="text"
                aria-label={t(language, "searchHistory")}
                value={query}
                onChange={(event) => onQueryChange(event.currentTarget.value)}
                placeholder={activeView === "deduplicated" ? t(language, "searchDeduplicatedHistory") : t(language, "searchHistory")}
              />
            </label>
            <button type="button" onClick={() => onSearch({ deduplicate: activeView === "deduplicated" })} disabled={loading}>
              {t(language, "search")}
            </button>
            <button
              type="button"
              onClick={openSelectedGroupForm}
              disabled={loading || !hasHistoryScope || selectedCommands.length === 0}
            >
              <Save size={14} aria-hidden="true" />
              {t(language, "saveAsCommandGroup")}
            </button>
            <button type="button" aria-label={t(language, "clearHistory")} onClick={onClear} disabled={loading || !hasHistoryScope}>
                     <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>

          {formOpen ? (
            <CommandGroupForm
              commands={formCommands}
              error={formError}
              language={language}
              name={formName}
              onCancel={resetForm}
              onCommandsChange={setFormCommands}
              onNameChange={setFormName}
              onSave={() => void saveGroup()}
            />
          ) : null}

          {error ? <div className="zt-history-error">{error}</div> : null}

          <div className="zt-history-list">
            {entries.length === 0 ? <div className="zt-empty-line">{t(language, "noHistory")}</div> : null}
            {entries.map((entry) => (
              <article className="zt-history-entry" key={entry.id}>
                <input
                  type="checkbox"
                  aria-label={`${t(language, "selectPrefix")} ${entry.command}`}
                  checked={selectedEntryIds.includes(entry.id)}
                  disabled={!hasHistoryScope}
                  onChange={(event) => toggleEntry(entry.id, event.currentTarget.checked)}
                />
                <code>{entry.command}</code>
                <span>{entry.cwd ?? t(language, "cwdUnknown")}</span>
                <button type="button" aria-label={`${t(language, "copyPrefix")} ${entry.command}`} onClick={() => onCopy(entry.command)}>
                  <Copy size={18} aria-hidden="true" />
                </button>
                <button type="button" aria-label={`${t(language, "sendPrefix")} ${entry.command}`} onClick={() => onSend(entry.command)}>
                  <Play size={18} aria-hidden="true" />
                </button>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function CommandGroupView({
  commandGroups,
  formCommands,
  formError,
  formName,
  formOpen,
  groupError,
  groupLoading,
  hasHistoryScope,
  language,
  onCancelForm,
  onCopy,
  onDeleteCommandGroup,
  onEditGroup,
  onFormCommandsChange,
  onFormNameChange,
  onNewGroup,
  onSaveGroup,
  onSend,
}: {
  commandGroups: SessionCommandGroup[];
  formCommands: string;
  formError: string | null;
  formName: string;
  formOpen: boolean;
  groupError: string | null;
  groupLoading: boolean;
  hasHistoryScope: boolean;
  language: AppLanguage;
  onCancelForm: () => void;
  onCopy: (command: string) => void;
  onDeleteCommandGroup: (groupId: string) => Promise<unknown> | unknown;
  onEditGroup: (group: SessionCommandGroup) => void;
  onFormCommandsChange: (value: string) => void;
  onFormNameChange: (value: string) => void;
  onNewGroup: () => void;
  onSaveGroup: () => void;
  onSend: (command: string) => void;
}) {
  return (
    <>
      <div className="zt-history-group-toolbar">
        <button type="button" onClick={onNewGroup} disabled={!hasHistoryScope || groupLoading}>
          <Plus size={14} aria-hidden="true" />
          {t(language, "addCommandGroup")}
        </button>
        <span>{hasHistoryScope ? t(language, "currentSavedSession") : t(language, "noSavedSession")}</span>
      </div>

      {formOpen ? (
        <CommandGroupForm
          commands={formCommands}
          error={formError}
          language={language}
          name={formName}
          onCancel={onCancelForm}
          onCommandsChange={onFormCommandsChange}
          onNameChange={onFormNameChange}
          onSave={onSaveGroup}
        />
      ) : null}

      {groupError ? <div className="zt-history-error">{groupError}</div> : null}

      <div className="zt-history-group-list">
        {!hasHistoryScope ? <div className="zt-empty-line">{t(language, "cannotSaveCommandGroup")}</div> : null}
        {hasHistoryScope && commandGroups.length === 0 ? <div className="zt-empty-line">{t(language, "noCommandGroups")}</div> : null}
        {hasHistoryScope
          ? commandGroups.map((group) => (
              <article className="zt-history-group" key={group.id}>
                <header>
                  <strong>{group.name}</strong>
                  <button type="button" aria-label={`${t(language, "copyPrefix")} ${group.name}`} onClick={() => onCopy(group.items.map((item) => item.command).join("\n"))}>
                     <Copy size={14} aria-hidden="true" />
                  </button>
                  <button type="button" aria-label={`${t(language, "editPrefix")} ${group.name}`} onClick={() => onEditGroup(group)}>
                     <Edit3 size={14} aria-hidden="true" />
                  </button>
                  <button type="button" aria-label={`${t(language, "deletePrefix")} ${group.name}`} onClick={() => void onDeleteCommandGroup(group.id)}>
              <Trash2 size={14} aria-hidden="true" />
                  </button>
                </header>
                <div className="zt-history-group-items">
                  {group.items.map((item) => (
                    <div className="zt-history-group-item" key={item.id}>
                      <code>{item.command}</code>
                      <button type="button" aria-label={`${t(language, "copyPrefix")} ${item.command}`} onClick={() => onCopy(item.command)}>
                  <Copy size={14} aria-hidden="true" />
                      </button>
                      <button type="button" aria-label={`${t(language, "sendPrefix")} ${item.command}`} onClick={() => onSend(item.command)}>
                  <Play size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              </article>
            ))
          : null}
      </div>
    </>
  );
}

function CommandGroupForm({
  commands,
  error,
  language,
  name,
  onCancel,
  onCommandsChange,
  onNameChange,
  onSave,
}: {
  commands: string;
  error: string | null;
  language: AppLanguage;
  name: string;
  onCancel: () => void;
  onCommandsChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="zt-history-group-form">
      <label>
        <span>{t(language, "commandGroupNameLabel")}</span>
        <input
          type="text"
          aria-label={t(language, "commandGroupName")}
          value={name}
          onChange={(event) => onNameChange(event.currentTarget.value)}
          placeholder={t(language, "commandGroupNamePlaceholder")}
        />
      </label>
      <label>
        <span>{t(language, "commandGroupCommandsLabel")}</span>
        <textarea
          aria-label={t(language, "commandGroupCommands")}
          value={commands}
          onChange={(event) => onCommandsChange(event.currentTarget.value)}
          placeholder={t(language, "commandGroupCommandsPlaceholder")}
        />
      </label>
      {error ? <div className="zt-history-error">{error}</div> : null}
      <div className="zt-history-group-form-actions">
        <button type="button" onClick={onSave}>
          <CheckSquare size={14} aria-hidden="true" />
          {t(language, "saveCommandGroup")}
        </button>
        <button type="button" onClick={onCancel} aria-label={t(language, "cancel")}>
          <X size={14} aria-hidden="true" />
          {t(language, "cancel")}
        </button>
      </div>
    </div>
  );
}

function normalizeCommands(value: string) {
  return value
    .split(/\r?\n/)
    .map((command) => command.trim())
    .filter(Boolean);
}
