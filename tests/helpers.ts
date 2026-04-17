import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BunshinConfig } from "../src/core/types.js";

export function makeTestConfig(name = "bunshin-test"): { config: BunshinConfig; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), `${name}-`));

  const config: BunshinConfig = {
    localRoot: path.join(root, "local"),
    sharedRoot: path.join(root, "shared"),
    agentName: "test-agent",
    reviewerName: "test-reviewer",
    repoName: "test-repo",
    repoPath: root,
  };

  return {
    config,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
