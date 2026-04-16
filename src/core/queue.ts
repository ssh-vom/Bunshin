import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BunshinError } from "./errors.js";
import { listDirNames, removeFileIfExists } from "./fs.js";
import { generateQueueId } from "./ids.js";
import { queueDir, queueItemPath } from "./paths.js";
import type { BunshinConfig, MemoryEntry, QueueDecision, QueueItem, QueueStatus } from "./types.js";

function isQueueStatus(value: string): value is QueueStatus {
  return value === "pending" || value === "claimed" || value === "done";
}

function readQueueFile(filePath: string): QueueItem {
  const raw = readFileSync(filePath, "utf8");

  let parsed: QueueItem;
  try {
    parsed = JSON.parse(raw) as QueueItem;
  } catch {
    throw new BunshinError(`Malformed queue JSON: ${filePath}`);
  }

  if (!parsed.id || !parsed.status || !isQueueStatus(parsed.status)) {
    throw new BunshinError(`Malformed queue item: ${filePath}`);
  }

  return parsed;
}

function writeQueueFile(filePath: string, item: QueueItem): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(item, null, 2)}\n`, "utf8");
}

function queueFiles(config: BunshinConfig, status: QueueStatus): string[] {
  const dir = queueDir(config, status);

  return listDirNames(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name));
}

function findActiveQueueByCandidate(config: BunshinConfig, candidateId: string): QueueItem | undefined {
  const activeStatuses: QueueStatus[] = ["pending", "claimed"];

  for (const status of activeStatuses) {
    const files = queueFiles(config, status);
    for (const filePath of files) {
      const item = readQueueFile(filePath);
      if (item.candidate.id === candidateId) {
        return item;
      }
    }
  }

  return undefined;
}

export function enqueueLocalMemory(config: BunshinConfig, memory: MemoryEntry): QueueItem {
  const existing = findActiveQueueByCandidate(config, memory.id);
  if (existing) {
    throw new BunshinError(
      `Memory ${memory.id} is already queued as ${existing.id} (status=${existing.status}).`,
    );
  }

  const id = generateQueueId();
  const item: QueueItem = {
    id,
    status: "pending",
    agent: memory.agent,
    enqueuedAt: new Date().toISOString(),
    repo: memory.repo,
    branch: memory.branch,
    commit: memory.commit,
    candidate: {
      id: memory.id,
      type: memory.type,
      repo: memory.repo,
      branch: memory.branch,
      commit: memory.commit,
      paths: memory.paths,
      tags: memory.tags,
      markdown: memory.markdown,
    },
  };

  writeQueueFile(queueItemPath(config, "pending", id), item);
  return item;
}

export function listQueueItems(config: BunshinConfig, status: QueueStatus): QueueItem[] {
  const files = queueFiles(config, status);

  return files
    .map((file) => readQueueFile(file))
    .sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));
}

export function countQueueItems(config: BunshinConfig, status: QueueStatus): number {
  return queueFiles(config, status).length;
}

export interface ClaimedItem {
  item: QueueItem;
  claimedPath: string;
}

export function claimNextPending(config: BunshinConfig, claimedBy: string): ClaimedItem | null {
  const pendingFiles = queueFiles(config, "pending");
  if (pendingFiles.length === 0) {
    return null;
  }

  const sorted = pendingFiles
    .map((filePath) => ({ filePath, item: readQueueFile(filePath) }))
    .sort((a, b) => a.item.enqueuedAt.localeCompare(b.item.enqueuedAt));

  const selected = sorted[0];
  if (!selected) {
    return null;
  }

  const claimedItem: QueueItem = {
    ...selected.item,
    status: "claimed",
    claimedAt: new Date().toISOString(),
    claimedBy,
  };

  const claimedPath = queueItemPath(config, "claimed", selected.item.id);
  renameSync(selected.filePath, claimedPath);
  writeQueueFile(claimedPath, claimedItem);

  return {
    item: claimedItem,
    claimedPath,
  };
}

export function completeClaim(
  config: BunshinConfig,
  claimedPath: string,
  claimedItem: QueueItem,
  decision: QueueDecision,
): QueueItem {
  const doneItem: QueueItem = {
    ...claimedItem,
    status: "done",
    doneAt: new Date().toISOString(),
    decision,
  };

  writeQueueFile(queueItemPath(config, "done", claimedItem.id), doneItem);
  removeFileIfExists(claimedPath);

  return doneItem;
}
