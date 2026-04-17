import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { BunshinError } from "./errors.js";
import { listDirNames } from "./fs.js";
import { loadMemoryFromPath } from "./memory.js";
import { localTypeDir, sharedProjectRoot } from "./paths.js";
import type {
  BunshinConfig,
  MemoryEntry,
  MemoryType,
  SearchOptions,
  SearchResult,
} from "./types.js";

function truncate(value: string, max = 160): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function absolutize(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function localSearchRoots(config: BunshinConfig, type?: MemoryType): string[] {
  if (type) {
    return [localTypeDir(config, type)];
  }
  return [
    localTypeDir(config, "worked"),
    localTypeDir(config, "failed"),
    localTypeDir(config, "fact"),
  ];
}

interface LineHit {
  absolutePath: string;
  line: number;
  text: string;
}

function ripgrepLines(tokens: string[], roots: string[]): LineHit[] {
  const existing = roots.filter((r) => existsSync(r));
  if (existing.length === 0 || tokens.length === 0) {
    return [];
  }

  const patternArgs: string[] = [];
  for (const token of tokens) {
    patternArgs.push("-e", token);
  }

  const args = [
    "-n",
    "--ignore-case",
    "--fixed-strings",
    "--glob",
    "*.md",
    "--no-messages",
    "--with-filename",
    ...patternArgs,
    "--",
    ...existing,
  ];

  const result = spawnSync("rg", args, { encoding: "utf8" });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new BunshinError("ripgrep (rg) is required for bunshin find. Install ripgrep and retry.");
    }
    throw result.error;
  }
  if (result.status === 1) {
    return [];
  }
  if ((result.status ?? 1) !== 0) {
    const stderr = (result.stderr || result.stdout || "").trim();
    throw new BunshinError(`ripgrep failed${stderr ? `: ${stderr}` : ""}`);
  }

  const hits: LineHit[] = [];
  for (const raw of (result.stdout ?? "").split(/\r?\n/)) {
    if (!raw) continue;
    const firstColon = raw.indexOf(":");
    if (firstColon < 0) continue;
    const secondColon = raw.indexOf(":", firstColon + 1);
    if (secondColon < 0) continue;

    const filePath = raw.slice(0, firstColon);
    const lineStr = raw.slice(firstColon + 1, secondColon);
    const text = raw.slice(secondColon + 1);
    const line = Number.parseInt(lineStr, 10);
    if (!Number.isFinite(line)) continue;

    hits.push({ absolutePath: absolutize(filePath), line, text: text.trim() });
  }
  return hits;
}

function listTopicFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  return listDirNames(root)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(root, name));
}

function listLocalFiles(roots: string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of listDirNames(root)) {
      if (name.endsWith(".md")) {
        out.push(path.join(root, name));
      }
    }
  }
  return out;
}

function includesIgnoreCase(value: string, search: string): boolean {
  return value.toLowerCase().includes(search.toLowerCase());
}

function matchesFilters(entry: MemoryEntry, options: SearchOptions): boolean {
  if (options.type && entry.type !== options.type) return false;
  if (options.tag && !entry.tags.some((t) => t.toLowerCase() === options.tag!.toLowerCase())) return false;
  if (options.path && !entry.paths.some((p) => includesIgnoreCase(p, options.path!))) return false;
  return true;
}

export function searchMemories(
  config: BunshinConfig,
  query: string,
  options: SearchOptions = {},
): SearchResult[] {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const projectRoot = sharedProjectRoot(config);
  const localRoots = localSearchRoots(config, options.type);
  const limit = options.limit ?? 20;
  const results: SearchResult[] = [];

  if (tokens.length === 0) {
    for (const file of listTopicFiles(projectRoot)) {
      const slug = path.basename(file, ".md");
      results.push({
        id: slug,
        source: "project",
        summary: slug,
        absolutePath: file,
        updatedAt: statSync(file).mtime.toISOString(),
        topicSlug: slug,
      });
    }

    if (options.includeLocal) {
      for (const file of listLocalFiles(localRoots)) {
        const entry = loadMemoryFromPath(file);
        if (!matchesFilters(entry, options)) continue;
        results.push({
          id: entry.id,
          source: "local",
          type: entry.type,
          summary: truncate(entry.summary),
          absolutePath: entry.absolutePath,
          updatedAt: entry.createdAt,
        });
      }
    }

    results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return results.slice(0, limit);
  }

  for (const hit of ripgrepLines(tokens, [projectRoot])) {
    const slug = path.basename(hit.absolutePath, ".md");
    results.push({
      id: slug,
      source: "project",
      summary: truncate(hit.text),
      absolutePath: hit.absolutePath,
      updatedAt: statSync(hit.absolutePath).mtime.toISOString(),
      topicSlug: slug,
      line: hit.line,
    });
  }

  if (options.includeLocal) {
    const cache = new Map<string, MemoryEntry>();
    for (const hit of ripgrepLines(tokens, localRoots)) {
      let entry = cache.get(hit.absolutePath);
      if (!entry) {
        entry = loadMemoryFromPath(hit.absolutePath);
        cache.set(hit.absolutePath, entry);
      }
      if (!matchesFilters(entry, options)) continue;
      results.push({
        id: entry.id,
        source: "local",
        type: entry.type,
        summary: truncate(hit.text),
        absolutePath: entry.absolutePath,
        updatedAt: entry.createdAt,
        line: hit.line,
      });
    }
  }

  return results.slice(0, limit);
}
