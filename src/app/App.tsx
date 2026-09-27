import { lazy, Suspense, useEffect, useState } from "react";

import LandingHero from "../features/landing/LandingHero";
import ToolPicker, { type Tool } from "../features/landing/ToolPicker";
import MergeWorkspace from "../features/merge/MergeWorkspace";
import SplitWorkspace from "../features/split/SplitWorkspace";
import SiteFooter from "./components/SiteFooter";
import SiteHeader from "./components/SiteHeader";
import { toolFromPath, toolHref } from "./toolRoutes";

const CompressWorkspace = lazy(
  () => import("../features/compress/CompressWorkspace")
);

export default function App() {
  const [tool, setTool] = useState<Tool>(
    () => toolFromPath(window.location.pathname) ?? "merge"
  );
  const [compressVisited, setCompressVisited] = useState(
    () => toolFromPath(window.location.pathname) === "compress"
  );

  useEffect(() => {
    if (window.location.hash === "#top") {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + window.location.search
      );
    }

    const syncTool = () => {
      const nextTool = toolFromPath(window.location.pathname) ?? "merge";
      setTool(nextTool);
      if (nextTool === "compress") setCompressVisited(true);
    };
    window.addEventListener("popstate", syncTool);
    return () => window.removeEventListener("popstate", syncTool);
  }, []);

  function selectTool(nextTool: Tool) {
    const nextPath = toolHref(nextTool);
    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, "", nextPath);
    }
    setTool(nextTool);
    if (nextTool === "compress") setCompressVisited(true);
  }

  return (
    <div className="app-shell">
      <SiteHeader />

      <main>
        <LandingHero />

        <ToolPicker tool={tool} onSelect={selectTool} hrefForTool={toolHref} />

        <div className="workspace" id="workspace">
          <div id="merge-panel" hidden={tool !== "merge"}>
            <MergeWorkspace />
          </div>
          <div id="split-panel" hidden={tool !== "split"}>
            <SplitWorkspace />
          </div>
          <div id="compress-panel" hidden={tool !== "compress"}>
            {compressVisited && (
              <Suspense
                fallback={
                  <div className="loading-panel">正在載入壓縮工具…</div>
                }
              >
                <CompressWorkspace />
              </Suspense>
            )}
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
