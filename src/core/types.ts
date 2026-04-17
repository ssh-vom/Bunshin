export const MEMORY_TYPES = ["worked", "failed", "fact"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export type QueueStatus = "pending" | "claimed" | "done";

export type DecisionKind = "publish" | "reject" | "escalate";

export type TopicBulletStatus = "active" | "superseded";

export interface BunshinConfig {
  localRoot: string;
  sharedRoot: string;
  agentName: string;
  reviewerName: string;
  repoName?: string;
  repoPath: string;
}

export interface ConfigOverrides {
  localRoot?: string;
  sharedRoot?: string;
  agentName?: string;
  reviewerName?: string;
  repoName?: string;
  repoPath?: string;
  configPath?: string;
}

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  agent: string;
  createdAt: string;
  repo?: string;
  branch?: string;
  commit?: string;
  topic?: string;
  paths: string[];
  tags: string[];
  supersedes?: string;
  summary: string;
  rawBody: string;
  absolutePath: string;
  markdown: string;
}

export interface CreateMemoryInput {
  type: MemoryType;
  summary: string;
  detail?: string;
  takeaway?: string;
  tags?: string[];
  paths?: string[];
  repo?: string;
  branch?: string;
  commit?: string;
  topic?: string;
  supersedes?: string;
}

export interface QueueCandidateSnapshot {
  id: string;
  type: MemoryType;
  repo?: string;
  branch?: string;
  commit?: string;
  topic?: string;
  paths?: string[];
  tags?: string[];
  markdown: string;
}

export interface QueueDecision {
  kind: DecisionKind;
  reason?: string;
  conflictPath?: string;
  publishedPath?: string;
  topic?: string;
  topicPath?: string;
}

export interface QueueItem {
  id: string;
  status: QueueStatus;
  agent: string;
  enqueuedAt: string;
  claimedAt?: string;
  claimedBy?: string;
  doneAt?: string;
  repo?: string;
  branch?: string;
  commit?: string;
  candidate: QueueCandidateSnapshot;
  decision?: QueueDecision;
}

export interface TopicBullet {
  text: string;
  kind: MemoryType;
  status: TopicBulletStatus;
  sourceMemory: string;
  updatedAt: string;
  tags: string[];
  paths: string[];
}

export interface SearchOptions {
  includeLocal?: boolean;
  type?: MemoryType;
  tag?: string;
  path?: string;
  limit?: number;
}

export interface SearchResult {
  id: string;
  source: "project" | "local";
  summary: string;
  absolutePath: string;
  updatedAt: string;
  type?: MemoryType;
  topicSlug?: string;
  line?: number;
}

export interface ReviewNextOptions {
  reviewerName?: string;
  decision?: DecisionKind;
  reason?: string;
}

export interface ReviewOutcome {
  queueId: string;
  candidateId: string;
  decision: QueueDecision;
  topic: string;
  topicPath: string;
  publishedPath?: string;
  conflictPath?: string;
}

export interface RecentTopic {
  slug: string;
  absolutePath: string;
  updatedAt: string;
}

export interface StatusSnapshot {
  pending: number;
  claimed: number;
  done: number;
  conflicts: number;
  projectTopics: number;
  recentDone: QueueItem[];
  recentTopics: RecentTopic[];
}
