import test from "node:test";
import assert from "node:assert/strict";
import { createLocalMemory, loadMemoryFromPath, resolveLocalMemory } from "../src/core/memory.js";
import { ensureInitializedDirs } from "../src/core/paths.js";
import { makeTestConfig } from "./helpers.js";

test("memory create and load round-trip", () => {
  const { config, cleanup } = makeTestConfig("memory");

  try {
    ensureInitializedDirs(config);

    const created = createLocalMemory(config, {
      type: "fact",
      summary: "CI cache must use lockfile hash",
      detail: "Observed stale node_modules when cache key ignored package-lock.json",
      takeaway: "Always include lockfile hash in cache key",
      tags: ["ci", "cache"],
      paths: [".github/workflows/ci.yml"],
      topic: "CI Cache",
    });

    const loaded = loadMemoryFromPath(created.absolutePath);

    assert.equal(loaded.id, created.id);
    assert.equal(loaded.type, "fact");
    assert.equal(loaded.summary, "CI cache must use lockfile hash");
    assert.equal(loaded.topic, "CI Cache");
    assert.deepEqual(loaded.tags, ["ci", "cache"]);

    const resolved = resolveLocalMemory(config, created.id);
    assert.equal(resolved.absolutePath, created.absolutePath);
  } finally {
    cleanup();
  }
});
