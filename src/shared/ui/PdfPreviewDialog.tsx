import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import { fileError } from "../pdf/errors";
import { openPdf } from "../pdf/preview";
import PdfPreviewPage from "./PdfPreviewPage";

export default function PdfPreviewDialog({
  file,
  pdf,
  initialPage = 1,
  onClose,
}: {
  file: File;
  pdf?: PDFDocumentProxy;
  initialPage?: number;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const initialScrollDone = useRef(false);
  const [documentPdf, setDocumentPdf] = useState<PDFDocumentProxy | null>(
    pdf ?? null
  );
  const [firstPageSize, setFirstPageSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [viewportSize, setViewportSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [loading, setLoading] = useState(!pdf);
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    dialog?.showModal();
    return () => {
      dialog?.close();
      document.documentElement.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    function updateSize() {
      setViewportSize({ width: window.innerWidth, height: window.innerHeight });
    }
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  useEffect(() => {
    if (pdf) {
      setDocumentPdf(pdf);
      return;
    }

    let cancelled = false;
    let task: PDFDocumentLoadingTask | undefined;
    openPdf(file)
      .then(async (openedTask) => {
        task = openedTask;
        if (cancelled) {
          await openedTask.destroy();
          return;
        }
        const document = await openedTask.promise;
        if (!cancelled) setDocumentPdf(document);
      })
      .catch((cause) => {
        if (!cancelled) setError(fileError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (task) void task.destroy();
    };
  }, [file, pdf]);

  useEffect(() => {
    if (!documentPdf) return;
    let cancelled = false;
    documentPdf
      .getPage(1)
      .then((page) => {
        const viewport = page.getViewport({ scale: 1 });
        if (!cancelled)
          setFirstPageSize({ width: viewport.width, height: viewport.height });
      })
      .catch((cause) => {
        if (!cancelled) setError(fileError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [documentPdf]);

  const layout =
    documentPdf && firstPageSize
      ? (() => {
          const outerGap = viewportSize.width <= 560 ? 12 : 24;
          const maxPageWidth = Math.max(1, viewportSize.width - outerGap - 34);
          const maxPageHeight = Math.max(
            1,
            viewportSize.height - outerGap - 154
          );
          const scale = Math.min(
            1.5,
            maxPageWidth / firstPageSize.width,
            maxPageHeight / firstPageSize.height
          );
          const pageWidth = firstPageSize.width * scale;
          const pageHeight = firstPageSize.height * scale;
          const contentHeight =
            pageHeight * documentPdf.numPages +
            16 * Math.max(0, documentPdf.numPages - 1) +
            154;
          return {
            scale,
            pageWidth,
            pageHeight,
            dialogHeight: Math.min(
              viewportSize.height - outerGap,
              contentHeight
            ),
          };
        })()
      : null;

  function scrollToPage(
    pageNumber: number,
    behavior: ScrollBehavior = "smooth"
  ) {
    const viewer = viewerRef.current;
    const page = viewer?.querySelector<HTMLElement>(
      `[data-page-number="${pageNumber}"]`
    );
    if (!viewer || !page) return;
    viewer.scrollTo({ top: Math.max(0, page.offsetTop - 16), behavior });
    setCurrentPage(pageNumber);
  }

  useEffect(() => {
    if (!documentPdf || !layout || initialScrollDone.current) return;
    const frame = requestAnimationFrame(() => {
      scrollToPage(Math.min(initialPage, documentPdf.numPages), "instant");
      initialScrollDone.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [documentPdf, layout?.pageWidth, layout?.pageHeight, initialPage]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!documentPdf || !layout || !viewer) return;
    const visibleHeights = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const number = Number(
            (entry.target as HTMLElement).dataset.pageNumber
          );
          visibleHeights.set(
            number,
            entry.isIntersecting ? entry.intersectionRect.height : 0
          );
        }
        let mostVisible = 0;
        let current = 0;
        for (const [number, height] of visibleHeights) {
          if (height > mostVisible) {
            mostVisible = height;
            current = number;
          }
        }
        if (current) setCurrentPage(current);
      },
      { root: viewer, threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    viewer
      .querySelectorAll(".pdf-preview-page")
      .forEach((page) => observer.observe(page));
    return () => observer.disconnect();
  }, [documentPdf, layout?.pageWidth, layout?.pageHeight]);

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (!documentPdf) return;
    if (event.key === "ArrowLeft" && currentPage > 1) {
      event.preventDefault();
      scrollToPage(currentPage - 1);
    } else if (
      event.key === "ArrowRight" &&
      currentPage < documentPdf.numPages
    ) {
      event.preventDefault();
      scrollToPage(currentPage + 1);
    }
  }

  const dialogStyle = layout
    ? ({
        "--preview-page-width": `${layout.pageWidth}px`,
        "--preview-dialog-height": `${layout.dialogHeight}px`,
      } as CSSProperties)
    : undefined;

  return createPortal(
    <dialog
      ref={dialogRef}
      className="pdf-preview-dialog"
      style={dialogStyle}
      aria-label={`${file.name} PDF 預覽`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="pdf-preview-panel">
        <header className="pdf-preview-header">
          <div className="pdf-preview-title">
            <strong title={file.name}>{file.name}</strong>
            {documentPdf && (
              <span>
                第 {currentPage} / {documentPdf.numPages} 頁
              </span>
            )}
          </div>
          <button
            type="button"
            className="pdf-preview-close"
            aria-label="關閉 PDF 預覽"
            title="關閉預覽 (Esc)"
            onClick={onClose}
            autoFocus
          >
            <X size={20} />
          </button>
        </header>
        <div className="pdf-preview-viewer" ref={viewerRef}>
          {documentPdf && layout && (
            <div className="pdf-preview-pages">
              {Array.from({ length: documentPdf.numPages }, (_, index) => (
                <PdfPreviewPage
                  key={index + 1}
                  pdf={documentPdf}
                  pageNumber={index + 1}
                  scale={layout.scale}
                  maxWidth={layout.pageWidth}
                  estimatedHeight={layout.pageHeight}
                  scrollRoot={viewerRef.current}
                />
              ))}
            </div>
          )}
          {(loading || (!layout && !error)) && (
            <span className="pdf-preview-status" role="status">
              正在載入預覽…
            </span>
          )}
          {error && (
            <span
              className="pdf-preview-status pdf-preview-status--error"
              role="alert"
            >
              {error}
            </span>
          )}
        </div>
        <footer className="pdf-preview-footer">
          <button
            type="button"
            onClick={() => scrollToPage(currentPage - 1)}
            disabled={!documentPdf || currentPage === 1}
          >
            <ChevronUp size={19} /> 上一頁
          </button>
          <span>
            {documentPdf
              ? `${currentPage} / ${documentPdf.numPages}`
              : "PDF 預覽"}
          </span>
          <button
            type="button"
            onClick={() => scrollToPage(currentPage + 1)}
            disabled={!documentPdf || currentPage === documentPdf.numPages}
          >
            下一頁 <ChevronDown size={19} />
          </button>
        </footer>
      </div>
    </dialog>,
    document.body
  );
}
