/** A number of seconds, or a number with an ms/s/m/h/d unit, such as `8h` or `15m`. */
export const DURATION_PATTERN = /^(\d+)\s*(ms|s|m|h|d)?$/;

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parses a `DURATION_PATTERN` string to milliseconds; `undefined` when it doesn't match. */
export function parseDuration(value: string): number | undefined {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) {
    return undefined;
  }
  return Number(match[1]) * UNIT_MS[match[2] ?? 's'];
}
