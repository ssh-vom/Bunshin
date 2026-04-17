import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { listDirNames } from "./fs.js";
import { conflictsDir, sharedProjectRoot } from "./paths.js";
import { countQueueItems, listQueueItems } from "./queue.js";
import type { BunshinConfig, RecentTopic, StatusSnapshot } from "./types.js";

export function getStatus(
  config: BunshinConfig,
  recentDoneLimit = 5,
  recentTopicLimit = 5,
): StatusSnapshot {
  const pending = countQueueItems(config, "pending");
  const claimed = countQueueItems(config, "claimed");
  const done = countQueueItems(config, "done");

  const conflicts = listDirNames(conflictsDir(config)).filter(
    (name) => name.endsWith(".md") || name.endsWith(".json"),
  ).length;

  const projectRoot = sharedProjectRoot(config);
  const topics: RecentTopic[] = existsSync(projectRoot)
    ? listDirNames(projectRoot)
        .filter((name) => name.endsWith(".md"))
        .map((name) => {
          const absolutePath = path.join(projectRoot, name);
          return {
            slug: path.basename(name, ".md"),
            absolutePath,
            updatedAt: statSync(absolutePath).mtime.toISOString(),
          };
        })
    : [];

  const recentTopics = topics
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, recentTopicLimit);

  const recentDone = listQueueItems(config, "done")
    .sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""))
    .slice(0, recentDoneLimit);

  return {
    pending,
    claimed,
    done,
    conflicts,
    projectTopics: topics.length,
    recentDone,
    recentTopics,
  };
}
