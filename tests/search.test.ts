import test from "node:test";
import assert from "node:assert/strict";
import { createLocalMemory } from "../src/core/memory.js";
import { ensureInitializedDirs } from "../src/core/paths.js";
import { enqueueLocalMemory } from "../src/core/queue.js";
import { reviewNext } from "../src/core/review.js";
import { searchMemories } from "../src/core/search.js";
import { makeTestConfig } from "./helpers.js";

function seedTwoTopics(config: ReturnType<typeof makeTestConfig>["config"]) {
  const deploy = createLocalMemory(config, {
    type: "fact",
    summary: "Pin dependency lockfile before deploy",
    topic: "Deploy",
    paths: ["deploy.sh"],
    tags: ["deploy"],
  });

  const cache = createLocalMemory(config, {
    type: "fact",
    summary: "Warm the build cache on CI start",
    topic: "CI Cache",
    paths: [".github/workflows/ci.yml"],
    tags: ["ci", "cache"],
  });

  enqueueLocalMemory(config, deploy);
  reviewNext(config);
  enqueueLocalMemory(config, cache);
  reviewNext(config);
}

test("single-word query returns only the matching topic with a line snippet", () => {
  const { config, cleanup } = makeTestConfig("search-single-word");

  try {
    ensureInitializedDirs(config);
    seedTwoTopics(config);

    const results = searchMemories(config, "lockfile");

    const deployHits = results.filter(
      (result) => result.source === "project" && result.topicSlug === "deploy",
    );
    assert.ok(deployHits.length > 0, "deploy topic should match 'lockfile'");
    assert.ok(
      deployHits.every((hit) => typeof hit.line === "number" && hit.line > 0),
      "project line matches should include a line number",
    );
    assert.ok(
      deployHits.some((hit) => hit.summary.toLowerCase().includes("lockfile")),
      "snippet should contain the matched keyword",
    );

    assert.ok(
      !results.some((result) => result.source === "project" && result.topicSlug === "ci-cache"),
      "ci-cache topic has no 'lockfile' content and should not match",
    );
  } finally {
    cleanup();
  }
});

test("multi-word query OR-matches across tokens and returns snippets from both topics", () => {
  const { config, cleanup } = makeTestConfig("search-multi-word");

  try {
    ensureInitializedDirs(config);
    seedTwoTopics(config);

    const results = searchMemories(config, "lockfile cache");

    const deployHits = results.filter(
      (result) => result.source === "project" && result.topicSlug === "deploy",
    );
    const cacheHits = results.filter(
      (result) => result.source === "project" && result.topicSlug === "ci-cache",
    );

    assert.ok(deployHits.length > 0, "deploy topic should match via 'lockfile'");
    assert.ok(cacheHits.length > 0, "ci-cache topic should match via 'cache'");

    for (const hit of [...deployHits, ...cacheHits]) {
      assert.ok(typeof hit.line === "number" && hit.line > 0, "each project match should have a line number");
    }
  } finally {
    cleanup();
  }
});

test("empty query returns a topic file listing without line snippets", () => {
  const { config, cleanup } = makeTestConfig("search-empty-query");

  try {
    ensureInitializedDirs(config);
    seedTwoTopics(config);

    const results = searchMemories(config, "", { limit: 20 });

    assert.ok(
      results.some((result) => result.source === "project" && result.topicSlug === "deploy"),
      "deploy topic should appear in the empty-query listing",
    );
    assert.ok(
      results.some((result) => result.source === "project" && result.topicSlug === "ci-cache"),
      "ci-cache topic should appear in the empty-query listing",
    );

    for (const result of results) {
      assert.equal(result.line, undefined, "empty-query listings should not carry line snippets");
    }
  } finally {
    cleanup();
  }
});

test("includeLocal surfaces local notes alongside project topics", () => {
  const { config, cleanup } = makeTestConfig("search-include-local");

  try {
    ensureInitializedDirs(config);

    const localOnly = createLocalMemory(config, {
      type: "fact",
      summary: "Temporary note about flaky cache test",
      tags: ["cache"],
      paths: ["tests/cache.test.ts"],
    });

    const promoted = createLocalMemory(config, {
      type: "fact",
      summary: "Warm the build cache on CI start",
      topic: "CI Cache",
      tags: ["ci", "cache"],
      paths: [".github/workflows/ci.yml"],
    });

    enqueueLocalMemory(config, promoted);
    reviewNext(config);

    const withLocal = searchMemories(config, "cache", { includeLocal: true });

    assert.ok(
      withLocal.some((result) => result.source === "project" && result.topicSlug === "ci-cache"),
      "project topic should appear when searching 'cache'",
    );
    assert.ok(
      withLocal.some((result) => result.source === "local" && result.id === localOnly.id),
      "local note should appear when includeLocal=true",
    );
  } finally {
    cleanup();
  }
});
