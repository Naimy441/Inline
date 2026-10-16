import { revealInFileManager } from "@/lib/server/mirror";
import { openWithSystemChoice } from "@/lib/server/openWith";
import { VersionFilesError, versionArtifacts } from "@/lib/server/repo";

export type VersionOpener = {
  openFile?: (file: string) => Promise<void>;
  reveal?: (folder: string, isFile: boolean) => Promise<void>;
};

/**
 * Open one file from a version in whatever app the user picks, or open the
 * folder that holds all of that version's files. `userPath` set means the
 * file; omitted means the folder. The two are never mixed.
 */
export async function openVersionOnDisk(documentId: string, versionId: string | null, userPath: string | undefined, deps: VersionOpener = {}): Promise<{ folder: string; file?: string }> {
  const located = await versionArtifacts(documentId, versionId, userPath);
  if (userPath) {
    if (!located.file) throw new VersionFilesError("That file isn't in this version.");
    await (deps.openFile ?? openWithSystemChoice)(located.file);
    return located;
  }
  await (deps.reveal ?? revealInFileManager)(located.folder, false);
  return located;
}
