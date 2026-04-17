import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { BunshinError, invariant } from "./errors.js";
import { parseFrontmatter, toMarkdownWithFrontmatter } from "./frontmatter.js";
import { generateMemoryId } from "./ids.js";
import {
  localArchiveDir,
  localMemoryPath,
  localTypeDir,
  projectTopicPath,
  topicSlug,
  topicTitleFromSlug,
} from "./paths.js";
import {
  MEMORY_TYPES,
  type BunshinConfig,
  type CreateMemoryInput,
  type MemoryEntry,
  type MemoryType,
  type TopicBullet,
} from "./types.js";

// A topic doc has three tiered sections. Bunshin enforces the schema on write
// but never re-parses bullets to make semantic decisions — that's the
// reviewer LLM's job.
export type TopicSection = "working" | "long-term" | "history";

const SECTION_HEADINGS: Record<TopicSection, string> = {
  working: "Working",
  "long-term": "Long-term",
  history: "History",
};

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

function parseMemoryFromParts(
  frontmatter: Record<string, unknown>,
  body: string,
  absolutePath: string,
  markdown: string,
): MemoryEntry {
  const id = asOptionalString(frontmatter.id);
  const agent = asOptionalString(frontmatter.agent);
  const createdAt =
    asOptionalString(frontmatter.created_at) ?? asOptionalString(frontmatter.createdAt);
  const summary = asOptionalString(frontmatter.summary);

  invariant(id, "Memory frontmatter is missing required field: id");
  invariant(agent, "Memory frontmatter is missing required field: agent");
  invariant(createdAt, "Memory frontmatter is missing required field: created_at");
  invariant(summary, "Memory frontmatter is missing required field: summary");

  const type = normalizeMemoryType(frontmatter.type);

  return {
    id,
    type,
    agent,
    createdAt,
    repo: asOptionalString(frontmatter.repo),
    branch: asOptionalString(frontmatter.branch),
    commit: asOptionalString(frontmatter.commit),
    topic: asOptionalString(frontmatter.topic),
    paths: asStringList(frontmatter.paths),
    tags: asStringList(frontmatter.tags),
    supersedes: asOptionalString(frontmatter.supersedes),
    summary,
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
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    return undefined;
  }
  const trimmed = result.stdout.trim();
  return trimmed || undefined;
}

function detectGitContext(repoPath: string): { repo?: string; branch?: string; commit?: string } {
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
  // Collision-probability is vanishingly small for a single worker, but we
  // loop anyway to be honest about it.
  // eslint-disable-next-line no-constant-condition
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
    summary,
  };

  const repo = input.repo ?? config.repoName ?? gitContext.repo;
  const branch = input.branch ?? gitContext.branch;
  const commit = input.commit ?? gitContext.commit;

  if (repo) frontmatter.repo = repo;
  if (branch) frontmatter.branch = branch;
  if (commit) frontmatter.commit = commit;
  if (input.topic?.trim()) frontmatter.topic = input.topic.trim();

  const normalizedPaths = (input.paths ?? []).map((item) => item.trim()).filter(Boolean);
  const normalizedTags = (input.tags ?? []).map((item) => item.trim()).filter(Boolean);
  if (normalizedPaths.length) frontmatter.paths = normalizedPaths;
  if (normalizedTags.length) frontmatter.tags = normalizedTags;
  if (input.supersedes?.trim()) frontmatter.supersedes = input.supersedes.trim();

  const body = buildBody(summary, input.detail, input.takeaway);
  const markdown = toMarkdownWithFrontmatter(frontmatter, body);

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, markdown, "utf8");

  return loadMemoryFromPath(filePath);
}

function maybeNormalizeId(value: string): string {
  return value.endsWith(".md") ? value.slice(0, -3) : value;
}

function findMemoryPathById(id: string, dirs: string[]): string | undefined {
  const target = `${maybeNormalizeId(id)}.md`;
  for (const dir of dirs) {
    const candidate = path.join(dir, target);
    if (existsSync(candidate)) {
      return candidate;
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

// ---- Topic doc write-path ---------------------------------------------------

function formatBulletMetadata(bullet: TopicBullet): string[] {
  const parts = [
    `kind=${bullet.kind}`,
    `status=${bullet.status}`,
    `source_memory=${bullet.sourceMemory}`,
    `updated_at=${bullet.updatedAt}`,
  ];
  if (bullet.tags.length) parts.push(`tags=${bullet.tags.join(",")}`);
  if (bullet.paths.length) parts.push(`paths=${bullet.paths.join(",")}`);
  return parts;
}

export function renderTopicBullet(bullet: TopicBullet): string {
  return `- ${bullet.text} | ${formatBulletMetadata(bullet).join(" | ")}`;
}

function topicSkeleton(title: string): string {
  return [
    `# Topic: ${title}`,
    "",
    "## Working",
    "- (none)",
    "",
    "## Long-term",
    "- (none)",
    "",
    "## History",
    "- (none)",
    "",
  ].join("\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

function insertUnderHeading(content: string, heading: string, bulletLine: string): string {
  // Match "## <heading>\n" and the body up to the next "## " or EOF.
  const re = new RegExp(`(##\\s+${escapeRegex(heading)}\\s*\\n)([\\s\\S]*?)(?=\\n##\\s|$)`, "i");
  const match = content.match(re);

  if (!match) {
    const trimmed = content.replace(/\s+$/, "");
    return `${trimmed}\n\n## ${heading}\n${bulletLine}\n`;
  }

  const [whole, headingLine, body] = match;
  const cleaned = (body ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "- (none)")
    .join("\n")
    .replace(/\s+$/, "");

  const joined = cleaned ? `${cleaned}\n${bulletLine}` : bulletLine;
  return content.replace(whole, `${headingLine}${joined}\n`);
}

export function appendBulletToTopic(
  config: BunshinConfig,
  topicOrSlug: string,
  bullet: TopicBullet,
  section: TopicSection,
): { absolutePath: string; slug: string; title: string } {
  const slug = topicSlug(topicOrSlug);
  const title = topicTitleFromSlug(slug);
  const filePath = projectTopicPath(config, slug);
  const heading = SECTION_HEADINGS[section];
  const bulletLine = renderTopicBullet(bullet);

  mkdirSync(path.dirname(filePath), { recursive: true });

  const current = existsSync(filePath) ? readFileSync(filePath, "utf8") : topicSkeleton(title);
  const updated = insertUnderHeading(current, heading, bulletLine);
  writeFileSync(filePath, updated, "utf8");

  return { absolutePath: filePath, slug, title };
}

export function topicBulletFromMemory(entry: MemoryEntry): TopicBullet {
  return {
    text: entry.summary.trim(),
    kind: entry.type,
    status: "active",
    sourceMemory: entry.id,
    updatedAt: new Date().toISOString(),
    tags: entry.tags,
    paths: entry.paths,
  };
}

export function sectionForType(type: MemoryType): TopicSection {
  return type === "failed" ? "working" : "long-term";
}
