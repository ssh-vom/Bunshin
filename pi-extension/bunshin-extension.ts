import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";

interface BunshinCommandResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  runner: string;
}

function runBunshin(cwd: string, args: string[]): BunshinCommandResult {
  const distCli = path.join(cwd, "dist", "cli", "index.js");

  const runners: Array<{ command: string; prefixArgs: string[]; enabled: boolean; label: string }> = [
    { command: "bunshin", prefixArgs: [], enabled: true, label: "bunshin" },
    { command: "node", prefixArgs: [distCli], enabled: existsSync(distCli), label: `node ${distCli}` },
  ];

  let lastError: Error | undefined;

  for (const runner of runners) {
    if (!runner.enabled) {
      continue;
    }

    const result = spawnSync(runner.command, [...runner.prefixArgs, ...args], {
      cwd,
      env: process.env,
      encoding: "utf8",
    });

    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        lastError = result.error;
        continue;
      }

      throw result.error;
    }

    return {
      ok: (result.status ?? 1) === 0,
      exitCode: result.status ?? 1,
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim(),
      runner: runner.label,
    };
  }

  throw new Error(
    [
      "Could not find a Bunshin executable.",
      "Tried: bunshin and node dist/cli/index.js",
      "Build Bunshin first with: npm run build",
      lastError ? `Last error: ${lastError.message}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max - 1)}…`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const SEARCH_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "with",
]);

function toSearchQuery(prompt: string): string {
  const normalized = normalizeWhitespace(prompt).toLowerCase();
  if (!normalized) {
    return "";
  }

  const tokens = normalized
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !SEARCH_STOPWORDS.has(token));

  return Array.from(new Set(tokens)).slice(0, 8).join(" ");
}

function toAutoSummary(prompt: string): string {
  const normalized = normalizeWhitespace(prompt);
  if (!normalized) {
    return "Auto memory from Pi agent run";
  }

  return truncate(`Task insight: ${normalized}`, 140);
}

function parseMemoryId(output: string): string | undefined {
  const match = output.match(/wrote memory\s+(mem_[a-z0-9]+)/i);
  return match?.[1];
}

function parseStatusCount(output: string, key: "pending" | "claimed" | "done" | "conflicts"): number | undefined {
  const match = output.match(new RegExp(`(?:^|\\n)${key}:\\s*(\\d+)`, "i"));
  if (!match || !match[1]) {
    return undefined;
  }

  const value = Number.parseInt(match[1], 10);
  if (Number.isNaN(value)) {
    return undefined;
  }

  return value;
}

function isMemoryType(value: string | undefined): value is "worked" | "failed" | "fact" {
  return value === "worked" || value === "failed" || value === "fact";
}

function isReviewerAgent(): boolean {
  const agentName = process.env.BUNSHIN_AGENT_NAME?.trim();
  const reviewerName = process.env.BUNSHIN_REVIEWER_NAME?.trim();
  if (!agentName || !reviewerName) {
    return false;
  }

  return agentName === reviewerName;
}

function reviewerQueueWatchEnabled(): boolean {
  const configured = process.env.BUNSHIN_REVIEWER_WATCH_QUEUE;
  if (configured === "1") {
    return true;
  }

  if (configured === "0") {
    return false;
  }

  return isReviewerAgent();
}

function reviewerPollIntervalMs(): number {
  const parsed = Number.parseInt(process.env.BUNSHIN_REVIEWER_POLL_MS ?? "", 10);
  if (Number.isNaN(parsed)) {
    return 4000;
  }

  return Math.min(Math.max(parsed, 1000), 60000);
}

function reviewerAutoProcessEnabled(): boolean {
  const configured = process.env.BUNSHIN_REVIEWER_AUTO_PROCESS;
  if (configured === "1") {
    return true;
  }

  if (configured === "0") {
    return false;
  }

  return isReviewerAgent();
}

function reviewerAutoBatchSize(): number {
  const parsed = Number.parseInt(process.env.BUNSHIN_REVIEWER_AUTO_BATCH ?? "", 10);
  if (Number.isNaN(parsed)) {
    return 10;
  }

  return Math.min(Math.max(parsed, 1), 100);
}

function pluralize(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

function post(pi: any, content: string): void {
  pi.sendMessage({
    customType: "bunshin",
    content,
    display: true,
  });
}

function formatBunshinFailure(args: string[], result: BunshinCommandResult): string {
  const detail = result.stderr || result.stdout || `exit code ${result.exitCode}`;
  return `bunshin ${args.join(" ")} failed (${result.runner}): ${detail}`;
}

function runBunshinTool(ctx: any, args: string[], emptyMessage: string) {
  const result = runBunshin(ctx.cwd, args);
  if (!result.ok) {
    throw new Error(formatBunshinFailure(args, result));
  }

  return {
    content: [{ type: "text", text: result.stdout || emptyMessage }],
    details: {
      command: `bunshin ${args.join(" ")}`,
      runner: result.runner,
      exitCode: result.exitCode,
      stderr: result.stderr || undefined,
    },
  };
}

export default function bunshinExtension(pi: any) {
  let currentPrompt: string | null = null;
  let lastWrittenMemoryId: string | null = null;
  let reviewerQueueTimer: NodeJS.Timeout | null = null;
  let reviewerQueueLastPending: number | null = null;
  let reviewerQueueWarned = false;
  let reviewerQueueProcessing = false;

  function stopReviewerQueueWatch(ctx?: any): void {
    if (reviewerQueueTimer) {
      clearInterval(reviewerQueueTimer);
      reviewerQueueTimer = null;
    }

    reviewerQueueLastPending = null;
    reviewerQueueWarned = false;
    reviewerQueueProcessing = false;

    if (ctx?.ui?.setStatus) {
      ctx.ui.setStatus("bunshin-review-queue", undefined);
    }
  }

  function autoProcessReviewerQueue(ctx: any, pending: number): void {
    if (!reviewerAutoProcessEnabled()) {
      return;
    }

    if (pending <= 0 || reviewerQueueProcessing) {
      return;
    }

    reviewerQueueProcessing = true;

    const maxBatch = reviewerAutoBatchSize();
    let processed = 0;

    try {
      for (let index = 0; index < maxBatch; index += 1) {
        const review = runBunshin(ctx.cwd, ["review", "next"]);
        if (!review.ok) {
          if (!reviewerQueueWarned) {
            reviewerQueueWarned = true;
            ctx.ui.notify(
              `Bunshin reviewer auto-process failed (${review.runner}): ${review.stderr || review.stdout}`,
              "warning",
            );
          }
          break;
        }

        const output = review.stdout || review.stderr || "";
        if (!output || output.includes("No pending queue items.")) {
          break;
        }

        processed += 1;
        post(pi, ["Auto-reviewed Bunshin queue item:", "", truncate(output, 1400)].join("\n"));
      }

      if (processed > 0) {
        ctx.ui.notify(
          `Bunshin reviewer auto-processed ${processed} ${pluralize(processed, "memory")}.`,
          "success",
        );

        const refreshed = runBunshin(ctx.cwd, ["status"]);
        if (refreshed.ok) {
          const refreshedPending = parseStatusCount(refreshed.stdout, "pending");
          if (refreshedPending !== undefined) {
            reviewerQueueLastPending = refreshedPending;
            ctx.ui.setStatus("bunshin-review-queue", `queue pending: ${refreshedPending}`);
          }
        }
      }
    } catch (error) {
      if (!reviewerQueueWarned) {
        reviewerQueueWarned = true;
        ctx.ui.notify(`Bunshin reviewer auto-process crashed: ${(error as Error).message}`, "warning");
      }
    } finally {
      reviewerQueueProcessing = false;
    }
  }

  function pollReviewerQueue(ctx: any): void {
    const status = runBunshin(ctx.cwd, ["status"]);
    if (!status.ok) {
      if (!reviewerQueueWarned) {
        reviewerQueueWarned = true;
        ctx.ui.notify(
          `Bunshin reviewer queue watch failed (${status.runner}): ${status.stderr || status.stdout}`,
          "warning",
        );
      }
      return;
    }

    const pending = parseStatusCount(status.stdout, "pending");
    if (pending === undefined) {
      if (!reviewerQueueWarned) {
        reviewerQueueWarned = true;
        ctx.ui.notify("Bunshin reviewer queue watch could not parse pending count.", "warning");
      }
      return;
    }

    reviewerQueueWarned = false;
    ctx.ui.setStatus("bunshin-review-queue", `queue pending: ${pending}`);

    const previous = reviewerQueueLastPending;
    reviewerQueueLastPending = pending;

    if (previous === null && pending > 0) {
      const summary = `Bunshin queue has ${pending} pending ${pluralize(pending, "memory")} to review.`;
      ctx.ui.notify(summary, "info");
      if (reviewerAutoProcessEnabled()) {
        post(pi, `${summary}\nReviewer auto-processing is enabled.`);
      } else {
        post(pi, `${summary}\nRun /bunshin-review-next to process the oldest item.`);
      }
    }

    if (previous !== null && pending > previous) {
      const delta = pending - previous;
      const summary = `Bunshin queue received ${delta} new ${pluralize(delta, "memory")} (${pending} pending).`;
      ctx.ui.notify(summary, "info");
      if (reviewerAutoProcessEnabled()) {
        post(pi, `${summary}\nReviewer auto-processing will handle this batch.`);
      } else {
        post(pi, `${summary}\nRun /bunshin-review-next to process the next item.`);
      }
    }

    if (pending > 0) {
      autoProcessReviewerQueue(ctx, pending);
    }
  }

  function startReviewerQueueWatch(ctx: any): void {
    if (!reviewerQueueWatchEnabled()) {
      return;
    }

    stopReviewerQueueWatch();

    const pollMs = reviewerPollIntervalMs();
    pollReviewerQueue(ctx);

    reviewerQueueTimer = setInterval(() => {
      try {
        pollReviewerQueue(ctx);
      } catch (error) {
        if (!reviewerQueueWarned) {
          reviewerQueueWarned = true;
          ctx.ui.notify(`Bunshin reviewer queue watch crashed: ${(error as Error).message}`, "warning");
        }
      }
    }, pollMs);

    const mode = reviewerAutoProcessEnabled()
      ? `auto-process on (batch ${reviewerAutoBatchSize()})`
      : "auto-process off";

    ctx.ui.notify(`Bunshin reviewer queue watch enabled (${pollMs}ms poll, ${mode}).`, "info");
  }

  pi.registerTool({
    name: "bunshin_status",
    label: "Bunshin Status",
    description: "Show Bunshin queue and conflict status.",
    promptSnippet: "Inspect Bunshin queue state (pending/claimed/done/conflicts)",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
      return runBunshinTool(ctx, ["status"], "bunshin status returned no output");
    },
  });

  pi.registerTool({
    name: "bunshin_search",
    label: "Bunshin Search",
    description:
      "Search Bunshin memory with ripgrep-backed matching. By default searches shared project memory; set includeLocal=true to also search local memory.",
    promptSnippet: "Search Bunshin project memory (optionally include local memory)",
    promptGuidelines: [
      "Use this tool when the user asks what has already been learned or stored in Bunshin memory.",
      "Prefer project memory first; include local memory when sandbox-local context is needed.",
      "Pass a focused query (keywords, path, or tags). If unsure, omit query to fetch recent memories.",
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Optional search query. If omitted, Bunshin returns recent memories (optionally filtered by type/tag/path).",
        }),
      ),
      includeLocal: Type.Optional(Type.Boolean({ description: "Include local memory in addition to project memory" })),
      type: Type.Optional(Type.String({ description: "Optional memory type filter: worked | failed | fact" })),
      tag: Type.Optional(Type.String({ description: "Optional exact tag filter" })),
      path: Type.Optional(Type.String({ description: "Optional project path substring filter" })),
      limit: Type.Optional(Type.Number({ description: "Maximum results", minimum: 1, maximum: 50 })),
    }),
    async execute(
      _toolCallId: string,
      params: {
        query?: string;
        includeLocal?: boolean;
        type?: string;
        tag?: string;
        path?: string;
        limit?: number;
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: any,
    ) {
      const requestedQuery = params.query?.trim() ?? "";
      const inferredQuery = requestedQuery || toSearchQuery(currentPrompt ?? "");

      const args = ["search"];
      if (inferredQuery) {
        args.push(inferredQuery);
      }

      if (params.includeLocal) {
        args.push("--include-local");
      }

      const type = params.type?.trim();
      if (type) {
        if (!isMemoryType(type)) {
          throw new Error(`Invalid memory type: ${type}. Use worked | failed | fact.`);
        }
        args.push("--type", type);
      }

      const tag = params.tag?.trim();
      if (tag) {
        args.push("--tag", tag);
      }

      const pathFilter = params.path?.trim();
      if (pathFilter) {
        args.push("--path", pathFilter);
      }

      if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
        const limit = Math.min(50, Math.max(1, Math.floor(params.limit)));
        args.push("--limit", `${limit}`);
      } else if (!inferredQuery) {
        args.push("--limit", "5");
      }

      return runBunshinTool(ctx, args, "No matching memories.");
    },
  });

  pi.registerTool({
    name: "bunshin_show",
    label: "Bunshin Show",
    description: "Show a Bunshin memory by id or absolute path.",
    promptSnippet: "Show full details for a Bunshin memory id/path",
    parameters: Type.Object({
      idOrPath: Type.String({ description: "Memory id (mem_xxxx) or absolute path" }),
    }),
    async execute(
      _toolCallId: string,
      params: { idOrPath: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: any,
    ) {
      const idOrPath = params.idOrPath?.trim();
      if (!idOrPath) {
        throw new Error("bunshin_show requires idOrPath");
      }

      return runBunshinTool(ctx, ["show", idOrPath], "bunshin show returned no output");
    },
  });

  pi.registerTool({
    name: "bunshin_write",
    label: "Bunshin Write",
    description: "Write a local Bunshin memory entry.",
    promptSnippet: "Write a Bunshin local memory entry (worked/failed/fact)",
    promptGuidelines: [
      "Only write memory for reusable, actionable project insights or when the user explicitly asks.",
      "Do not write memories for purely exploratory or conversational prompts.",
    ],
    parameters: Type.Object({
      type: Type.Optional(Type.String({ description: "Memory type: worked | failed | fact (default: fact)" })),
      summary: Type.String({ description: "Required summary sentence" }),
      detail: Type.Optional(Type.String({ description: "Optional detail" })),
      takeaway: Type.Optional(Type.String({ description: "Optional takeaway" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags" })),
      paths: Type.Optional(Type.Array(Type.String(), { description: "Optional project paths" })),
      publish: Type.Optional(Type.Boolean({ description: "Publish to review queue after writing" })),
    }),
    async execute(
      _toolCallId: string,
      params: {
        type?: string;
        summary: string;
        detail?: string;
        takeaway?: string;
        tags?: string[];
        paths?: string[];
        publish?: boolean;
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: any,
    ) {
      const summary = params.summary?.trim();
      if (!summary) {
        throw new Error("bunshin_write requires a non-empty summary");
      }

      const requestedType = params.type?.trim();
      const memoryType = requestedType ? (isMemoryType(requestedType) ? requestedType : null) : "fact";
      if (!memoryType) {
        throw new Error(`Invalid memory type: ${requestedType}. Use worked | failed | fact.`);
      }

      const args = ["write", memoryType, "--summary", summary];

      const detail = params.detail?.trim();
      if (detail) {
        args.push("--detail", detail);
      }

      const takeaway = params.takeaway?.trim();
      if (takeaway) {
        args.push("--takeaway", takeaway);
      }

      const tags = (params.tags ?? []).map((item) => item.trim()).filter(Boolean);
      if (tags.length > 0) {
        args.push("--tags", tags.join(","));
      }

      const paths = (params.paths ?? []).map((item) => item.trim()).filter(Boolean);
      if (paths.length > 0) {
        args.push("--paths", paths.join(","));
      }

      const write = runBunshin(ctx.cwd, args);
      if (!write.ok) {
        throw new Error(formatBunshinFailure(args, write));
      }

      const memoryId = parseMemoryId(`${write.stdout}\n${write.stderr}`) ?? null;
      if (memoryId) {
        lastWrittenMemoryId = memoryId;
      }

      let output = write.stdout || (memoryId ? `wrote memory ${memoryId}` : "bunshin write completed");
      let publishOutput: string | undefined;

      if (params.publish) {
        if (!memoryId) {
          throw new Error("bunshin_write could not parse memory id, so publish=true cannot be completed.");
        }

        const publish = runBunshin(ctx.cwd, ["publish", memoryId]);
        if (!publish.ok) {
          throw new Error(formatBunshinFailure(["publish", memoryId], publish));
        }

        publishOutput = publish.stdout || `enqueued ${memoryId}`;
        output = `${output}\n${publishOutput}`;
      }

      return {
        content: [{ type: "text", text: output }],
        details: {
          command: `bunshin ${args.join(" ")}`,
          runner: write.runner,
          exitCode: write.exitCode,
          memoryId: memoryId ?? undefined,
          publishOutput,
          stderr: write.stderr || undefined,
        },
      };
    },
  });

  pi.registerTool({
    name: "bunshin_publish",
    label: "Bunshin Publish",
    description: "Publish a local memory entry to the review queue.",
    promptSnippet: "Publish a local Bunshin memory id to the review queue",
    parameters: Type.Object({
      memoryId: Type.String({ description: "Memory id to publish (e.g. mem_ab12cd)" }),
    }),
    async execute(
      _toolCallId: string,
      params: { memoryId: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: any,
    ) {
      const memoryId = params.memoryId?.trim();
      if (!memoryId) {
        throw new Error("bunshin_publish requires memoryId");
      }

      return runBunshinTool(ctx, ["publish", memoryId], `enqueued ${memoryId}`);
    },
  });

  pi.registerTool({
    name: "bunshin_review_next",
    label: "Bunshin Review Next",
    description: "Review the next pending queue item with optional manual decision.",
    promptSnippet: "Review the next Bunshin queue item (publish/reject/escalate)",
    parameters: Type.Object({
      decision: Type.Optional(Type.String({ description: "Optional decision: publish | reject | escalate" })),
      reason: Type.Optional(Type.String({ description: "Optional review reason" })),
      reviewer: Type.Optional(Type.String({ description: "Optional reviewer identity override" })),
    }),
    async execute(
      _toolCallId: string,
      params: { decision?: string; reason?: string; reviewer?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: any,
    ) {
      const args = ["review", "next"];

      const decision = params.decision?.trim();
      if (decision) {
        if (decision !== "publish" && decision !== "reject" && decision !== "escalate") {
          throw new Error(`Invalid decision: ${decision}. Use publish | reject | escalate.`);
        }
        args.push("--decision", decision);
      }

      const reason = params.reason?.trim();
      if (reason) {
        args.push("--reason", reason);
      }

      const reviewer = params.reviewer?.trim();
      if (reviewer) {
        args.push("--reviewer", reviewer);
      }

      return runBunshinTool(ctx, args, "No pending queue items.");
    },
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    try {
      const init = runBunshin(ctx.cwd, ["init"]);
      if (!init.ok) {
        ctx.ui.notify(`Bunshin init failed (${init.runner}): ${init.stderr || init.stdout}`, "warning");
        return;
      }

      ctx.ui.notify("Bunshin initialized for this session.", "success");
    } catch (error) {
      ctx.ui.notify(`Bunshin init skipped: ${(error as Error).message}`, "warning");
    }
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    startReviewerQueueWatch(ctx);
  });

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    stopReviewerQueueWatch(ctx);
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    currentPrompt = prompt;

    if (process.env.BUNSHIN_INJECT_SEARCH === "0") {
      return;
    }

    const query = toSearchQuery(prompt);
    const limit = process.env.BUNSHIN_SEARCH_LIMIT ?? "3";

    const primaryArgs = ["search"];
    if (query) {
      primaryArgs.push(query);
    }
    primaryArgs.push("--limit", limit);

    const primary = runBunshin(ctx.cwd, primaryArgs);
    if (!primary.ok) {
      ctx.ui.notify(`Bunshin search failed (${primary.runner}): ${primary.stderr || primary.stdout}`, "warning");
      return;
    }

    let output = primary.stdout;
    let usedFallback = false;

    const noMatches = !output || output.includes("No matching memories.");
    if (noMatches && query && process.env.BUNSHIN_INJECT_FALLBACK_RECENT !== "0") {
      const fallbackLimit = process.env.BUNSHIN_SEARCH_FALLBACK_LIMIT ?? limit;
      const fallback = runBunshin(ctx.cwd, ["search", "--limit", fallbackLimit]);

      if (fallback.ok && fallback.stdout && !fallback.stdout.includes("No matching memories.")) {
        output = fallback.stdout;
        usedFallback = true;
      }
    }

    if (!output || output.includes("No matching memories.")) {
      return;
    }

    const heading = usedFallback
      ? "Recent Bunshin project memory (fallback):"
      : query
        ? "Relevant Bunshin project memory:"
        : "Recent Bunshin project memory:";

    return {
      message: {
        customType: "bunshin-memory",
        content: [
          heading,
          "",
          truncate(output, 1400),
          "",
          "Use this context only if relevant to the current task.",
        ].join("\n"),
        display: true,
      },
    };
  });

  pi.on("agent_end", async (_event: any, ctx: any) => {
    if (process.env.BUNSHIN_AUTO_WRITE !== "1") {
      currentPrompt = null;
      return;
    }

    const prompt = currentPrompt;
    currentPrompt = null;

    if (!prompt) {
      return;
    }

    const requestedType = process.env.BUNSHIN_AUTO_TYPE;
    const memoryType = isMemoryType(requestedType) ? requestedType : "fact";
    const summary = toAutoSummary(prompt);
    const detail = truncate(`Auto-captured at agent_end. Prompt: ${normalizeWhitespace(prompt)}`, 400);
    const tags = process.env.BUNSHIN_AUTO_TAGS ?? "pi,auto";

    const write = runBunshin(ctx.cwd, [
      "write",
      memoryType,
      "--summary",
      summary,
      "--detail",
      detail,
      "--tags",
      tags,
    ]);

    if (!write.ok) {
      ctx.ui.notify(`Bunshin auto-write failed (${write.runner}): ${write.stderr || write.stdout}`, "warning");
      return;
    }

    const memoryId = parseMemoryId(`${write.stdout}\n${write.stderr}`) ?? null;
    lastWrittenMemoryId = memoryId;

    ctx.ui.notify(
      memoryId ? `Bunshin wrote local memory ${memoryId}.` : "Bunshin wrote a local memory.",
      "success",
    );

    if (process.env.BUNSHIN_AUTO_PUBLISH !== "1" || !memoryId) {
      return;
    }

    const publish = runBunshin(ctx.cwd, ["publish", memoryId]);
    if (!publish.ok) {
      ctx.ui.notify(`Bunshin auto-publish failed (${publish.runner}): ${publish.stderr || publish.stdout}`, "warning");
      return;
    }

    ctx.ui.notify(`Bunshin published ${memoryId} to review queue.`, "success");
  });

  pi.registerCommand("bunshin-status", {
    description: "Show Bunshin queue and conflict status",
    handler: async (_args: string, ctx: any) => {
      const result = runBunshin(ctx.cwd, ["status"]);
      if (!result.ok) {
        post(pi, `bunshin status failed (${result.runner})\n${result.stderr || result.stdout}`);
        return;
      }

      post(pi, result.stdout || "bunshin status returned no output");
    },
  });

  pi.registerCommand("bunshin-search", {
    description: "Search Bunshin memory. Usage: /bunshin-search [query]",
    handler: async (args: string, ctx: any) => {
      const query = args.trim();
      const commandArgs = ["search"];

      if (query) {
        commandArgs.push(query);
      }

      commandArgs.push("--include-local", "--limit", "5");

      const result = runBunshin(ctx.cwd, commandArgs);
      if (!result.ok) {
        post(pi, `bunshin search failed (${result.runner})\n${result.stderr || result.stdout}`);
        return;
      }

      post(pi, result.stdout || "No matching memories.");
    },
  });

  pi.registerCommand("bunshin-review-next", {
    description: "Review next queue item. Usage: /bunshin-review-next [publish|reject|escalate] [reason...]",
    handler: async (args: string, ctx: any) => {
      const tokens = args.trim() ? args.trim().split(/\s+/) : [];
      const decision = tokens[0];
      const reason = tokens.slice(1).join(" ");

      const commandArgs = ["review", "next"];
      if (decision === "publish" || decision === "reject" || decision === "escalate") {
        commandArgs.push("--decision", decision);
      }
      if (reason) {
        commandArgs.push("--reason", reason);
      }

      const result = runBunshin(ctx.cwd, commandArgs);
      if (!result.ok) {
        post(pi, `bunshin review next failed (${result.runner})\n${result.stderr || result.stdout}`);
        return;
      }

      post(pi, result.stdout || "bunshin review next completed");
    },
  });

  pi.registerCommand("bunshin-publish-last", {
    description: "Publish the last auto-written memory from this session",
    handler: async (_args: string, ctx: any) => {
      if (!lastWrittenMemoryId) {
        ctx.ui.notify("No auto-written memory found in this session yet.", "warning");
        return;
      }

      const result = runBunshin(ctx.cwd, ["publish", lastWrittenMemoryId]);
      if (!result.ok) {
        post(pi, `bunshin publish failed (${result.runner})\n${result.stderr || result.stdout}`);
        return;
      }

      post(pi, result.stdout || `Published ${lastWrittenMemoryId}`);
    },
  });
}
