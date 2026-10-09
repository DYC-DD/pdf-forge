import { useEffect, useState } from "react";

export type ViewMode = "list" | "grid" | "grid-medium" | "grid-small";

const storageKey = "pdf-forge:view-mode";

export default function useViewMode() {
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (
        saved === "list" ||
        saved === "grid" ||
        saved === "grid-medium" ||
        saved === "grid-small"
      )
        return saved;
    } catch {
      // Display switching still works when browser storage is unavailable.
    }
    return "list";
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, viewMode);
    } catch {
      // Remembering the preference is optional.
    }
  }, [viewMode]);

  return [viewMode, setViewMode] as const;
}
