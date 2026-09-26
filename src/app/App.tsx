import { useState } from "react";

import LandingHero from "../features/landing/LandingHero";
import ToolPicker, { type Tool } from "../features/landing/ToolPicker";
import MergeWorkspace from "../features/merge/MergeWorkspace";
import SplitWorkspace from "../features/split/SplitWorkspace";
import SiteFooter from "./components/SiteFooter";
import SiteHeader from "./components/SiteHeader";

export default function App() {
  const [tool, setTool] = useState<Tool>("merge");

  return (
    <div className="app-shell">
      <SiteHeader />

      <main id="top">
        <LandingHero />

        <ToolPicker tool={tool} onSelect={setTool} />

        <div className="workspace" id="workspace">
          <div id="merge-panel" hidden={tool !== "merge"}>
            <MergeWorkspace />
          </div>
          <div id="split-panel" hidden={tool !== "split"}>
            <SplitWorkspace />
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
