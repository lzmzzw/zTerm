// Author: Liz
import { ArrowUp, Plus, Save, Square, Star } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { ZtSelect } from "../../components/ZtSelect";
import {
  ZtButton,
  ZtConfirmDialog,
  ZtDialog,
  ZtContextMenu,
  ZtInput,
  ZtSwitch,
  ZtTextarea,
} from "../../components/ZtUi";
import { unknownErrorMessage } from "../../lib/unknownErrorMessage";
import type {
  AiProviderDraftTestRequest,
  AiProviderDraftTestCancelResult,
  AiProviderDraftTestStreamStartResult,
  AiProviderKind,
  AiProviderProfile,
  AiProviderProfileDraft,
} from "../settings/settingsStore";

interface ModelManagerPanelProps {
  providers: AiProviderProfile[];
  loading: boolean;
  error: string | null;
  onSaveProvider: (draft: AiProviderProfileDraft) => Promise<unknown> | unknown;
  onDeleteProvider: (id: string) => Promise<unknown> | unknown;
  onStartProviderDraftTest: (
    request: AiProviderDraftTestRequest,
  ) => Promise<AiProviderDraftTestStreamStartResult> | AiProviderDraftTestStreamStartResult;
  onCancelProviderDraftTest: (testId: string) => Promise<AiProviderDraftTestCancelResult> | AiProviderDraftTestCancelResult;
}

interface ProviderDraftTestChunkEvent {
  test_id: string;
  delta: string;
}

interface ProviderDraftTestDoneEvent {
  test_id: string;
  message: string;
  output: string;
}

interface ProviderDraftTestErrorEvent {
  test_id: string;
  message: string;
}

interface ProviderDraftTestCancelledEvent {
  test_id: string;
}

type PendingProviderTestEvent =
  | { kind: "chunk"; payload: ProviderDraftTestChunkEvent }
  | { kind: "done"; payload: ProviderDraftTestDoneEvent }
  | { kind: "error"; payload: ProviderDraftTestErrorEvent }
  | { kind: "cancelled"; payload: ProviderDraftTestCancelledEvent };

interface FormState {
  id: string | null;
  apiKeyRef: string | null;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  enabled: boolean;
  isDefault: boolean;
  testInput: string;
}

type ModelContextMenu = {
  provider: AiProviderProfile | null;
  x: number;
  y: number;
};

const emptyForm: FormState = {
  id: null,
  apiKeyRef: null,
  name: "",
  kind: "openai_chat",
  baseUrl: "",
  model: "",
  apiKey: "",
  enabled: true,
  isDefault: false,
  testInput: "ping",
};

const providerKindOptions = [
  { value: "openai_chat", label: "OpenAI Chat" },
  { value: "openai_responses", label: "OpenAI Responses" },
  { value: "anthropic", label: "Anthropic" },
];

const panelErrorMessageOptions = {
  blankStringFallback: true,
  objectMessage: true,
};

export function ModelManagerPanel({
  providers,
  loading,
  error,
  onSaveProvider,
  onDeleteProvider,
  onStartProviderDraftTest,
  onCancelProviderDraftTest,
}: ModelManagerPanelProps) {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editorOpen, setEditorOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [testOutput, setTestOutput] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testStarting, setTestStartingState] = useState(false);
  const [activeTestId, setActiveTestIdState] = useState<string | null>(null);
  const testStartingRef = useRef(false);
  const activeTestIdRef = useRef<string | null>(null);
  const pendingTestEventsRef = useRef<PendingProviderTestEvent[]>([]);
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AiProviderProfile | null>(null);
  const [contextMenu, setContextMenu] = useState<ModelContextMenu | null>(null);
  const editorFormId = useId();

  const editingProvider = providers.find((provider) => provider.id === form.id) ?? null;
  const isEditing = Boolean(form.id);
  const testing = testStarting || activeTestId !== null;

  function patchForm(patch: Partial<FormState>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function setActiveTestId(testId: string | null) {
    activeTestIdRef.current = testId;
    setActiveTestIdState(testId);
  }

  function setTestStarting(testing: boolean) {
    testStartingRef.current = testing;
    setTestStartingState(testing);
  }

  function applyProviderTestEvent(event: PendingProviderTestEvent) {
    if (activeTestIdRef.current !== event.payload.test_id) return;
    if (event.kind === "chunk") {
      setTestOutput((current) => `${current ?? ""}${event.payload.delta}`);
      return;
    }
    if (event.kind === "done") {
      setMessage(event.payload.message || "模型测试通过");
      setTestOutput(event.payload.output || "模型未返回文本");
      setActiveTestId(null);
      return;
    }
    if (event.kind === "error") {
      setFormError(event.payload.message);
      setTestOutput(event.payload.message);
      setActiveTestId(null);
      return;
    }
    setTestOutput((current) => {
      const output = current?.trim() ? current : "";
      return output ? `${output}\n\n已取消` : "已取消";
    });
    setActiveTestId(null);
  }

  function enqueueOrApplyProviderTestEvent(event: PendingProviderTestEvent) {
    if (activeTestIdRef.current === event.payload.test_id) {
      applyProviderTestEvent(event);
      return;
    }
    if (testStartingRef.current && activeTestIdRef.current === null) {
      pendingTestEventsRef.current.push(event);
    }
  }

  function replayPendingProviderTestEvents(testId: string) {
    const pendingEvents = pendingTestEventsRef.current;
    pendingTestEventsRef.current = pendingEvents.filter((event) => event.payload.test_id !== testId);
    pendingEvents
      .filter((event) => event.payload.test_id === testId)
      .forEach((event) => applyProviderTestEvent(event));
  }

  function openCreateEditor() {
    setForm({ ...emptyForm, testInput: form.testInput.trim() ? form.testInput : emptyForm.testInput });
    setEditorOpen(true);
    setMessage(null);
    setFormError(null);
    setTestOutput(null);
    setActiveTestId(null);
    setTestStarting(false);
    setPendingDelete(null);
  }

  function openEditEditor(provider: AiProviderProfile) {
    setForm({
      id: provider.id,
      apiKeyRef: provider.api_key_ref || null,
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.base_url,
      model: provider.model,
      apiKey: "",
      enabled: provider.enabled,
      isDefault: provider.is_default,
      testInput: form.testInput.trim() ? form.testInput : "ping",
    });
    setEditorOpen(true);
    setMessage(null);
    setFormError(null);
    setTestOutput(null);
    setActiveTestId(null);
    setTestStarting(false);
    setPendingDelete(null);
  }

  function closeEditor() {
    if (saving || testing) return;
    setEditorOpen(false);
    setFormError(null);
    setTestOutput(null);
  }

  function buildDraft(): AiProviderProfileDraft | null {
    const name = form.name.trim();
    const baseUrl = form.baseUrl.trim();
    const model = form.model.trim();
    const apiKey = form.apiKey.trim();
    const apiKeyRef = form.apiKeyRef?.trim() || null;
    if (!name || !baseUrl || !model) {
      setFormError("请填写模型名称、模型 URL 和模型标识");
      return null;
    }
    if (form.kind === "anthropic" && !apiKey && !apiKeyRef) {
      setFormError("Anthropic 模型需要 API Key");
      return null;
    }
    return {
      id: form.id,
      name,
      kind: form.kind,
      base_url: baseUrl,
      model,
      api_key: apiKey || null,
      api_key_ref: apiKeyRef,
      enabled: form.enabled,
      is_default: form.isDefault,
    };
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const draft = buildDraft();
    if (!draft) return;
    setSaving(true);
    setFormError(null);
    setMessage(null);
    try {
      await onSaveProvider(draft);
      setMessage("模型已保存");
      setEditorOpen(false);
      setForm({ ...emptyForm, testInput: form.testInput.trim() ? form.testInput : emptyForm.testInput });
      setTestOutput(null);
      setActiveTestId(null);
    } catch (saveError) {
      setFormError(unknownErrorMessage(saveError, "保存模型失败", panelErrorMessageOptions));
    } finally {
      setSaving(false);
    }
  }

  async function startDraftTest() {
    const draft = buildDraft();
    const prompt = form.testInput.trim();
    if (!draft) return;
    if (!prompt) {
      setFormError("请填写测试输入");
      return;
    }
    setTestStarting(true);
    setFormError(null);
    setMessage(null);
    setTestOutput("");
    pendingTestEventsRef.current = [];
    try {
      const result = await onStartProviderDraftTest({ draft, prompt });
      setActiveTestId(result.test_id);
      replayPendingProviderTestEvents(result.test_id);
    } catch (testError) {
      const message = unknownErrorMessage(testError, "测试模型失败", panelErrorMessageOptions);
      setFormError(message);
      setTestOutput(message);
      pendingTestEventsRef.current = [];
    } finally {
      setTestStarting(false);
    }
  }

  async function cancelDraftTest() {
    const testId = activeTestIdRef.current;
    if (!testId) return;
    try {
      const result = await onCancelProviderDraftTest(testId);
      if (result.cancelled && activeTestIdRef.current === testId) {
        setTestOutput((current) => {
          const output = current?.trim() ? current : "";
          return output ? `${output}\n\n已取消` : "已取消";
        });
        setActiveTestId(null);
      }
    } catch (cancelError) {
      const message = unknownErrorMessage(cancelError, "取消模型测试失败", panelErrorMessageOptions);
      setFormError(message);
    }
  }

  async function setDefaultProvider(provider: AiProviderProfile) {
    if (provider.is_default) return;
    setSettingDefaultId(provider.id);
    setMessage(null);
    setFormError(null);
    try {
      await onSaveProvider(providerDraftFromProfile(provider, true));
      setMessage("默认模型已更新");
    } catch (defaultError) {
      setFormError(unknownErrorMessage(defaultError, "设置默认模型失败", panelErrorMessageOptions));
    } finally {
      setSettingDefaultId(null);
    }
  }

  async function deleteProvider(provider: AiProviderProfile) {
    setFormError(null);
    setMessage(null);
    try {
      await onDeleteProvider(provider.id);
      setPendingDelete(null);
      if (form.id === provider.id) {
        setEditorOpen(false);
        setForm({ ...emptyForm, testInput: form.testInput.trim() ? form.testInput : emptyForm.testInput });
      }
      setMessage("模型已删除");
    } catch (deleteError) {
      setFormError(unknownErrorMessage(deleteError, "删除模型失败", panelErrorMessageOptions));
    }
  }

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, [contextMenu]);

  useEffect(() => {
    let disposed = false;
    const unlistenFns: UnlistenFn[] = [];

    async function bindProviderTestEvents() {
      const chunk = await listen<ProviderDraftTestChunkEvent>("llm-provider-test:chunk", (event) => {
        enqueueOrApplyProviderTestEvent({ kind: "chunk", payload: event.payload });
      });
      const done = await listen<ProviderDraftTestDoneEvent>("llm-provider-test:done", (event) => {
        enqueueOrApplyProviderTestEvent({ kind: "done", payload: event.payload });
      });
      const error = await listen<ProviderDraftTestErrorEvent>("llm-provider-test:error", (event) => {
        enqueueOrApplyProviderTestEvent({ kind: "error", payload: event.payload });
      });
      const cancelled = await listen<ProviderDraftTestCancelledEvent>("llm-provider-test:cancelled", (event) => {
        enqueueOrApplyProviderTestEvent({ kind: "cancelled", payload: event.payload });
      });
      if (disposed) {
        chunk();
        done();
        error();
        cancelled();
        return;
      }
      unlistenFns.push(chunk, done, error, cancelled);
    }

    void bindProviderTestEvents();
    return () => {
      disposed = true;
      unlistenFns.forEach((unlisten) => unlisten());
    };
  }, []);

  return (
    <section
      className="zt-model-panel"
      aria-label="模型管理"
      onContextMenu={(event) => {
        event.preventDefault();
        setContextMenu({ provider: null, x: event.clientX, y: event.clientY });
      }}
    >
      <div className="zt-panel-header">
        <span>模型</span>
        <div className="zt-panel-header-action">
          <button className="zt-panel-action-button" type="button" aria-label="新增模型" title="新增模型" onClick={openCreateEditor}>
            <Plus size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="zt-model-panel-body">
        {error ? <div className="zt-empty-line">{error}</div> : null}
        {formError && !editorOpen ? <p className="zt-session-error">{formError}</p> : null}
        {message && !editorOpen ? <p className="zt-settings-status">{message}</p> : null}

        <div className="zt-model-list" aria-label="已添加模型列表">
          {providers.length === 0 ? <div className="zt-empty-line">暂无模型</div> : null}
          {providers.map((provider) => (
            <div
              className={provider.is_default ? "zt-model-row default" : "zt-model-row"}
              key={provider.id}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setContextMenu({ provider, x: event.clientX, y: event.clientY });
              }}
            >
              <button
                type="button"
                className="zt-model-default-button"
                aria-label={provider.is_default ? `默认模型 ${provider.name}` : `设为默认模型 ${provider.name}`}
                title={provider.is_default ? "默认模型" : "设为默认模型"}
                disabled={provider.is_default || loading || settingDefaultId === provider.id}
                onClick={() => void setDefaultProvider(provider)}
              >
                <Star size={14} fill={provider.is_default ? "currentColor" : "none"} aria-hidden="true" />
              </button>
              <button type="button" className="zt-model-main" title={provider.name} onClick={() => openEditEditor(provider)}>
                <strong>{provider.name}</strong>
              </button>
            </div>
          ))}
        </div>
      </div>

      {editorOpen ? (
        <ZtDialog
          ariaLabel="模型配置"
          title={isEditing ? "编辑模型" : "新增模型"}
          size="large"
          className="zt-model-dialog"
          bodyClassName="zt-model-dialog-body"
          onClose={closeEditor}
          closeDisabled={testing || saving}
          closeLabel="关闭模型配置"
          footer={
            <>
              <ZtButton disabled={testing || saving} onClick={closeEditor}>
                取消
              </ZtButton>
              <ZtButton form={editorFormId} type="submit" disabled={saving || loading || testing} variant="primary">
                <Save size={14} aria-hidden="true" />
                {saving ? "保存中" : "保存模型"}
              </ZtButton>
            </>
          }
        >
          <form id={editorFormId} className="zt-model-form" onSubmit={(event) => void saveProvider(event)}>
            <div className="zt-model-editor-main">
              <section className="zt-model-config-section" aria-label="模型基础配置">
                {formError ? <p className="zt-session-error zt-model-message-line">{formError}</p> : null}
                {message ? <p className="zt-settings-status zt-model-message-line">{message}</p> : null}
                <div className="zt-model-config-grid">
                  <label>
                    <span>模型名称</span>
                    <ZtInput
                      aria-label="模型名称"
                      disabled={testing}
                      value={form.name}
                      onChange={(event) => patchForm({ name: event.currentTarget.value })}
                    />
                  </label>
                  <label>
                    <span>协议类型</span>
                    <ZtSelect
                      ariaLabel="协议类型"
                      value={form.kind}
                      options={providerKindOptions}
                      disabled={testing}
                      onChange={(nextValue) => patchForm({ kind: nextValue as AiProviderKind })}
                    />
                  </label>
                  <label className="zt-model-form-wide">
                    <span>模型 URL</span>
                    <ZtInput
                      aria-label="模型 URL"
                      disabled={testing}
                      value={form.baseUrl}
                      onChange={(event) => patchForm({ baseUrl: event.currentTarget.value })}
                    />
                  </label>
                  <label>
                    <span>模型标识</span>
                    <ZtInput
                      aria-label="模型标识"
                      disabled={testing}
                      value={form.model}
                      onChange={(event) => patchForm({ model: event.currentTarget.value })}
                    />
                  </label>
                  <label>
                    <span>API Key{form.kind === "anthropic" ? "" : "（可选）"}</span>
                    <ZtInput
                      aria-label="API Key"
                      type="password"
                      disabled={testing}
                      placeholder={editingProvider?.api_key_ref ? "留空则保留已保存 Key" : ""}
                      value={form.apiKey}
                      onChange={(event) => patchForm({ apiKey: event.currentTarget.value })}
                    />
                  </label>
                  <div className="zt-model-switch-row">
                    <ZtSwitch label="启用" checked={form.enabled} disabled={testing} onChange={(checked) => patchForm({ enabled: checked })} />
                    <ZtSwitch
                      label="默认模型"
                      checked={form.isDefault}
                      disabled={testing}
                      onChange={(checked) => patchForm({ isDefault: checked })}
                    />
                  </div>
                </div>
              </section>
              <section className="zt-model-test-section" aria-label="模型测试">
                <label className="zt-model-test-input-label">
                  <span>测试输入</span>
                  <div className="zt-ai-prompt zt-model-test-composer">
                    <div className="zt-ai-composer-box zt-model-test-input-box">
                      <textarea
                        aria-label="测试输入"
                        disabled={testing}
                        value={form.testInput}
                        onChange={(event) => patchForm({ testInput: event.currentTarget.value })}
                      />
                      <div className="zt-ai-composer-footer zt-model-test-composer-footer">
                        <span>{testing ? "测试中" : "单轮测试"}</span>
                        {testing ? (
                          <button
                            type="button"
                            className="zt-ai-send is-cancel"
                            aria-label="取消测试"
                            title="取消测试"
                            disabled={!activeTestId}
                            onClick={() => void cancelDraftTest()}
                          >
                            <Square size={14} fill="currentColor" aria-hidden="true" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="zt-ai-send"
                            aria-label="发送测试消息"
                            title="发送测试消息"
                            disabled={loading || saving || !form.testInput.trim()}
                            onClick={() => void startDraftTest()}
                          >
                            <ArrowUp size={18} strokeWidth={2.6} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </label>
                <label className="zt-model-test-output-label">
                  <span>测试输出</span>
                  <ZtTextarea
                    aria-label="测试输出"
                    className="zt-model-test-output"
                    readOnly
                    rows={10}
                    value={testOutput === "" && testing ? "测试中..." : testOutput ?? "等待测试输出"}
                  />
                </label>
              </section>
            </div>
          </form>
        </ZtDialog>
      ) : null}

      {pendingDelete ? (
        <ZtConfirmDialog
          title="删除模型"
          message={`确认删除模型“${pendingDelete.name}”？`}
          confirmLabel="确认删除"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void deleteProvider(pendingDelete)}
        />
      ) : null}

      {contextMenu ? (
        <ZtContextMenu className="zt-context-menu" role="menu" x={contextMenu.x} y={contextMenu.y}>
          {contextMenu.provider ? (
            <>
              <button
                type="button"
                role="menuitem"
                aria-label={`编辑模型 ${contextMenu.provider.name}`}
                onClick={() => {
                  openEditEditor(contextMenu.provider!);
                  setContextMenu(null);
                }}
              >
                编辑
              </button>
              <button
                type="button"
                className="zt-delete-button"
                role="menuitem"
                aria-label={`删除模型 ${contextMenu.provider.name}`}
                onClick={() => {
                  setPendingDelete(contextMenu.provider!);
                  setContextMenu(null);
                }}
              >
                删除
              </button>
            </>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                openCreateEditor();
                setContextMenu(null);
              }}
            >
              新建模型
            </button>
          )}
        </ZtContextMenu>
      ) : null}
    </section>
  );
}

function providerDraftFromProfile(provider: AiProviderProfile, isDefault: boolean): AiProviderProfileDraft {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    base_url: provider.base_url,
    model: provider.model,
    api_key: null,
    api_key_ref: provider.api_key_ref || null,
    enabled: provider.enabled,
    is_default: isDefault,
  };
}
