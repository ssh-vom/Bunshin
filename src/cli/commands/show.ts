import { Command } from "commander";
import { loadConfig } from "../../core/config.js";
import { resolveAnyMemory } from "../../core/memory.js";
import { renderMemory } from "../../core/render.js";
import { getConfigOverrides } from "../context.js";

export function registerShowCommand(program: Command): void {
  program
    .command("show")
    .description("Show a memory by ID or path")
    .argument("<idOrPath>", "Memory ID (mem_*) or path")
    .action(function action(this: Command, idOrPath: string) {
      const config = loadConfig(getConfigOverrides(this));
      const entry = resolveAnyMemory(config, idOrPath);
      console.log(renderMemory(entry));
    });
}
