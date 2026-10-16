/**
 * Choosing what a home-page import should take.
 * A dropped file is imported as it is. A folder picker hands over every file
 * it can see, including ones in nested folders, and only Word documents count.
 */

const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

/** Path the folder picker reports, or the file name when a drop has none. */
export function importPath(file: File) {
  return file.webkitRelativePath || file.name;
}

/**
 * Word documents from a folder picker. Nested folders are included when the
 * picker lists their files (webkitRelativePath). Word's lock files (~$…) and
 * macOS archive metadata are skipped, matching a ZIP import.
 */
export function docxFilesInFolder(files: Iterable<File>): File[] {
  return [...files]
    .filter((file) => {
      const path = importPath(file);
      const name = baseName(path);
      if (!/\.docx$/i.test(name) || name.startsWith("~$")) return false;
      return !path.split(/[/\\]/).includes("__MACOSX");
    })
    .sort((a, b) => importPath(a).localeCompare(importPath(b), undefined, { numeric: true, sensitivity: "base" }));
}

/**
 * Files dragged onto Home. A directory in the drop is not walked here — the
 * folder picker is what lists nested Word documents — so it is reported and
 * left out rather than imported as an empty text file.
 */
export function filesDroppedOnHome(transfer: DataTransfer): { files: File[]; directory: boolean } {
  const items = [...transfer.items].filter((item) => item.kind === "file");
  if (!items.length) return { files: [...transfer.files], directory: false };
  let directory = false;
  const files: File[] = [];
  for (const item of items) {
    // A file added in script (tests, some browsers) has no filesystem entry.
    let entry: FileSystemEntry | null = null;
    try {
      entry = item.webkitGetAsEntry?.() ?? null;
    } catch {
      entry = null;
    }
    if (entry?.isDirectory) {
      directory = true;
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return { files, directory };
}
