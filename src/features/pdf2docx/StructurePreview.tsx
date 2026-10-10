import { useEffect, useState } from "react";

import type { FlowBlock, ImageBlock, PageModel, Paragraph } from "./types";

function ParagraphPreview({ paragraph }: { paragraph: Paragraph }) {
  return (
    <div className="pdf2docx-paragraph-group">
      {paragraph.floatingImages?.map((figure) => (
        <div
          key={figure.id}
          className="pdf2docx-wrapped-figure"
          style={{ float: figure.x > paragraph.x ? "right" : "left" }}
        >
          <FigurePreview figure={figure} />
        </div>
      ))}
      <p className={`pdf2docx-paragraph pdf2docx-paragraph--${paragraph.role}`}>
        {paragraph.runs.map((run, index) => (
          <span
            key={index}
            style={{
              fontWeight: run.bold ? 700 : undefined,
              fontStyle: run.italic ? "italic" : undefined,
              color: run.color ? `#${run.color}` : undefined,
              textDecoration: run.underline ? "underline" : undefined,
            }}
          >
            {run.breakBefore && <br />}
            {run.tabBefore !== undefined && "　"}
            {run.text}
          </span>
        ))}
      </p>
    </div>
  );
}

function FigurePreview({ figure }: { figure: ImageBlock }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const next = URL.createObjectURL(
      new Blob([new Uint8Array(figure.data)], { type: "image/png" })
    );
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [figure]);
  return url ? (
    <img className="pdf2docx-figure" src={url} alt="從原稿保留的圖片" />
  ) : null;
}

function BlockPreview({ block }: { block: FlowBlock }) {
  if (block.kind === "paragraph") return <ParagraphPreview paragraph={block} />;
  if (block.kind === "image") return <FigurePreview figure={block} />;
  if (block.kind === "image-row")
    return (
      <div
        className="pdf2docx-image-row"
        style={{
          gridTemplateColumns: block.images
            .map((image) => `${image.width}fr`)
            .join(" "),
        }}
      >
        {block.images.map((image) => (
          <FigurePreview key={image.id} figure={image} />
        ))}
      </div>
    );
  if (block.kind === "rule")
    return (
      <hr
        style={{
          border: 0,
          borderTop: `${block.thickness}px solid #${block.color}`,
        }}
      />
    );
  return (
    <div className="pdf2docx-table-scroll">
      <table className="pdf2docx-table">
        <tbody>
          {block.rows.map((_, row) => (
            <tr key={row}>
              {block.cells
                .filter((cell) => cell.row === row)
                .sort((a, b) => a.column - b.column)
                .map((cell) => (
                  <td
                    key={cell.column}
                    rowSpan={cell.rowSpan}
                    colSpan={cell.columnSpan}
                    style={{
                      backgroundColor: cell.fill ? `#${cell.fill}` : undefined,
                    }}
                  >
                    {cell.paragraphs.map((paragraph, index) => (
                      <ParagraphPreview key={index} paragraph={paragraph} />
                    ))}
                  </td>
                ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function StructurePreview({ page }: { page: PageModel }) {
  return (
    <div
      className="pdf2docx-paper"
      aria-label={`原稿第 ${page.number} 頁的內容結構`}
    >
      {page.groups.map((group, index) => (
        <div
          key={index}
          className={`pdf2docx-flow ${group.columns.length > 1 ? "pdf2docx-flow--columns" : ""}`}
          style={{
            gridTemplateColumns: group.widths
              ?.map((width) => `${width}fr`)
              .join(" "),
          }}
        >
          {group.columns.map((column, columnIndex) => (
            <div key={columnIndex}>
              {column.map((block, blockIndex) => (
                <BlockPreview key={blockIndex} block={block} />
              ))}
            </div>
          ))}
        </div>
      ))}
      {!!page.overlays?.length && (
        <div className="pdf2docx-overlays">
          <p className="pdf2docx-paragraph">原稿圖章、浮水印與頁面圖像</p>
          {page.overlays.map((figure) => (
            <FigurePreview key={figure.id} figure={figure} />
          ))}
        </div>
      )}
      {!page.characters && !page.classification?.images && (
        <p className="pdf2docx-paragraph">此頁沒有可讀取的文字。</p>
      )}
    </div>
  );
}
