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

export function topicSlug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "general";
}

export function topicTitleFromSlug(slug: string): string {
  return (
    slug
      .split("-")
      .filter(Boolean)
      .map((part) => {
        if (part.length <= 3) {
          return part.toUpperCase();
        }
        return `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`;
      })
      .join(" ") || "General"
  );
}

export function projectTopicPath(config: BunshinConfig, topicOrSlug: string): string {
  return path.join(sharedProjectRoot(config), `${topicSlug(topicOrSlug)}.md`);
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
