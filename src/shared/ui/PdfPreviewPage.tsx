import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";

import { fileError } from "../pdf/errors";
import { configurePreviewCanvas } from "../pdf/previewCanvas";

type RenderTask = ReturnType<
  Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]
>;

export default function PdfPreviewPage({
  pdf,
  pageNumber,
  scale,
  maxWidth,
  estimatedHeight,
  scrollRoot,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  maxWidth: number;
  estimatedHeight: number;
  scrollRoot: HTMLDivElement | null;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [visible, setVisible] = useState(false);
  const [size, setSize] = useState({
    width: maxWidth,
    height: estimatedHeight,
  });
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setSize({ width: maxWidth, height: estimatedHeight });
  }, [maxWidth, estimatedHeight]);

  useEffect(() => {
    const element = sectionRef.current;
    if (!element || !scrollRoot) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { root: scrollRoot, rootMargin: "600px 0px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    setRendering(true);
    setError("");

    async function paint() {
      const page = await pdf.getPage(pageNumber);
      try {
        if (cancelled) return;
        const original = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: Math.min(scale, maxWidth / original.width),
        });
        const canvas = canvasRef.current;
        if (!canvas) throw new Error("無法建立 PDF 預覽畫面。");
        const transform = configurePreviewCanvas(
          canvas,
          viewport,
          window.devicePixelRatio
        );
        setSize({ width: viewport.width, height: viewport.height });
        const context = canvas.getContext("2d");
        if (!context) throw new Error("無法建立 PDF 預覽畫面。");
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform,
        });
        await renderTask.promise;
      } finally {
        page.cleanup();
      }
    }

    const operation = renderQueueRef.current.then(() => {
      if (!cancelled) return paint();
    });
    renderQueueRef.current = operation.catch(() => {});
    operation
      .catch((cause) => {
        if (!cancelled) setError(fileError(cause));
      })
      .finally(() => {
        if (!cancelled) setRendering(false);
      });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdf, pageNumber, scale, maxWidth, visible]);

  return (
    <section
      ref={sectionRef}
      className="pdf-preview-page"
      data-page-number={pageNumber}
      aria-label={`第 ${pageNumber} 頁`}
      aria-busy={visible && rendering}
      style={{ width: size.width, height: size.height }}
    >
      {visible && (
        <canvas
          key={`${pageNumber}-${scale}`}
          ref={canvasRef}
          aria-label={`第 ${pageNumber} 頁預覽`}
        />
      )}
      {visible && rendering && !error && (
        <span className="pdf-preview-page-status">
          正在載入第 {pageNumber} 頁…
        </span>
      )}
      {error && (
        <span
          className="pdf-preview-page-status pdf-preview-page-status--error"
          role="alert"
        >
          {error}
        </span>
      )}
    </section>
  );
}
