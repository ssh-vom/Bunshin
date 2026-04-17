import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BunshinError } from "./errors.js";
import type { BunshinConfig, ConfigOverrides } from "./types.js";

interface RawFileConfig {
  localRoot?: string;
  sharedRoot?: string;
  agentName?: string;
  reviewerName?: string;
  repoName?: string;
}

function readConfigFile(configPath: string): RawFileConfig {
  let raw: string;

  try {
    raw = readFileSync(configPath, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as RawFileConfig;
  } catch {
    throw new BunshinError(`Invalid bunshin config JSON: ${configPath}`);
  }
}

function asAbsolute(base: string, maybePath: string): string {
  if (path.isAbsolute(maybePath)) {
    return maybePath;
  }
  return path.resolve(base, maybePath);
}

function pickDefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      out[key as keyof T] = value as T[keyof T];
    }
  }
  return out;
}

export function loadConfig(overrides: ConfigOverrides = {}): BunshinConfig {
  const repoPath = path.resolve(overrides.repoPath ?? process.cwd());
  const defaultConfigPath = path.join(repoPath, "bunshin.config.json");
  const configPath = path.resolve(overrides.configPath ?? defaultConfigPath);

  const defaults: BunshinConfig = {
    localRoot: path.join(os.homedir(), ".bunshin-local"),
    sharedRoot: path.join(repoPath, ".bunshin-shared"),
    agentName: os.userInfo().username || "agent",
    reviewerName: "bunshin-reviewer",
    repoName: path.basename(repoPath),
    repoPath,
  };

  const fileConfig = readConfigFile(configPath);

  const envConfig = pickDefined({
    localRoot: process.env.BUNSHIN_LOCAL_ROOT,
    sharedRoot: process.env.BUNSHIN_SHARED_ROOT,
    agentName: process.env.BUNSHIN_AGENT_NAME,
    reviewerName: process.env.BUNSHIN_REVIEWER_NAME,
    repoName: process.env.BUNSHIN_REPO_NAME,
    repoPath: process.env.BUNSHIN_REPO_PATH,
  });

  const cliConfig = pickDefined({
    localRoot: overrides.localRoot,
    sharedRoot: overrides.sharedRoot,
    agentName: overrides.agentName,
    reviewerName: overrides.reviewerName,
    repoName: overrides.repoName,
  });

  const merged = {
    ...defaults,
    ...fileConfig,
    ...envConfig,
    ...cliConfig,
  };

  return {
    ...merged,
    localRoot: asAbsolute(repoPath, merged.localRoot),
    sharedRoot: asAbsolute(repoPath, merged.sharedRoot),
    repoPath,
  };
}
