// Author: Liz
import { ZtSelect } from "../../components/ZtSelect";
import { emptySshContainer as emptyContainer } from "./sshSessionModel";
import type { SshOptions } from "./types";

interface SshContainerSectionProps {
  sshOptions: SshOptions;
  onSshOptionsChange: (options: SshOptions) => void;
}

const containerRuntimeOptions = [
  { value: "docker", label: "Docker" },
  { value: "podman", label: "Podman" },
];

export function SshContainerSection({ sshOptions, onSshOptionsChange }: SshContainerSectionProps) {
  function updateContainer(patch: Partial<NonNullable<SshOptions["container"]>>) {
    onSshOptionsChange({
      ...sshOptions,
      container: {
        ...emptyContainer(),
        ...(sshOptions.container ?? {}),
        ...patch,
      },
    });
  }

  return (
    <section className="zt-session-form-section zt-session-form-wide" aria-label="容器">
      <div className="zt-session-form-section-title">容器</div>
      <label className="zt-session-checkbox">
        <input
          aria-label="启用容器"
          type="checkbox"
          checked={sshOptions.container?.enabled ?? false}
          onChange={(event) => updateContainer({ enabled: event.currentTarget.checked })}
        />
        <span>连接后进入容器</span>
      </label>
      <div className="zt-session-form-grid zt-session-nested-grid">
        <label>
          <span>运行时</span>
          <ZtSelect
            ariaLabel="容器运行时"
            value={sshOptions.container?.runtime ?? "docker"}
            options={containerRuntimeOptions}
            onChange={(nextValue) => updateContainer({ runtime: nextValue })}
          />
        </label>
        <label>
          <span>容器</span>
          <input
            aria-label="容器"
            value={sshOptions.container?.container ?? ""}
            onChange={(event) => updateContainer({ container: event.currentTarget.value.trim() })}
            placeholder="容器 ID 或名称"
          />
        </label>
        <label>
          <span>Shell</span>
          <input
            aria-label="容器 Shell"
            value={sshOptions.container?.shell ?? ""}
            onChange={(event) => updateContainer({ shell: event.currentTarget.value.trim() || null })}
            placeholder="/bin/sh"
          />
        </label>
        <label>
          <span>User</span>
          <input
            aria-label="容器用户"
            value={sshOptions.container?.user ?? ""}
            onChange={(event) => updateContainer({ user: event.currentTarget.value.trim() || null })}
          />
        </label>
        <label className="zt-session-form-wide">
          <span>Workdir</span>
          <input
            aria-label="容器工作目录"
            value={sshOptions.container?.workdir ?? ""}
            onChange={(event) => updateContainer({ workdir: event.currentTarget.value.trim() || null })}
            placeholder="/app"
          />
        </label>
      </div>
    </section>
  );
}
