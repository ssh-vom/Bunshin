import path from "node:path";
import { listDirNames } from "./fs.js";
import { loadMemoryFromPath } from "./memory.js";
import { localTypeDir, sharedProjectTypeDir } from "./paths.js";
import type { BunshinConfig, MemoryEntry, SearchOptions, SearchResult } from "./types.js";

function memoryFilesInDir(dir: string): string[] {
  return listDirNames(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(dir, name));
}

function includesIgnoreCase(value: string, search: string): boolean {
  return value.toLowerCase().includes(search.toLowerCase());
}

function hasTag(entry: MemoryEntry, tag?: string): boolean {
  if (!tag) {
    return true;
  }

  const normalized = tag.toLowerCase();
  return entry.tags.some((item) => item.toLowerCase() === normalized);
}

function hasPath(entry: MemoryEntry, pathFilter?: string): boolean {
  if (!pathFilter) {
    return true;
  }

  return entry.paths.some((item) => includesIgnoreCase(item, pathFilter));
}

function matchesQuery(entry: MemoryEntry, query: string): boolean {
  const normalized = query.trim();
  if (!normalized) {
    return true;
  }

  return includesIgnoreCase(entry.markdown, normalized);
}

function truncate(value: string, max = 120): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max - 1)}…`;
}

function toSearchResult(entry: MemoryEntry, source: SearchResult["source"]): SearchResult {
  return {
    id: entry.id,
    type: entry.type,
    source,
    summary: truncate(entry.summary),
    absolutePath: entry.absolutePath,
    createdAt: entry.createdAt,
  };
}

function appendMatches(
  results: SearchResult[],
  files: string[],
  source: SearchResult["source"],
  query: string,
  options: SearchOptions,
): void {
  for (const filePath of files) {
    const entry = loadMemoryFromPath(filePath);
    if (!matchesQuery(entry, query)) {
      continue;
    }
    if (!hasTag(entry, options.tag)) {
      continue;
    }
    if (!hasPath(entry, options.path)) {
      continue;
    }

    results.push(toSearchResult(entry, source));
  }
}

export function searchMemories(config: BunshinConfig, query: string, options: SearchOptions = {}): SearchResult[] {
  const projectTypeDirs = options.type
    ? [sharedProjectTypeDir(config, options.type)]
    : [
        sharedProjectTypeDir(config, "worked"),
        sharedProjectTypeDir(config, "failed"),
        sharedProjectTypeDir(config, "fact"),
      ];

  const localTypeDirs = options.type
    ? [localTypeDir(config, options.type)]
    : [localTypeDir(config, "worked"), localTypeDir(config, "failed"), localTypeDir(config, "fact")];

  const projectFiles = projectTypeDirs.flatMap(memoryFilesInDir);
  const localFiles = options.includeLocal ? localTypeDirs.flatMap(memoryFilesInDir) : [];

  const results: SearchResult[] = [];
  appendMatches(results, projectFiles, "project", query, options);
  appendMatches(results, localFiles, "local", query, options);

  const sorted = results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const limit = options.limit ?? 20;
  return sorted.slice(0, limit);
}
