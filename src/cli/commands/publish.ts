import { Command } from "commander";
import { loadConfig } from "../../core/config.js";
import { resolveLocalMemory } from "../../core/memory.js";
import { ensureInitializedDirs } from "../../core/paths.js";
import { enqueueLocalMemory } from "../../core/queue.js";
import { getConfigOverrides } from "../context.js";

export function registerPublishCommand(program: Command): void {
  program
    .command("publish")
    .description("Publish a local memory by enqueuing it for review")
    .argument("<idOrPath>", "Local memory id or absolute path")
    .action(function action(this: Command, idOrPath: string) {
      const config = loadConfig(getConfigOverrides(this));
      ensureInitializedDirs(config);

      const localMemory = resolveLocalMemory(config, idOrPath);
      const queueItem = enqueueLocalMemory(config, localMemory);

      console.log(`enqueued ${localMemory.id} as ${queueItem.id}`);
    });
}
