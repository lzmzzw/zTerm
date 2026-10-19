// Author: Liz
import { useShallow } from "zustand/react/shallow";
import type { ReactNode } from "react";

import { SplitPaneView } from "../features/terminal-layout/SplitPaneView";
import type { PaneSplitDirection } from "../features/terminal-layout/types";
import { useTerminalLayoutStore } from "../features/terminal-layout/terminalLayoutStore";

interface TerminalLayoutStageProps {
  activePaneTools?: ReactNode;
  sessionLabels?: Record<string, string>;
  onActivatePane: (paneId: string) => void;
  onAddPaneTab: (paneId: string) => void;
  onDuplicatePaneTab: (paneId: string, paneTabId: string) => void;
  onSelectPaneTab: (paneId: string, paneTabId: string) => void;
  onClosePaneTab: (paneId: string, paneTabId: string) => void;
  onMovePaneTab: (sourcePaneId: string, paneTabId: string, targetPaneId: string, beforePaneTabId: string | null) => void;
  onSplitPane: (direction: PaneSplitDirection) => void;
  onResizeSplit?: (splitId: string, ratio: number) => void;
  onClosePane: (paneId: string) => void;
  onDisconnectTerminal?: (paneId: string, paneTabId: string, runtimeSessionId: string) => void;
  onReconnectTerminal?: (paneId: string, paneTabId: string, savedSessionId: string, runtimeSessionId: string | null) => void;
}

export function TerminalLayoutStage({
  activePaneTools,
  sessionLabels,
  onActivatePane,
  onAddPaneTab,
  onDuplicatePaneTab,
  onSelectPaneTab,
  onClosePaneTab,
  onMovePaneTab,
  onSplitPane,
  onResizeSplit,
  onClosePane,
  onDisconnectTerminal,
  onReconnectTerminal,
}: TerminalLayoutStageProps) {
  const { tabs, activeTabId } = useTerminalLayoutStore(
    useShallow((state) => ({ tabs: state.tabs, activeTabId: state.activeTabId })),
  );
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  return (
    <div className="zt-terminal-layout-stage" aria-label="终端舞台">
      {activeTab ? (
        <section
          className="zt-terminal-layout-stage-layer active"
          aria-label="实时工作台视图"
          data-active="true"
        >
          <SplitPaneView
            activePaneTools={activePaneTools}
            sessionLabels={sessionLabels}
            root={activeTab.root}
            activePaneId={activeTab.active_pane_id}
            onActivatePane={onActivatePane}
            onAddPaneTab={onAddPaneTab}
            onDuplicatePaneTab={onDuplicatePaneTab}
            onSelectPaneTab={onSelectPaneTab}
            onClosePaneTab={onClosePaneTab}
            onMovePaneTab={onMovePaneTab}
            onSplitPane={onSplitPane}
            onResizeSplit={onResizeSplit}
            onClosePane={onClosePane}
            onDisconnectTerminal={onDisconnectTerminal}
            onReconnectTerminal={onReconnectTerminal}
            terminalLayoutActive
          />
        </section>
      ) : null}
    </div>
  );
}
