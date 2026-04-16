import { readdirSync, unlinkSync, type Dirent } from "node:fs";

function isEnoent(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function listDirNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }
    throw error;
  }
}

export function listDirEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }
    throw error;
  }
}

export function removeFileIfExists(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }
    throw error;
  }
}
