import { Command } from "commander";
import type { ConfigOverrides } from "../core/types.js";

function getRootCliOptions(command: Command): {
  localRoot?: string;
  sharedRoot?: string;
  agent?: string;
  reviewer?: string;
  repoName?: string;
} {
  let cursor: Command | null = command;
  while (cursor?.parent) {
    cursor = cursor.parent;
  }

  return (cursor?.opts() ?? {}) as {
    localRoot?: string;
    sharedRoot?: string;
    agent?: string;
    reviewer?: string;
    repoName?: string;
  };
}

export function getConfigOverrides(command: Command): ConfigOverrides {
  const options = getRootCliOptions(command);

  return {
    localRoot: options.localRoot,
    sharedRoot: options.sharedRoot,
    agentName: options.agent,
    reviewerName: options.reviewer,
    repoName: options.repoName,
  };
}

export function splitCsv(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
