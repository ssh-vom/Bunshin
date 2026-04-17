import { Command } from "commander";
import { loadConfig } from "../../core/config.js";
import { createLocalMemory } from "../../core/memory.js";
import { ensureInitializedDirs } from "../../core/paths.js";
import { enqueueLocalMemory } from "../../core/queue.js";
import { MEMORY_TYPES, type MemoryType } from "../../core/types.js";
import { getConfigOverrides, splitCsv } from "../context.js";

interface NoteOptions {
  summary: string;
  detail?: string;
  takeaway?: string;
  tags?: string;
  paths?: string;
  topic?: string;
  repo?: string;
  branch?: string;
  commit?: string;
  supersedes?: string;
  submit?: boolean;
}

export function registerNoteCommand(program: Command): void {
  program
    .command("note")
    .description("Write a local candidate note (optionally submit to the queue)")
    .argument("<type>", "Memory type: worked | failed | fact")
    .requiredOption("--summary <summary>", "Summary sentence")
    .option("--detail <detail>", "Longer detail")
    .option("--takeaway <takeaway>", "Short takeaway")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--paths <paths>", "Comma-separated project paths")
    .option("--topic <topic>", "Optional explicit topic override")
    .option("--repo <repo>", "Repo name")
    .option("--branch <branch>", "Git branch")
    .option("--commit <commit>", "Git commit SHA")
    .option("--supersedes <id>", "Superseded memory id")
    .option("--submit", "Also enqueue the note into the shared review queue", false)
    .action(function action(this: Command, typeArg: string, options: NoteOptions) {
      const config = loadConfig(getConfigOverrides(this));
      ensureInitializedDirs(config);

      if (!MEMORY_TYPES.includes(typeArg as MemoryType)) {
        throw new Error(`Invalid memory type: ${typeArg}. Use one of: ${MEMORY_TYPES.join(", ")}`);
      }

      const entry = createLocalMemory(config, {
        type: typeArg as MemoryType,
        summary: options.summary,
        detail: options.detail,
        takeaway: options.takeaway,
        tags: splitCsv(options.tags),
        paths: splitCsv(options.paths),
        topic: options.topic,
        repo: options.repo,
        branch: options.branch,
        commit: options.commit,
        supersedes: options.supersedes,
      });

      console.log(`wrote memory ${entry.id}`);
      console.log(entry.absolutePath);

      if (options.submit) {
        const queued = enqueueLocalMemory(config, entry);
        console.log(`enqueued ${entry.id} as ${queued.id}`);
      }
    });
}
