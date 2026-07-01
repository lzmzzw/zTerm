// Author: Liz
import { Pencil, Plus, Save, Star, TestTube2, Trash2 } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";

import { ZtSelect } from "../../components/ZtSelect";
import {
  ZtButton,
  ZtConfirmDialog,
  ZtDialog,
  ZtFloatingSurface,
  ZtInput,
  ZtSwitch,
  ZtTextarea,
} from "../../components/ZtUi";
import { unknownErrorMessage } from "../../lib/unknownErrorMessage";
import type {
  AiProviderDraftTestRequest,
  AiProviderDraftTestResult,
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
  onTestProviderDraft: (request: AiProviderDraftTestRequest) => Promise<AiProviderDraftTestResult> | AiProviderDraftTestResult;
}

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
  onTestProviderDraft,
}: ModelManagerPanelProps) {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editorOpen, setEditorOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [testOutput, setTestOutput] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AiProviderProfile | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const editorFormId = useId();

  const editingProvider = providers.find((provider) => provider.id === form.id) ?? null;
  const isEditing = Boolean(form.id);

  function patchForm(patch: Partial<FormState>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function openCreateEditor() {
    setForm({ ...emptyForm, testInput: form.testInput.trim() ? form.testInput : emptyForm.testInput });
    setEditorOpen(true);
    setMessage(null);
    setFormError(null);
    setTestOutput(null);
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
    } catch (saveError) {
      setFormError(unknownErrorMessage(saveError, "保存模型失败", panelErrorMessageOptions));
    } finally {
      setSaving(false);
    }
  }

  async function testDraft() {
    const draft = buildDraft();
    const prompt = form.testInput.trim();
    if (!draft) return;
    if (!prompt) {
      setFormError("请填写测试输入");
      return;
    }
    setTesting(true);
    setFormError(null);
    setMessage(null);
    setTestOutput("测试中...");
    try {
      const result = await onTestProviderDraft({ draft, prompt });
      setMessage(result.message || "模型测试通过");
      setTestOutput(result.output || "模型未返回文本");
    } catch (testError) {
      const message = unknownErrorMessage(testError, "测试模型失败", panelErrorMessageOptions);
      setFormError(message);
      setTestOutput(message);
    } finally {
      setTesting(false);
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

  return (
    <section
      className="zt-model-panel"
      aria-label="模型管理"
      onContextMenu={(event) => {
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="zt-panel-header">
        <span>模型</span>
        <div className="zt-panel-header-action">
          <button type="button" aria-label="新增模型" title="新增模型" onClick={openCreateEditor}>
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
            <div className={provider.is_default ? "zt-model-row default" : "zt-model-row"} key={provider.id}>
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
              <button type="button" aria-label={`编辑模型 ${provider.name}`} title="编辑" onClick={() => openEditEditor(provider)}>
                <Pencil size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`删除模型 ${provider.name}`}
                title="删除"
                onClick={() => setPendingDelete(provider)}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {editorOpen ? (
        <ZtDialog
          ariaLabel="模型配置"
          title={isEditing ? "编辑模型" : "新增模型"}
          size="medium"
          className="zt-model-dialog"
          bodyClassName="zt-model-dialog-body"
          onClose={closeEditor}
          closeLabel="关闭模型配置"
          footer={
            <>
              <ZtButton disabled={testing || loading} onClick={() => void testDraft()}>
                <TestTube2 size={14} aria-hidden="true" />
                {testing ? "测试中" : "测试模型"}
              </ZtButton>
              <ZtButton form={editorFormId} type="submit" disabled={saving || loading} variant="primary">
                <Save size={14} aria-hidden="true" />
                {saving ? "保存中" : "保存模型"}
              </ZtButton>
            </>
          }
        >
          <form id={editorFormId} className="zt-model-form" onSubmit={(event) => void saveProvider(event)}>
            {formError ? <p className="zt-session-error">{formError}</p> : null}
            {message ? <p className="zt-settings-status">{message}</p> : null}
            <label>
              <span>模型名称</span>
              <ZtInput aria-label="模型名称" value={form.name} onChange={(event) => patchForm({ name: event.currentTarget.value })} />
            </label>
            <label>
              <span>协议类型</span>
              <ZtSelect
                ariaLabel="协议类型"
                value={form.kind}
                options={providerKindOptions}
                onChange={(nextValue) => patchForm({ kind: nextValue as AiProviderKind })}
              />
            </label>
            <label>
              <span>模型 URL</span>
              <ZtInput aria-label="模型 URL" value={form.baseUrl} onChange={(event) => patchForm({ baseUrl: event.currentTarget.value })} />
            </label>
            <label>
              <span>模型标识</span>
              <ZtInput aria-label="模型标识" value={form.model} onChange={(event) => patchForm({ model: event.currentTarget.value })} />
            </label>
            <label>
              <span>API Key{form.kind === "anthropic" ? "" : "（可选）"}</span>
              <ZtInput
                aria-label="API Key"
                type="password"
                placeholder={editingProvider?.api_key_ref ? "留空则保留已保存 Key" : ""}
                value={form.apiKey}
                onChange={(event) => patchForm({ apiKey: event.currentTarget.value })}
              />
            </label>
            <ZtSwitch label="启用" checked={form.enabled} onChange={(checked) => patchForm({ enabled: checked })} />
            <ZtSwitch label="默认模型" checked={form.isDefault} onChange={(checked) => patchForm({ isDefault: checked })} />
            <label>
              <span>测试输入</span>
              <ZtTextarea
                aria-label="测试输入"
                rows={4}
                value={form.testInput}
                onChange={(event) => patchForm({ testInput: event.currentTarget.value })}
              />
            </label>
            <label>
              <span>测试输出</span>
              <ZtTextarea
                aria-label="测试输出"
                className="zt-model-test-output"
                readOnly
                rows={5}
                value={testOutput ?? "等待测试输出"}
              />
            </label>
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
        <ZtFloatingSurface className="zt-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button type="button" role="menuitem" onClick={openCreateEditor}>
            新建模型
          </button>
        </ZtFloatingSurface>
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
