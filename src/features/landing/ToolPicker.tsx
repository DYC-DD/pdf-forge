import PublicIcon from "../../shared/ui/PublicIcon";
import useScrollReveal from "../../shared/ui/useScrollReveal";

export type Tool = "merge" | "split" | "compress" | "convert";

type ToolPickerProps = {
  tool: Tool;
  onSelect: (tool: Tool) => void;
  hrefForTool: (tool: Tool) => string;
};

export default function ToolPicker({
  tool,
  onSelect,
  hrefForTool,
}: ToolPickerProps) {
  const { ref, reveal } = useScrollReveal<HTMLElement>();

  function handleSelect(
    event: React.MouseEvent<HTMLAnchorElement>,
    nextTool: Tool
  ) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    onSelect(nextTool);
  }

  return (
    <section
      className="tool-section"
      aria-labelledby="tool-heading"
      ref={ref}
      data-reveal={reveal}
    >
      <div className="section-heading">
        <div>
          <span className="section-kicker">START HERE</span>
          <h2 id="tool-heading">今天想整理什麼？</h2>
          <p>選擇工具，接著把檔案拖進工作區。</p>
        </div>
      </div>
      <nav className="tool-nav" aria-label="PDF 工具">
        <a
          href={hrefForTool("merge")}
          className={tool === "merge" ? "tool-tab active" : "tool-tab"}
          onClick={(event) => handleSelect(event, "merge")}
          aria-current={tool === "merge" ? "page" : undefined}
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
        </a>
        <a
          href={hrefForTool("split")}
          className={tool === "split" ? "tool-tab active" : "tool-tab"}
          onClick={(event) => handleSelect(event, "split")}
          aria-current={tool === "split" ? "page" : undefined}
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
        </a>
        <a
          href={hrefForTool("compress")}
          className={tool === "compress" ? "tool-tab active" : "tool-tab"}
          onClick={(event) => handleSelect(event, "compress")}
          aria-current={tool === "compress" ? "page" : undefined}
          aria-controls="compress-panel"
        >
          <span className="tool-tab-icon">
            <PublicIcon name="compress" size={25} />
          </span>
          <span className="tool-tab-copy">
            <small>03 / COMPRESS</small>
            <strong>壓縮 PDF</strong>
            <span>縮小檔案，維持清晰品質。</span>
          </span>
          <PublicIcon
            name="arrow-up-right"
            size={20}
            className="tool-tab-arrow"
          />
        </a>
        <a
          href={hrefForTool("convert")}
          className={tool === "convert" ? "tool-tab active" : "tool-tab"}
          onClick={(event) => handleSelect(event, "convert")}
          aria-current={tool === "convert" ? "page" : undefined}
          aria-controls="convert-panel"
        >
          <span className="tool-tab-icon">
            <PublicIcon name="photo" size={25} />
          </span>
          <span className="tool-tab-copy">
            <small>04 / CONVERT</small>
            <strong>轉換 PDF</strong>
            <span>PDF 與圖片，轉成需要的格式。</span>
          </span>
          <PublicIcon
            name="arrow-up-right"
            size={20}
            className="tool-tab-arrow"
          />
        </a>
      </nav>
    </section>
  );
}
