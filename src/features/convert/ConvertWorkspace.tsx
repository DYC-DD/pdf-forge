import { useEffect, useRef, useState } from "react";

import { fileError } from "../../shared/pdf/errors";
import ImagesWorkspace from "./ImagesWorkspace";
import { detectSources, imageInputsError } from "./lib/imageSource";
import PdfToImagesWorkspace from "./PdfToImagesWorkspace";

type Source =
  { kind: "pdf"; file: File } | { kind: "images"; files: File[] } | null;

export default function ConvertWorkspace() {
  const [source, setSource] = useState<Source>(null);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    []
  );

  async function chooseFiles(files: File[]) {
    if (!files.length || detecting) return;
    const current = ++generation.current;
    setDetecting(true);
    setError("");
    try {
      const kind = await detectSources(files);
      if (current !== generation.current) return;
      if (kind === "images") {
        const error = imageInputsError(files);
        if (error) throw new Error(error);
        setSource({ kind, files });
      } else {
        const file = files[0];
        // PDF.js and the existing PDF limits expect a PDF filename.
        setSource({
          kind,
          file: /\.pdf$/i.test(file.name)
            ? file
            : new File([file], `${file.name}.pdf`, { type: "application/pdf" }),
        });
      }
    } catch (cause) {
      if (current === generation.current) setError(fileError(cause));
    } finally {
      if (current === generation.current) setDetecting(false);
    }
  }

  function clear() {
    generation.current++;
    setSource(null);
    setError("");
    setDetecting(false);
  }

  return source?.kind === "images" ? (
    <ImagesWorkspace initialFiles={source.files} onClear={clear} />
  ) : (
    <PdfToImagesWorkspace
      file={source?.file ?? null}
      onFiles={(files) => void chooseFiles(files)}
      onClear={clear}
      detecting={detecting}
      intakeError={error}
    />
  );
}
