import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { loadConfig } from "../../core/config.js";
import { resolveLocalMemory } from "../../core/memory.js";
import { projectTopicPath } from "../../core/paths.js";
import { renderMemory } from "../../core/render.js";
import { getConfigOverrides } from "../context.js";

function looksLikeMemoryRef(idOrPath: string): boolean {
  if (idOrPath.startsWith("mem_")) {
    return true;
  }

  const basename = path.basename(idOrPath);
  return /^mem_[a-z0-9]+\.md$/i.test(basename);
}

export function registerShowCommand(program: Command): void {
  program
    .command("show")
    .description("Show a memory note or topic doc by ID/path")
    .argument("<idOrPath>", "Memory ID (mem_*) or file/topic path")
    .action(function action(this: Command, idOrPath: string) {
      const config = loadConfig(getConfigOverrides(this));

      if (looksLikeMemoryRef(idOrPath)) {
        const entry = resolveLocalMemory(config, idOrPath);
        console.log(renderMemory(entry));
        return;
      }

      const topicPath = existsSync(idOrPath) ? idOrPath : projectTopicPath(config, idOrPath);
      if (!existsSync(topicPath)) {
        throw new Error(`No memory or topic doc found for: ${idOrPath}`);
      }

      console.log(readFileSync(topicPath, "utf8").trim());
    });
}
