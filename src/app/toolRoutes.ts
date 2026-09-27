import type { Tool } from "../features/landing/ToolPicker";

export function toolHref(tool: Tool): string {
  return `${import.meta.env.BASE_URL}${tool}/`;
}

export function toolFromPath(pathname: string): Tool | null {
  const base = import.meta.env.BASE_URL;
  if (!pathname.startsWith(base)) return null;

  const route = pathname.slice(base.length).replace(/\/$/, "");
  if (route === "merge" || route === "split" || route === "compress") {
    return route;
  }
  return null;
}
