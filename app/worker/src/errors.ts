/**
 * Ambiguity is never an error and never a guess: a tool throws Clarify, and
 * the API answers 200 with `needs_clarification` and nothing written.
 */
export class Clarify extends Error {
  constructor(
    readonly reason: string,
    readonly question: string,
    readonly options: unknown[] = [],
    readonly path: (string | number)[] = [],
    readonly extra: Record<string, unknown> = {},
  ) {
    super(question);
  }

  toResponse(): Record<string, unknown> {
    return {
      status: "needs_clarification",
      reason: this.reason,
      question: this.question,
      options: this.options,
      path: this.path,
      ...this.extra,
    };
  }

  /** The same question, located deeper in the input. */
  at(...prefix: (string | number)[]): Clarify {
    return new Clarify(this.reason, this.question, this.options, [...prefix, ...this.path], this.extra);
  }
}

/** A request the API refuses: not found, not visible, a broken rule. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }

  toResponse(): Record<string, unknown> {
    return { status: "error", error: { code: this.code, message: this.message, ...this.details } };
  }
}

export const notFound = (what: string, id: unknown): ToolError =>
  new ToolError("not_found", `no ${what} ${String(id)}`, 404);
