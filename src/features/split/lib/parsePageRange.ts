export function parsePageRange(input: string, pageCount: number): number[] {
  const parts = input.split(/[,，、]/).map((part) => part.trim());
  if (!input.trim() || parts.some((part) => !part)) {
    throw new Error("請輸入頁碼，例如 1-3, 5, 8。");
  }

  const selected = new Set<number>();
  for (const part of parts) {
    const match = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part);
    if (!match) throw new Error(`無法辨識「${part}」，請使用頁碼或起訖範圍。`);
    const first = Number(match[1]);
    const last = match[2] ? Number(match[2]) : first;
    if (first < 1 || last > pageCount || first > last) {
      throw new Error(`「${part}」超出範圍，這份 PDF 共有 ${pageCount} 頁。`);
    }
    for (let page = first; page <= last; page += 1) selected.add(page);
  }
  return [...selected].sort((a, b) => a - b);
}
