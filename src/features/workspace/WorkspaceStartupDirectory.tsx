// Author: Liz
import { useState } from "react";

import { ZtSelect } from "../../components/ZtSelect";
import { ZtInput } from "../../components/ZtUi";

export function WorkspaceStartupDirectory({ path, defaultDirectory, onChange }: {
  path?: string | null;
  defaultDirectory?: string | null;
  onChange: (path: string | null) => void;
}) {
  const [custom, setCustom] = useState(Boolean(path?.trim()));
  const fallback = defaultDirectory?.trim() || "zTerm 启动时的默认目录";

  return (
    <div className="zt-workspace-startup-directory">
      <label>
        启动目录
        <ZtSelect
          ariaLabel="启动目录来源"
          value={custom ? "custom" : "inherit"}
          options={[
            { value: "inherit", label: "继承连接默认目录" },
            { value: "custom", label: "自定义" },
          ]}
          onChange={(value) => {
            setCustom(value === "custom");
            if (value === "inherit") onChange(null);
          }}
        />
      </label>
      {custom ? (
        <label>
          自定义启动目录
          <ZtInput
            aria-label="编辑启动目录"
            value={path ?? ""}
            placeholder="留空继承连接默认目录"
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      ) : null}
      <p className="zt-workspace-startup-hint" aria-live="polite">
        <span>生效目录：</span><span>{path?.trim() || fallback}</span>
      </p>
      <p className="zt-workspace-startup-hint">仅对当前工作区中的此标签生效，不修改连接默认目录。</p>
    </div>
  );
}
