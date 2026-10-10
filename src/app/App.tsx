import { lazy, Suspense, useEffect, useState } from "react";

import CompressWorkspace from "../features/compress/CompressWorkspace";
import ConvertWorkspace from "../features/convert/ConvertWorkspace";
import LandingHero from "../features/landing/LandingHero";
import ToolPicker, { type Tool } from "../features/landing/ToolPicker";
import MergeWorkspace from "../features/merge/MergeWorkspace";
import SplitWorkspace from "../features/split/SplitWorkspace";
import useScrollReveal from "../shared/ui/useScrollReveal";
import SiteFooter from "./components/SiteFooter";
import SiteHeader from "./components/SiteHeader";
import { toolFromPath, toolHref } from "./toolRoutes";

const Pdf2DocxWorkspace = lazy(
  () => import("../features/pdf2docx/Pdf2DocxWorkspace")
);

export default function App() {
  const [tool, setTool] = useState<Tool>(
    () => toolFromPath(window.location.pathname) ?? "merge"
  );
  const [hasSwitchedTool, setHasSwitchedTool] = useState(false);
  const {
    ref: workspaceRef,
    reveal: workspaceReveal,
    setReveal: setWorkspaceReveal,
  } = useScrollReveal<HTMLDivElement>();

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
      changeTool(nextTool);
    };
    window.addEventListener("popstate", syncTool);
    return () => window.removeEventListener("popstate", syncTool);
  }, [tool, workspaceReveal]);

  function selectTool(nextTool: Tool) {
    const nextPath = toolHref(nextTool);
    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, "", nextPath);
    }
    changeTool(nextTool);
  }

  function changeTool(nextTool: Tool) {
    if (nextTool === tool) return;
    if (workspaceReveal === "waiting") setWorkspaceReveal("play");
    else setHasSwitchedTool(true);
    setTool(nextTool);
  }

  return (
    <div className="app-shell">
      <SiteHeader />

      <main>
        <LandingHero />

        <ToolPicker tool={tool} onSelect={selectTool} hrefForTool={toolHref} />

        <div
          className="workspace"
          id="workspace"
          ref={workspaceRef}
          data-reveal={workspaceReveal}
          data-switch={hasSwitchedTool}
        >
          <div id="merge-panel" hidden={tool !== "merge"}>
            {tool === "merge" && <MergeWorkspace />}
          </div>
          <div id="split-panel" hidden={tool !== "split"}>
            {tool === "split" && <SplitWorkspace />}
          </div>
          <div id="compress-panel" hidden={tool !== "compress"}>
            {tool === "compress" && <CompressWorkspace />}
          </div>
          <div id="convert-panel" hidden={tool !== "convert"}>
            {tool === "convert" && <ConvertWorkspace />}
          </div>
          <div id="pdf2docx-panel" hidden={tool !== "pdf2docx"}>
            {tool === "pdf2docx" && (
              <Suspense fallback={<p role="status">正在載入 PDF2docx…</p>}>
                <Pdf2DocxWorkspace />
              </Suspense>
            )}
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
