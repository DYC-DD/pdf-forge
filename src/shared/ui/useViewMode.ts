import { useEffect, useState } from "react";

export type ViewMode = "list" | "grid" | "grid-small";

export default function useViewMode(
  tool: "merge" | "split",
  defaultMode: ViewMode
) {
  const storageKey = `pdf-forge:${tool}:view-mode`;
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved === "list" || saved === "grid" || saved === "grid-small")
        return saved;
    } catch {
      // Display switching still works when browser storage is unavailable.
    }
    return defaultMode;
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, viewMode);
    } catch {
      // Remembering the preference is optional.
    }
  }, [storageKey, viewMode]);

  return [viewMode, setViewMode] as const;
}
