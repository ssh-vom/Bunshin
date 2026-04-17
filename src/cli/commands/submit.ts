import { Command } from "commander";
import { loadConfig } from "../../core/config.js";
import { resolveLocalMemory } from "../../core/memory.js";
import { ensureInitializedDirs } from "../../core/paths.js";
import { enqueueLocalMemory } from "../../core/queue.js";
import { getConfigOverrides } from "../context.js";

export function registerSubmitCommand(program: Command): void {
  program
    .command("submit")
    .description("Submit a local note into the shared review queue")
    .argument("<idOrPath>", "Local memory id or absolute path")
    .action(function action(this: Command, idOrPath: string) {
      const config = loadConfig(getConfigOverrides(this));
      ensureInitializedDirs(config);

      const localMemory = resolveLocalMemory(config, idOrPath);
      const queueItem = enqueueLocalMemory(config, localMemory);

      console.log(`enqueued ${localMemory.id} as ${queueItem.id}`);
    });
}
