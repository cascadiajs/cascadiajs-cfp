/** An expected failure with an HTTP status and a message safe to show to callers. */
export class CfpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
