import { listDirNames } from "./fs.js";
import { conflictsDir } from "./paths.js";
import { countQueueItems, listQueueItems } from "./queue.js";
import type { BunshinConfig, StatusSnapshot } from "./types.js";

export function getStatus(config: BunshinConfig, recentDoneLimit = 5): StatusSnapshot {
  const pending = countQueueItems(config, "pending");
  const claimed = countQueueItems(config, "claimed");
  const done = countQueueItems(config, "done");

  const conflictDir = conflictsDir(config);
  const conflicts = listDirNames(conflictDir).filter(
    (name) => name.endsWith(".md") || name.endsWith(".json"),
  ).length;

  const recentDone = listQueueItems(config, "done")
    .sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""))
    .slice(0, recentDoneLimit);

  return {
    pending,
    claimed,
    done,
    conflicts,
    recentDone,
  };
}
