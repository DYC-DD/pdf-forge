const normalize = (text) => text.normalize("NFKC").replace(/\s/gu, "");

// Keep established whole-run checks unchanged. Word may split fitted Latin
// text into one-glyph PDF items; only join spatially adjacent LTR fragments.
export function textAnchors(items, text) {
  const target = normalize(text);
  const direct = items.filter((item) => normalize(item.text).includes(target));
  if (direct.length) return direct.map(({ x, y }) => ({ x, y }));
  if (!target || !/^[\x20-\x7e]+$/u.test(text)) return [];
  const anchors = [];
  const parts = items.filter(
    (item) => normalize(item.text) && item.dir !== "rtl"
  );
  for (let start = 0; start < parts.length; start++) {
    const first = parts[start];
    let value = "";
    let previous;
    for (let index = start; index < parts.length; index++) {
      const item = parts[index];
      if (
        previous &&
        (Math.abs(item.y - first.y) > 0.5 ||
          item.x < previous.x + previous.width - 0.5 ||
          item.x - previous.x - previous.width >
            Math.max(1, Math.min(item.height, previous.height) * 1.5))
      )
        break;
      value += normalize(item.text);
      if (!target.startsWith(value)) break;
      if (value === target) {
        anchors.push({ x: first.x, y: first.y });
        break;
      }
      previous = item;
    }
  }
  return anchors;
}
