import { fileStem } from "../../../shared/files/file";
import type { PageGroup } from "../types";

export function resolveGroupFilenames(
  sourceFilename: string,
  groups: PageGroup[],
  editedGroupId?: string
): PageGroup[] {
  const sourceStem = fileStem(sourceFilename);
  const filenames = groups.map((group) =>
    group.filename?.trim()
      ? fileStem(group.filename.trim())
      : `${sourceStem}-${fileStem(group.name)}`
  );
  const reservedNames = new Set(filenames.map((name) => name.toLowerCase()));
  const seenNames = new Set<string>();
  const order = groups.map((_, index) => index);
  const editedIndex = groups.findIndex((group) => group.id === editedGroupId);

  // Keep existing names and resolve the edited field's conflicts last.
  if (editedIndex !== -1) {
    order.splice(editedIndex, 1);
    order.push(editedIndex);
  }

  for (const index of order) {
    const baseName = filenames[index];
    let name = baseName;
    if (seenNames.has(name.toLowerCase())) {
      let suffix = 1;
      do {
        name = `${baseName}-${suffix}`;
        suffix += 1;
      } while (reservedNames.has(name.toLowerCase()));
    }
    filenames[index] = name;
    seenNames.add(name.toLowerCase());
    reservedNames.add(name.toLowerCase());
  }

  return groups.map((group, index) => ({
    ...group,
    filename: filenames[index],
  }));
}
