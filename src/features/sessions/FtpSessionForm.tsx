// Author: Liz
import { useState } from "react";

import { ZtNumberInput } from "../../components/ZtNumberInput";
import { ZtInput, ZtSwitch } from "../../components/ZtUi";
import { SshSecretInput } from "./SshSecretInput";
import type { FtpOptions } from "./types";

interface FtpSessionFormProps {
  section: string;
  password: string;
  hasSavedPassword: boolean;
  options: FtpOptions;
  onPasswordChange: (password: string) => void;
  onOptionsChange: (options: FtpOptions) => void;
  onRevealPassword?: () => Promise<boolean> | boolean;
}

export function FtpSessionForm({ section, password, hasSavedPassword, options, onPasswordChange, onOptionsChange, onRevealPassword }: FtpSessionFormProps) {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="zt-session-form-grid" data-session-form="ftp">
      {section === "属性" ? (
        <>
          <label>
            <span>密码</span>
            <SshSecretInput label="密码" value={password} maskedPlaceholder={hasSavedPassword} visible={showPassword} onVisibleChange={setShowPassword} onChange={onPasswordChange} onReveal={onRevealPassword} />
          </label>
          <label>
            <span>初始远程目录</span>
            <ZtInput aria-label="初始远程目录" value={options.initial_directory ?? "/"} onChange={(event) => onOptionsChange({ ...options, initial_directory: event.currentTarget.value })} />
          </label>
          <div>
            <ZtSwitch
              label="匿名登录"
              ariaLabel="匿名登录"
              checked={options.anonymous}
              onChange={(anonymous) => onOptionsChange({ ...options, anonymous })}
            />
          </div>
        </>
      ) : null}
      {section === "高级" ? (
        <>
          <label>
            <span>连接超时(ms)</span>
            <ZtNumberInput ariaLabel="连接超时" min={1000} max={300000} step={1000} value={options.connect_timeout_ms ?? 30000} onChange={(value) => onOptionsChange({ ...options, connect_timeout_ms: value })} />
          </label>
          <div>
            <ZtSwitch
              label="被动模式"
              ariaLabel="被动模式"
              checked={options.passive_mode}
              onChange={(passive_mode) => onOptionsChange({ ...options, passive_mode })}
            />
          </div>
          <p className="zt-session-form-wide zt-session-security-hint">FTP 不加密账号、密码和传输内容；敏感环境请使用 SFTP。</p>
        </>
      ) : null}
    </div>
  );
}
