import PublicIcon from "../../shared/ui/PublicIcon";

export type Tool = "merge" | "split";

type ToolPickerProps = {
  tool: Tool;
  onSelect: (tool: Tool) => void;
};

export default function ToolPicker({ tool, onSelect }: ToolPickerProps) {
  return (
    <section className="tool-section" aria-labelledby="tool-heading">
      <div className="section-heading">
        <div>
          <span className="section-kicker">START HERE</span>
          <h2 id="tool-heading">今天想整理什麼？</h2>
          <p>選擇工具，接著把 PDF 拖進工作區。</p>
        </div>
        <span className="section-aside">
          <PublicIcon name="shield-check" size={17} /> 所有處理都在本機完成
        </span>
      </div>
      <nav className="tool-nav" aria-label="PDF 工具">
        <button
          type="button"
          className={tool === "merge" ? "tool-tab active" : "tool-tab"}
          onClick={() => onSelect("merge")}
          aria-pressed={tool === "merge"}
          aria-controls="merge-panel"
        >
          <span className="tool-tab-icon">
            <PublicIcon name="files" size={25} />
          </span>
          <span className="tool-tab-copy">
            <small>01 / COMBINE</small>
            <strong>合併 PDF</strong>
            <span>多份文件，整理成一份。</span>
          </span>
          <PublicIcon
            name="arrow-up-right"
            size={20}
            className="tool-tab-arrow"
          />
        </button>
        <button
          type="button"
          className={tool === "split" ? "tool-tab active" : "tool-tab"}
          onClick={() => onSelect("split")}
          aria-pressed={tool === "split"}
          aria-controls="split-panel"
        >
          <span className="tool-tab-icon">
            <PublicIcon name="scissors" size={25} />
          </span>
          <span className="tool-tab-copy">
            <small>02 / EXTRACT</small>
            <strong>拆分 PDF</strong>
            <span>挑出頁面，做成新檔案。</span>
          </span>
          <PublicIcon
            name="arrow-up-right"
            size={20}
            className="tool-tab-arrow"
          />
        </button>
      </nav>
    </section>
  );
}
