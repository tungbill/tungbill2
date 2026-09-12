/**
 * Pure scheduling logic. No I/O, no timers: every function takes `now` explicitly
 * so it is trivial to unit test. All times are LOCAL time of the machine running
 * the tool (the same clock the booking page shows).
 */
import { parseHHMM, type Config, type HotWindow } from './config.js';

export type ScheduleDecision =
  | { state: 'active'; intervalSec: number; hotWindow: HotWindow | null }
  | { state: 'sleep'; until: Date; reason: 'outside-active-hours' | 'weekend' };

export type ScheduleConfig = Pick<Config, 'hotWindows' | 'coldIntervalSec' | 'activeHours' | 'weekdaysOnly'>;

export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

export function isWeekend(d: Date): boolean {
  const day = d.getDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}

/** True when `d` falls inside [start, end) of the given HH:MM window. */
export function inWindow(d: Date, start: string, end: string): boolean {
  const m = minutesOfDay(d);
  return m >= parseHHMM(start, 'start') && m < parseHHMM(end, 'end');
}

export function isActiveDay(d: Date, cfg: ScheduleConfig): boolean {
  return !(cfg.weekdaysOnly && isWeekend(d));
}

export function isActiveTime(d: Date, cfg: ScheduleConfig): boolean {
  return isActiveDay(d, cfg) && inWindow(d, cfg.activeHours.start, cfg.activeHours.end);
}

/** The first hot window that contains `d`, or null. Earlier entries win on overlap. */
export function currentHotWindow(d: Date, cfg: ScheduleConfig): HotWindow | null {
  for (const w of cfg.hotWindows) {
    if (inWindow(d, w.start, w.end)) return w;
  }
  return null;
}

/** Polling interval to use at `d`, ignoring active hours. */
export function intervalAt(d: Date, cfg: ScheduleConfig): number {
  return currentHotWindow(d, cfg)?.intervalSec ?? cfg.coldIntervalSec;
}

function atTime(day: Date, hhmm: string): Date {
  const mins = parseHHMM(hhmm, 'time');
  const r = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
  r.setMinutes(mins);
  return r;
}

/**
 * Next moment (strictly after `now`) at which active hours begin,
 * skipping weekend days when `weekdaysOnly` is set.
 */
export function nextActiveStart(now: Date, cfg: ScheduleConfig): Date {
  for (let offset = 0; offset < 14; offset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    if (!isActiveDay(day, cfg)) continue;
    const start = atTime(day, cfg.activeHours.start);
    if (start > now) return start;
  }
  // Unreachable with a sane config (there is always a weekday within 14 days).
  throw new Error('nextActiveStart: no active day found within 14 days');
}

/** Decide what to do right now: poll with a given interval, or sleep until a given time. */
export function decide(now: Date, cfg: ScheduleConfig): ScheduleDecision {
  if (!isActiveDay(now, cfg)) {
    return { state: 'sleep', until: nextActiveStart(now, cfg), reason: 'weekend' };
  }
  if (!inWindow(now, cfg.activeHours.start, cfg.activeHours.end)) {
    return { state: 'sleep', until: nextActiveStart(now, cfg), reason: 'outside-active-hours' };
  }
  const hotWindow = currentHotWindow(now, cfg);
  return { state: 'active', intervalSec: hotWindow?.intervalSec ?? cfg.coldIntervalSec, hotWindow };
}

/**
 * Exponential back-off for HTTP 429/403: base * 2^attempt, capped.
 * attempt 0 -> base, 1 -> 2*base, 2 -> 4*base ...
 */
export function backoffSec(baseSec: number, attempt: number, capSec = 30 * 60): number {
  const n = Math.max(0, Math.min(attempt, 20));
  return Math.min(capSec, baseSec * 2 ** n);
}

/** Small helper for the console: "3 min 20 s" style. */
export function humanDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (r || parts.length === 0) parts.push(`${r} s`);
  return parts.join(' ');
}
