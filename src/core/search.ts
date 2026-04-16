import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { BunshinError } from "./errors.js";
import { listDirNames } from "./fs.js";
import { loadMemoryFromPath } from "./memory.js";
import { localTypeDir, sharedProjectTypeDir } from "./paths.js";
import type { BunshinConfig, MemoryEntry, SearchOptions, SearchResult } from "./types.js";

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

function normalizeResultPath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.resolve(process.cwd(), filePath);
}

function listMarkdownFiles(roots: string[]): string[] {
  const files: string[] = [];

  for (const root of roots) {
    for (const name of listDirNames(root)) {
      if (!name.endsWith(".md")) {
        continue;
      }

      files.push(normalizeResultPath(path.join(root, name)));
    }
  }

  return Array.from(new Set(files)).sort((a, b) => a.localeCompare(b));
}

function runRipgrepFileSearch(query: string, roots: string[]): string[] {
  const normalizedQuery = query.trim();

  const existingRoots = roots.filter((root) => existsSync(root));
  if (existingRoots.length === 0) {
    return [];
  }

  if (!normalizedQuery) {
    return listMarkdownFiles(existingRoots);
  }

  const args = [
    "--files-with-matches",
    "--sort",
    "path",
    "--ignore-case",
    "--fixed-strings",
    "--glob",
    "*.md",
    "--no-messages",
    "--color",
    "never",
    "--",
    normalizedQuery,
    ...existingRoots,
  ];

  const result = spawnSync("rg", args, {
    encoding: "utf8",
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new BunshinError("ripgrep (rg) is required for bunshin search. Install ripgrep and retry.");
    }

    throw result.error;
  }

  // ripgrep exits with code 1 when no results are found.
  if (result.status === 1) {
    return [];
  }

  if ((result.status ?? 1) !== 0) {
    const errorOutput = (result.stderr || result.stdout || "").trim();
    throw new BunshinError(`ripgrep search failed${errorOutput ? `: ${errorOutput}` : ""}`);
  }

  const files = (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeResultPath(line));

  return Array.from(new Set(files));
}

function appendMatches(
  results: SearchResult[],
  files: string[],
  source: SearchResult["source"],
  options: SearchOptions,
): void {
  for (const filePath of files) {
    const entry = loadMemoryFromPath(filePath);
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

  const projectFiles = runRipgrepFileSearch(query, projectTypeDirs);
  const localFiles = options.includeLocal ? runRipgrepFileSearch(query, localTypeDirs) : [];

  const results: SearchResult[] = [];
  appendMatches(results, projectFiles, "project", options);
  appendMatches(results, localFiles, "local", options);

  const sorted = results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const limit = options.limit ?? 20;
  return sorted.slice(0, limit);
}
