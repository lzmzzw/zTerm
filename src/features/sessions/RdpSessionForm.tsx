// Author: Liz
import { useState } from "react";

import { ZtNumberInput } from "../../components/ZtNumberInput";
import { ZtSelect } from "../../components/ZtSelect";
import { SshSecretInput } from "./SshSecretInput";
import type { RdpOptions } from "./types";

const colorDepthOptions = [
  { value: "16", label: "16 bit" },
  { value: "24", label: "24 bit" },
  { value: "32", label: "32 bit" },
];

interface RdpSessionFormProps {
  section: string;
  password: string;
  options: RdpOptions;
  hasSavedPassword?: boolean;
  onOptionsChange: (options: RdpOptions) => void;
  onPasswordChange: (password: string) => void;
  onRevealPassword?: () => Promise<boolean> | boolean;
}

export function RdpSessionForm({
  section,
  password,
  options,
  hasSavedPassword = false,
  onOptionsChange,
  onPasswordChange,
  onRevealPassword,
}: RdpSessionFormProps) {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="zt-session-form-grid" data-session-form="rdp">
      {section === "连接属性" ? (
        <section className="zt-session-form-section zt-session-form-wide" aria-label="连接属性">
          <div className="zt-session-form-section-title">连接属性</div>
          <div className="zt-session-form-grid zt-session-nested-grid">
            <label>
              <span>域</span>
              <input
                aria-label="域"
                value={options.domain ?? ""}
                onChange={(event) =>
                  onOptionsChange({
                    ...options,
                    domain: event.currentTarget.value.trim() || null,
                  })
                }
              />
            </label>
            <label>
              <span>密码</span>
              <SshSecretInput
                label="密码"
                value={password}
                maskedPlaceholder={hasSavedPassword}
                visible={showPassword}
                onVisibleChange={setShowPassword}
                onChange={onPasswordChange}
                onReveal={onRevealPassword}
              />
            </label>
          </div>
        </section>
      ) : null}
      {section === "显示属性" ? (
        <section className="zt-session-form-section zt-session-form-wide" aria-label="显示属性">
          <div className="zt-session-form-section-title">显示属性</div>
          <div className="zt-session-form-grid zt-session-nested-grid">
            <label>
              <span>宽度</span>
              <ZtNumberInput
                ariaLabel="宽度"
                min={800}
                max={7680}
                step={10}
                value={options.width}
                onChange={(value) => onOptionsChange({ ...options, width: value })}
              />
            </label>
            <label>
              <span>高度</span>
              <ZtNumberInput
                ariaLabel="高度"
                min={600}
                max={4320}
                step={10}
                value={options.height}
                onChange={(value) => onOptionsChange({ ...options, height: value })}
              />
            </label>
            <label>
              <span>色深</span>
              <ZtSelect
                ariaLabel="色深"
                value={String(options.color_depth)}
                options={colorDepthOptions}
                onChange={(nextValue) =>
                  onOptionsChange({
                    ...options,
                    color_depth: Number(nextValue) as RdpOptions["color_depth"],
                  })
                }
              />
            </label>
            <label className="zt-session-checkbox">
              <input
                aria-label="全屏"
                type="checkbox"
                checked={options.fullscreen ?? false}
                onChange={(event) =>
                  onOptionsChange({
                    ...options,
                    fullscreen: event.currentTarget.checked,
                  })
                }
              />
              <span>全屏</span>
            </label>
            <label className="zt-session-checkbox">
              <input
                aria-label="剪贴板重定向"
                type="checkbox"
                checked={options.redirect_clipboard}
                onChange={(event) =>
                  onOptionsChange({
                    ...options,
                    redirect_clipboard: event.currentTarget.checked,
                  })
                }
              />
              <span>剪贴板重定向</span>
            </label>
          </div>
        </section>
      ) : null}
    </div>
  );
}
