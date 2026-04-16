import yaml from "js-yaml";
import { BunshinError } from "./errors.js";

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const trimmed = markdown.trim();
  if (!trimmed.startsWith("---")) {
    throw new BunshinError("Memory file is missing YAML frontmatter.");
  }

  const match = markdown.match(FRONTMATTER_REGEX);
  if (!match) {
    throw new BunshinError("Failed to parse YAML frontmatter block.");
  }

  const yamlRaw = match[1];
  const bodyRaw = match[2];

  if (yamlRaw === undefined || bodyRaw === undefined) {
    throw new BunshinError("Failed to parse YAML frontmatter block.");
  }

  const frontmatter = (yaml.load(yamlRaw) ?? {}) as Record<string, unknown>;

  if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new BunshinError("Frontmatter must be a YAML object.");
  }

  return {
    frontmatter,
    body: bodyRaw.trim(),
  };
}

export function toMarkdownWithFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const yamlBlock = yaml.dump(frontmatter, {
    noRefs: true,
    lineWidth: -1,
    sortKeys: false,
  });

  const normalizedBody = body.trim();
  return `---\n${yamlBlock}---\n\n${normalizedBody}\n`;
}
