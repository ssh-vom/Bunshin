import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BunshinConfig, MemoryType, QueueStatus } from "./types.js";

export function localTypeDir(config: BunshinConfig, type: MemoryType): string {
  return path.join(config.localRoot, type);
}

export function localArchiveDir(config: BunshinConfig): string {
  return path.join(config.localRoot, "archive");
}

export function sharedProjectRoot(config: BunshinConfig): string {
  return path.join(config.sharedRoot, "project");
}

export function sharedProjectTypeDir(config: BunshinConfig, type: MemoryType): string {
  return path.join(sharedProjectRoot(config), type);
}

export function sharedProjectArchiveDir(config: BunshinConfig): string {
  return path.join(sharedProjectRoot(config), "archive");
}

export function queueRoot(config: BunshinConfig): string {
  return path.join(config.sharedRoot, "queue");
}

export function queueDir(config: BunshinConfig, status: QueueStatus): string {
  return path.join(queueRoot(config), status);
}

export function conflictsDir(config: BunshinConfig): string {
  return path.join(config.sharedRoot, "conflicts");
}

export function localMemoryPath(config: BunshinConfig, type: MemoryType, id: string): string {
  return path.join(localTypeDir(config, type), `${id}.md`);
}

export function sharedProjectMemoryPath(config: BunshinConfig, type: MemoryType, id: string): string {
  return path.join(sharedProjectTypeDir(config, type), `${id}.md`);
}

export function queueItemPath(config: BunshinConfig, status: QueueStatus, id: string): string {
  return path.join(queueDir(config, status), `${id}.json`);
}

export function ensureInitializedDirs(config: BunshinConfig): void {
  const dirs = [
    config.localRoot,
    localTypeDir(config, "worked"),
    localTypeDir(config, "failed"),
    localTypeDir(config, "fact"),
    localArchiveDir(config),
    config.sharedRoot,
    sharedProjectRoot(config),
    sharedProjectTypeDir(config, "worked"),
    sharedProjectTypeDir(config, "failed"),
    sharedProjectTypeDir(config, "fact"),
    sharedProjectArchiveDir(config),
    queueRoot(config),
    queueDir(config, "pending"),
    queueDir(config, "claimed"),
    queueDir(config, "done"),
    conflictsDir(config),
  ];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}
