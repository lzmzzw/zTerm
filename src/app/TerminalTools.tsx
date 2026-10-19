// Author: Liz
import { Activity, Box, Cable, Clock3, Folder, type LucideIcon } from "lucide-react";

import { t } from "../features/settings/i18n";
import type { AppLanguage } from "../features/settings/settingsStore";
import { ToolButton } from "./ShellControls";
import { rightToolLabelKey, visibleRightTools, type ActiveConnectionKind, type RightTool } from "./rightTools";

const icons: Record<Exclude<RightTool, "agent">, LucideIcon> = {
  monitor: Activity,
  history: Clock3,
  files: Folder,
  containers: Box,
  tunnels: Cable,
};

export function TerminalTools({
  activeTool,
  connectionKind,
  language,
  onToolChange,
}: {
  activeTool: RightTool | null;
  connectionKind: ActiveConnectionKind;
  language: AppLanguage;
  onToolChange: (tool: RightTool) => void;
}) {
  return (
    <nav className="zt-terminal-tools" aria-label="终端工具" onClick={(event) => event.stopPropagation()}>
      {visibleRightTools(connectionKind).filter((tool) => tool !== "agent").map((tool) => {
        const Icon = icons[tool];
        return (
          <ToolButton
            key={tool}
            label={t(language, rightToolLabelKey(tool))}
            active={activeTool === tool}
            icon={<Icon size={20} aria-hidden="true" />}
            onClick={() => onToolChange(tool)}
          />
        );
      })}
    </nav>
  );
}
