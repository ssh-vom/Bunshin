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

function isMemoryType(value: string | undefined): value is "worked" | "failed" | "fact" {
  return value === "worked" || value === "failed" || value === "fact";
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

function envFlag(name: string): boolean {
  return process.env[name] === "1";
}

function envIntInRange(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parsePendingCount(statusStdout: string): number {
  for (const line of statusStdout.split(/\r?\n/)) {
    const match = line.match(/^pending:\s*(\d+)/);
    if (match) return Number.parseInt(match[1] ?? "0", 10);
  }
  return 0;
}

interface ReviewerWatchState {
  timer: NodeJS.Timeout | null;
  running: boolean;
}

function startReviewerQueueWatch(ctx: any): ReviewerWatchState {
  const state: ReviewerWatchState = { timer: null, running: false };

  const autoProcess = envFlag("BUNSHIN_REVIEWER_AUTO_PROCESS");
  const pollMs = envIntInRange("BUNSHIN_REVIEWER_POLL_MS", 4000, 1000, 60000);
  const batchSize = envIntInRange("BUNSHIN_REVIEWER_AUTO_BATCH", 10, 1, 100);

  const tick = async () => {
    if (state.running) return;
    state.running = true;
    try {
      const status = runBunshin(ctx.cwd, ["status"]);
      if (!status.ok) {
        ctx.ui?.notify?.(
          `Bunshin reviewer watch: status failed: ${status.stderr || status.stdout}`,
          "warning",
        );
        return;
      }

      const pending = parsePendingCount(status.stdout);
      if (pending <= 0) return;

      if (!autoProcess) {
        ctx.ui?.notify?.(
          `Bunshin reviewer watch: ${pending} pending item(s). Run bunshin_review to drain.`,
          "info",
        );
        return;
      }

      let drained = 0;
      for (let i = 0; i < batchSize && drained < pending; i += 1) {
        const review = runBunshin(ctx.cwd, ["review"]);
        if (!review.ok) {
          ctx.ui?.notify?.(
            `Bunshin reviewer watch: review failed: ${review.stderr || review.stdout}`,
            "warning",
          );
          break;
        }
        if (!review.stdout || review.stdout.includes("No pending queue items")) {
          break;
        }
        drained += 1;
      }

      if (drained > 0) {
        ctx.ui?.notify?.(`Bunshin reviewer drained ${drained} item(s).`, "success");
      }
    } catch (error) {
      ctx.ui?.notify?.(
        `Bunshin reviewer watch error: ${(error as Error).message}`,
        "warning",
      );
    } finally {
      state.running = false;
    }
  };

  state.timer = setInterval(() => {
    void tick();
  }, pollMs);
  if (typeof state.timer.unref === "function") state.timer.unref();

  void tick();

  return state;
}

export default function bunshinExtension(pi: any) {
  pi.registerTool({
    name: "bunshin_find",
    label: "Bunshin Find",
    description:
      "Ripgrep-backed search over Bunshin project memory. Multi-word queries are OR-matched across tokens. Omit the query to list recent topic files.",
    promptSnippet: "Search Bunshin project memory with ripgrep keywords",
    promptGuidelines: [
      "Before starting any non-trivial task, run bunshin_find with one or two keywords from the task or files you're about to touch.",
      "Multi-word queries are OR-matched, so pass distinct keywords rather than full sentences.",
      "If nothing relevant comes back, retry once with includeLocal=true; if still empty, proceed without inventing context.",
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Search keywords. Whitespace-separated tokens are OR-matched. Omit to list recent topic files.",
        }),
      ),
      includeLocal: Type.Optional(Type.Boolean({ description: "Include sandbox-local notes too" })),
      type: Type.Optional(Type.String({ description: "Filter by memory type: worked | failed | fact" })),
      tag: Type.Optional(Type.String({ description: "Exact tag filter" })),
      path: Type.Optional(Type.String({ description: "Project path substring filter" })),
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
      const args = ["find"];

      const query = params.query?.trim();
      if (query) {
        args.push(query);
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
      } else if (!query) {
        args.push("--limit", "5");
      }

      return runBunshinTool(ctx, args, "No matching memories.");
    },
  });

  pi.registerTool({
    name: "bunshin_note",
    label: "Bunshin Note",
    description:
      "Record a reusable project insight as a local Bunshin memory. Pass submit=true to also enqueue it for shared review.",
    promptSnippet: "Capture a reusable project insight as a Bunshin memory",
    promptGuidelines: [
      "After a task, ask yourself whether you learned something reusable. If yes, write one concise note.",
      "Use type=fact for stable guidance, worked for a confirmed fix, failed for a failure mode worth remembering.",
      "Attach paths and tags when they would help a future bunshin_find query locate this note.",
      "Pass submit=true only when the insight is clearly useful across sessions; otherwise keep it local.",
    ],
    parameters: Type.Object({
      type: Type.Optional(Type.String({ description: "Memory type: worked | failed | fact (default: fact)" })),
      summary: Type.String({ description: "Required summary sentence" }),
      detail: Type.Optional(Type.String({ description: "Optional detail" })),
      takeaway: Type.Optional(Type.String({ description: "Optional takeaway" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags" })),
      paths: Type.Optional(Type.Array(Type.String(), { description: "Optional project paths" })),
      topic: Type.Optional(Type.String({ description: "Optional explicit topic override" })),
      submit: Type.Optional(Type.Boolean({ description: "Submit to shared review queue after writing" })),
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
        topic?: string;
        submit?: boolean;
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: any,
    ) {
      const summary = params.summary?.trim();
      if (!summary) {
        throw new Error("bunshin_note requires a non-empty summary");
      }

      const requestedType = params.type?.trim();
      const memoryType = requestedType ? (isMemoryType(requestedType) ? requestedType : null) : "fact";
      if (!memoryType) {
        throw new Error(`Invalid memory type: ${requestedType}. Use worked | failed | fact.`);
      }

      const args = ["note", memoryType, "--summary", summary];

      const detail = params.detail?.trim();
      if (detail) args.push("--detail", detail);

      const takeaway = params.takeaway?.trim();
      if (takeaway) args.push("--takeaway", takeaway);

      const tags = (params.tags ?? []).map((item) => item.trim()).filter(Boolean);
      if (tags.length > 0) args.push("--tags", tags.join(","));

      const paths = (params.paths ?? []).map((item) => item.trim()).filter(Boolean);
      if (paths.length > 0) args.push("--paths", paths.join(","));

      const topic = params.topic?.trim();
      if (topic) args.push("--topic", topic);

      if (params.submit) args.push("--submit");

      return runBunshinTool(ctx, args, "bunshin note completed");
    },
  });

  pi.registerTool({
    name: "bunshin_review",
    label: "Bunshin Review",
    description:
      "Claim and resolve the next pending Bunshin queue item. Only the reviewer agent should call this.",
    promptSnippet: "Review the next Bunshin queue item (publish/reject/escalate)",
    promptGuidelines: [
      "Only call this when you are the reviewer agent; workers should use bunshin_note with submit=true instead.",
      "Call repeatedly in a loop while there are pending items; the tool returns 'No pending queue items.' when the queue is empty.",
      "Omit decision to append the candidate into the resolved topic; pass reject/escalate only when overriding.",
    ],
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
      const args = ["review"];

      const decision = params.decision?.trim();
      if (decision) {
        if (decision !== "publish" && decision !== "reject" && decision !== "escalate") {
          throw new Error(`Invalid decision: ${decision}. Use publish | reject | escalate.`);
        }
        args.push("--decision", decision);
      }

      const reason = params.reason?.trim();
      if (reason) args.push("--reason", reason);

      const reviewer = params.reviewer?.trim();
      if (reviewer) args.push("--reviewer", reviewer);

      return runBunshinTool(ctx, args, "No pending queue items.");
    },
  });

  let reviewerWatch: ReviewerWatchState | null = null;

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

    if (envFlag("BUNSHIN_REVIEWER_WATCH_QUEUE") && !reviewerWatch) {
      reviewerWatch = startReviewerQueueWatch(ctx);
      const autoNote = envFlag("BUNSHIN_REVIEWER_AUTO_PROCESS") ? " (auto-process on)" : "";
      ctx.ui?.notify?.(`Bunshin reviewer watching queue${autoNote}.`, "info");
    }
  });

  pi.on("session_shutdown", async () => {
    if (reviewerWatch?.timer) {
      clearInterval(reviewerWatch.timer);
      reviewerWatch.timer = null;
    }
    reviewerWatch = null;
  });
}
