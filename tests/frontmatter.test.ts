import test from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, toMarkdownWithFrontmatter } from "../src/core/frontmatter.js";

test("frontmatter round-trip", () => {
  const markdown = toMarkdownWithFrontmatter(
    {
      id: "mem_1234",
      type: "fact",
      agent: "worker-a",
      created_at: "2026-04-16T00:00:00Z",
      tags: ["ci", "cache"],
    },
    "## Summary\nCache key must include lockfile hash.",
  );

  const parsed = parseFrontmatter(markdown);

  assert.equal(parsed.frontmatter.id, "mem_1234");
  assert.equal(parsed.frontmatter.type, "fact");
  assert.deepEqual(parsed.frontmatter.tags, ["ci", "cache"]);
  assert.match(parsed.body, /Summary/);
});
