/**
 * Active hours: local-time ranges such as "23:00-07:00" in which nightshift may start Claude work.
 * A range may cross midnight. Times are the machine's local time zone.
 */

export interface TimeRange {
  /** Minutes after midnight. */
  start: number;
  end: number;
  text: string;
}

const RANGE = /^([01]?\d|2[0-3]):([0-5]\d)\s*-\s*([01]?\d|2[0-3]|24):([0-5]\d)$/;

/** Parses "HH:MM-HH:MM"; returns an error message for anything else. */
export function parseRange(text: string): TimeRange | string {
  const m = RANGE.exec(text.trim());
  if (m === null) return `"${text}" is not a time range like "23:00-07:00"`;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (end > 24 * 60) return `"${text}": the end is after 24:00`;
  if (start === end % (24 * 60))
    return `"${text}" is empty; leave active_hours out to run any time`;
  return { start, end, text: text.trim() };
}

function minutesOf(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function contains(range: TimeRange, minutes: number): boolean {
  return range.start < range.end
    ? minutes >= range.start && minutes < range.end
    : minutes >= range.start || minutes < range.end;
}

export function isActive(ranges: readonly TimeRange[], at: Date): boolean {
  if (ranges.length === 0) return true;
  const minutes = minutesOf(at);
  return ranges.some((range) => contains(range, minutes));
}

/** The next moment (after `at`) at which one of the ranges starts. */
export function nextStart(ranges: readonly TimeRange[], at: Date): Date {
  let best: Date | undefined;
  for (const range of ranges) {
    for (const dayOffset of [0, 1]) {
      const candidate = new Date(at);
      candidate.setDate(candidate.getDate() + dayOffset);
      candidate.setHours(Math.floor(range.start / 60), range.start % 60, 0, 0);
      if (candidate.getTime() <= at.getTime()) continue;
      if (best === undefined || candidate < best) best = candidate;
      break;
    }
  }
  if (best === undefined) throw new Error("no active hours configured");
  return best;
}
