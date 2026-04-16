import { randomBytes } from "node:crypto";

function shortHex(bytes = 3): string {
  return randomBytes(bytes).toString("hex");
}

export function generateMemoryId(): string {
  return `mem_${shortHex(3)}`;
}

export function generateQueueId(): string {
  return `q_${shortHex(3)}`;
}
