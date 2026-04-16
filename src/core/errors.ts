export class BunshinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BunshinError";
  }
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new BunshinError(message);
  }
}
