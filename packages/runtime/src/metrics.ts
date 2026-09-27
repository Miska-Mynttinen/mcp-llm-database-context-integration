/** Metric conventions shared by the chat app's and the MCP server's registries. */

export type Outcome = 'success' | 'error';

/** Seconds; database tool calls are usually fast but can hit slow queries. */
export const TOOL_DURATION_BUCKETS: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Seconds elapsed since a `process.hrtime.bigint()` start. */
export function secondsSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e9;
}
