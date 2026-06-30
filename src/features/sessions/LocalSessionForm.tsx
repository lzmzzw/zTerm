// Author: Liz
import { Plus, Trash2 } from "lucide-react";

import { ZtSelect } from "../../components/ZtSelect";
import type { LocalOptions } from "./types";
import type { TerminalProfile } from "../settings/settingsStore";

interface LocalSessionFormProps {
  section: string;
  options: LocalOptions;
  terminalProfiles: TerminalProfile[];
  onOptionsChange: (options: LocalOptions) => void;
}

export function LocalSessionForm({ section, options, terminalProfiles, onOptionsChange }: LocalSessionFormProps) {
  return (
    <div className="zt-session-form-grid" data-session-form="local">
      {section === "属性" ? (
        <>
          <label>
            <span>终端 Profile</span>
            <ZtSelect
              ariaLabel="终端 Profile"
              value={options.profile_id ?? ""}
              placeholder="使用默认终端"
              options={[
                { value: "", label: "使用默认终端" },
                ...terminalProfiles.map((profile) => ({ value: profile.id, label: profile.name })),
              ]}
              searchable
              onChange={(nextValue) =>
                onOptionsChange({
                  ...options,
                  profile_id: nextValue || null,
                })
              }
            />
          </label>
          <label className="zt-session-form-wide">
            <span>工作目录</span>
            <input
              aria-label="工作目录"
              value={options.working_directory ?? ""}
              onChange={(event) =>
                onOptionsChange({
                  ...options,
                  working_directory: event.currentTarget.value.trim() || null,
                })
              }
              placeholder="留空使用终端默认目录"
            />
          </label>
        </>
      ) : null}
      {section === "环境变量" ? (
        <div className="zt-session-form-wide zt-ssh-tunnel-editor" aria-label="环境变量">
          <div className="zt-ssh-tunnel-header">
            <span>环境变量</span>
            <button
              type="button"
              onClick={() =>
                onOptionsChange({
                  ...options,
                  environment: [...(options.environment ?? []), { name: "", value: "" }],
                })
              }
            >
              <Plus size={14} aria-hidden="true" />
              添加
            </button>
          </div>
          {(options.environment ?? []).length === 0 ? <div className="zt-empty-line">暂无环境变量</div> : null}
          {(options.environment ?? []).map((variable, index) => (
            <div className="zt-env-row" key={index}>
              <input
                aria-label="环境变量名"
                value={variable.name}
                onChange={(event) => {
                  const environment = [...(options.environment ?? [])];
                  environment[index] = { ...variable, name: event.currentTarget.value.trim() };
                  onOptionsChange({ ...options, environment });
                }}
                placeholder="NAME"
              />
              <input
                aria-label="环境变量值"
                value={variable.value}
                onChange={(event) => {
                  const environment = [...(options.environment ?? [])];
                  environment[index] = { ...variable, value: event.currentTarget.value };
                  onOptionsChange({ ...options, environment });
                }}
                placeholder="value"
              />
              <button
                type="button"
                aria-label="删除环境变量"
                onClick={() =>
                  onOptionsChange({
                    ...options,
                    environment: (options.environment ?? []).filter((_, itemIndex) => itemIndex !== index),
                  })
                }
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
