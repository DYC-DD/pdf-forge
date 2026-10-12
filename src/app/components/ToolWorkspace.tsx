import CircularProgress from "@mui/material/CircularProgress";
import { Component, lazy, Suspense, type ReactNode } from "react";

import type { Tool } from "../../features/landing/ToolPicker";

// Keep lazy components outside render so each tool's module is loaded once.
const workspaces = {
  merge: lazy(() => import("../../features/merge/MergeWorkspace")),
  split: lazy(() => import("../../features/split/SplitWorkspace")),
  compress: lazy(() => import("../../features/compress/CompressWorkspace")),
  convert: lazy(() => import("../../features/convert/ConvertWorkspace")),
};

const labels: Record<Tool, string> = {
  merge: "合併工具",
  split: "拆分工具",
  compress: "壓縮工具",
  convert: "轉換工具",
};

class WorkspaceBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <section className="workspace-card workspace-loading">
          <div className="workspace-loading-content">
            <p role="alert">工具載入失敗，請重新載入頁面後再試。</p>
            <button
              type="button"
              className="button button--outline"
              onClick={() => window.location.reload()}
            >
              重新載入頁面
            </button>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}

export default function ToolWorkspace({ tool }: { tool: Tool }) {
  const Workspace = workspaces[tool];
  return (
    <WorkspaceBoundary key={tool}>
      <Suspense
        fallback={
          <section
            className="workspace-card workspace-loading"
            role="status"
            aria-busy="true"
          >
            <div className="workspace-loading-content">
              <CircularProgress
                className="workspace-loading-spinner"
                color="inherit"
                size={40}
                aria-label={`正在載入${labels[tool]}`}
              />
              <p>正在載入{labels[tool]}…</p>
            </div>
          </section>
        }
      >
        <Workspace />
      </Suspense>
    </WorkspaceBoundary>
  );
}
