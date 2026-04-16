import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BunshinError, invariant } from "./errors.js";
import { parseFrontmatter, toMarkdownWithFrontmatter } from "./frontmatter.js";
import { listDirEntries, listDirNames } from "./fs.js";
import { generateMemoryId } from "./ids.js";
import {
  localArchiveDir,
  localMemoryPath,
  localTypeDir,
  sharedProjectArchiveDir,
  sharedProjectMemoryPath,
  sharedProjectTypeDir,
} from "./paths.js";
import {
  MEMORY_TYPES,
  type BunshinConfig,
  type CreateMemoryInput,
  type MemoryEntry,
  type MemoryType,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeMemoryType(value: unknown): MemoryType {
  if (typeof value !== "string") {
    throw new BunshinError("Memory frontmatter is missing required field: type");
  }

  if (!MEMORY_TYPES.includes(value as MemoryType)) {
    throw new BunshinError(`Unknown memory type: ${value}`);
  }

  return value as MemoryType;
}

function parseBodySection(body: string, section: string): string | undefined {
  const regex = new RegExp(`##\\s+${section}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const match = body.match(regex);
  if (!match?.[1]) {
    return undefined;
  }
  return match[1].trim() || undefined;
}

function extractSummary(body: string): string {
  const explicit = parseBodySection(body, "Summary");
  if (explicit) {
    return explicit;
  }

  const firstParagraph = body.split("\n\n")[0]?.trim();
  if (firstParagraph) {
    return firstParagraph;
  }

  throw new BunshinError("Memory body is missing a summary.");
}

function parseMemoryFromParts(
  frontmatter: Record<string, unknown>,
  body: string,
  absolutePath: string,
  markdown: string,
): MemoryEntry {
  const id = asOptionalString(frontmatter.id);
  const agent = asOptionalString(frontmatter.agent);
  const createdAt = asOptionalString(frontmatter.created_at) ?? asOptionalString(frontmatter.createdAt);

  invariant(id, "Memory frontmatter is missing required field: id");
  invariant(agent, "Memory frontmatter is missing required field: agent");
  invariant(createdAt, "Memory frontmatter is missing required field: created_at");

  const type = normalizeMemoryType(frontmatter.type);

  return {
    id,
    type,
    agent,
    createdAt,
    repo: asOptionalString(frontmatter.repo),
    branch: asOptionalString(frontmatter.branch),
    commit: asOptionalString(frontmatter.commit),
    paths: asStringList(frontmatter.paths),
    tags: asStringList(frontmatter.tags),
    supersedes: asOptionalString(frontmatter.supersedes),
    summary: extractSummary(body),
    detail: parseBodySection(body, "Detail"),
    takeaway: parseBodySection(body, "Takeaway"),
    rawBody: body,
    absolutePath,
    markdown,
  };
}

function buildBody(summary: string, detail?: string, takeaway?: string): string {
  const chunks: string[] = [`## Summary\n${summary.trim()}`];

  if (detail?.trim()) {
    chunks.push(`## Detail\n${detail.trim()}`);
  }

  if (takeaway?.trim()) {
    chunks.push(`## Takeaway\n${takeaway.trim()}`);
  }

  return chunks.join("\n\n");
}

function gitRead(args: string[], cwd: string): string | undefined {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return undefined;
  }

  const trimmed = result.stdout.trim();
  return trimmed || undefined;
}

function detectGitContext(repoPath: string): {
  repo?: string;
  branch?: string;
  commit?: string;
} {
  const topLevel = gitRead(["rev-parse", "--show-toplevel"], repoPath);
  if (!topLevel) {
    return {};
  }

  return {
    repo: path.basename(topLevel),
    branch: gitRead(["rev-parse", "--abbrev-ref", "HEAD"], repoPath),
    commit: gitRead(["rev-parse", "HEAD"], repoPath),
  };
}

function pickMemoryId(config: BunshinConfig, type: MemoryType): { id: string; filePath: string } {
  while (true) {
    const id = generateMemoryId();
    const filePath = localMemoryPath(config, type, id);
    if (!existsSync(filePath)) {
      return { id, filePath };
    }
  }
}

export function loadMemoryFromMarkdown(markdown: string, absolutePath = "<inline>"): MemoryEntry {
  const { frontmatter, body } = parseFrontmatter(markdown);
  invariant(isRecord(frontmatter), "Frontmatter must be a key/value object");
  return parseMemoryFromParts(frontmatter, body, absolutePath, markdown);
}

export function loadMemoryFromPath(filePath: string): MemoryEntry {
  const absolutePath = path.resolve(filePath);
  const markdown = readFileSync(absolutePath, "utf8");
  return loadMemoryFromMarkdown(markdown, absolutePath);
}

export function createLocalMemory(config: BunshinConfig, input: CreateMemoryInput): MemoryEntry {
  const summary = input.summary?.trim();
  invariant(summary, "--summary is required and cannot be empty");

  if (!MEMORY_TYPES.includes(input.type)) {
    throw new BunshinError(`Invalid memory type: ${input.type}`);
  }

  const gitContext = detectGitContext(config.repoPath);
  const { id, filePath } = pickMemoryId(config, input.type);
  const createdAt = new Date().toISOString();

  const frontmatter: Record<string, unknown> = {
    id,
    type: input.type,
    agent: config.agentName,
    created_at: createdAt,
  };

  const repo = input.repo ?? config.repoName ?? gitContext.repo;
  const branch = input.branch ?? gitContext.branch;
  const commit = input.commit ?? gitContext.commit;

  if (repo) {
    frontmatter.repo = repo;
  }

  if (branch) {
    frontmatter.branch = branch;
  }

  if (commit) {
    frontmatter.commit = commit;
  }

  const normalizedPaths = (input.paths ?? []).map((item) => item.trim()).filter(Boolean);
  const normalizedTags = (input.tags ?? []).map((item) => item.trim()).filter(Boolean);

  if (normalizedPaths.length > 0) {
    frontmatter.paths = normalizedPaths;
  }

  if (normalizedTags.length > 0) {
    frontmatter.tags = normalizedTags;
  }

  if (input.supersedes?.trim()) {
    frontmatter.supersedes = input.supersedes.trim();
  }

  const body = buildBody(summary, input.detail, input.takeaway);
  const markdown = toMarkdownWithFrontmatter(frontmatter, body);

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, markdown, "utf8");

  return loadMemoryFromPath(filePath);
}

function maybeNormalizeId(value: string): string {
  if (value.endsWith(".md")) {
    return value.slice(0, -3);
  }
  return value;
}

function findMemoryPathById(id: string, dirs: string[]): string | undefined {
  const target = `${maybeNormalizeId(id)}.md`;

  for (const dir of dirs) {
    const candidate = path.join(dir, target);
    if (existsSync(candidate)) {
      return candidate;
    }

    const nested = listDirEntries(dir);
    for (const entry of nested) {
      if (!entry.isDirectory()) {
        continue;
      }
      const nestedCandidate = path.join(dir, entry.name, target);
      if (existsSync(nestedCandidate)) {
        return nestedCandidate;
      }
    }
  }

  return undefined;
}

function localSearchDirs(config: BunshinConfig): string[] {
  return [
    localTypeDir(config, "worked"),
    localTypeDir(config, "failed"),
    localTypeDir(config, "fact"),
    localArchiveDir(config),
  ];
}

function projectSearchDirs(config: BunshinConfig): string[] {
  return [
    sharedProjectTypeDir(config, "worked"),
    sharedProjectTypeDir(config, "failed"),
    sharedProjectTypeDir(config, "fact"),
    sharedProjectArchiveDir(config),
  ];
}

export function resolveLocalMemory(config: BunshinConfig, idOrPath: string): MemoryEntry {
  if (existsSync(idOrPath)) {
    return loadMemoryFromPath(idOrPath);
  }

  const found = findMemoryPathById(idOrPath, localSearchDirs(config));
  if (!found) {
    throw new BunshinError(`Local memory not found: ${idOrPath}`);
  }

  return loadMemoryFromPath(found);
}

export function resolveAnyMemory(config: BunshinConfig, idOrPath: string): MemoryEntry {
  if (existsSync(idOrPath)) {
    return loadMemoryFromPath(idOrPath);
  }

  const local = findMemoryPathById(idOrPath, localSearchDirs(config));
  if (local) {
    return loadMemoryFromPath(local);
  }

  const project = findMemoryPathById(idOrPath, projectSearchDirs(config));
  if (project) {
    return loadMemoryFromPath(project);
  }

  throw new BunshinError(`Memory not found in local/project roots: ${idOrPath}`);
}

export function loadProjectMemories(config: BunshinConfig, type?: MemoryType): MemoryEntry[] {
  const dirs = type
    ? [sharedProjectTypeDir(config, type)]
    : [
        sharedProjectTypeDir(config, "worked"),
        sharedProjectTypeDir(config, "failed"),
        sharedProjectTypeDir(config, "fact"),
      ];

  const files: string[] = [];
  for (const dir of dirs) {
    for (const name of listDirNames(dir)) {
      if (!name.endsWith(".md")) {
        continue;
      }
      files.push(path.join(dir, name));
    }
  }

  return files
    .map((file) => loadMemoryFromPath(file))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function publishCandidateMarkdownToProject(
  config: BunshinConfig,
  candidateMarkdown: string,
): { entry: MemoryEntry; absolutePath: string; alreadyExists: boolean } {
  const parsed = loadMemoryFromMarkdown(candidateMarkdown, "<queue-candidate>");
  const destination = sharedProjectMemoryPath(config, parsed.type, parsed.id);

  mkdirSync(path.dirname(destination), { recursive: true });

  if (existsSync(destination)) {
    return {
      entry: loadMemoryFromPath(destination),
      absolutePath: destination,
      alreadyExists: true,
    };
  }

  writeFileSync(destination, candidateMarkdown, "utf8");

  return {
    entry: loadMemoryFromPath(destination),
    absolutePath: destination,
    alreadyExists: false,
  };
}

export function archiveProjectMemory(config: BunshinConfig, entry: MemoryEntry): string {
  const destination = path.join(sharedProjectArchiveDir(config), `${entry.id}.md`);
  mkdirSync(path.dirname(destination), { recursive: true });

  if (entry.absolutePath === destination) {
    return destination;
  }

  if (existsSync(entry.absolutePath) && !existsSync(destination)) {
    renameSync(entry.absolutePath, destination);
  }

  return destination;
}
