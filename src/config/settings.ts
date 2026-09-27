/** Written in `.env.limits` to turn a single limit or budget off. */
export const OFF = 'off';

export const WHOLE_NUMBER = /^\d+$/;

export function isOff(value: string): boolean {
  return value.toLowerCase() === OFF;
}
