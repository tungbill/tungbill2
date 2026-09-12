/**
 * The watcher is a passive observer of one browser tab:
 *
 *   load page  ->  the page's own JS fetches "available-calendar"  ->  we read that response
 *              ->  wait according to the schedule  ->  reload  ->  ...
 *
 * It never clicks, types, submits, calls the site's API, or touches any check widget.
 * The only browser actions it performs are: goto/reload, screenshot, bringToFront.
 */
import path from 'node:path';
import type { Page, Response } from 'playwright';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { Notifier } from './notify.js';
import { backoffSec, decide, humanDuration } from './schedule.js';

export const CALENDAR_URL_MARKER = 'available-calendar';

export interface CalendarResult {
  available: boolean;
  availableDays: number;
  nextBookableDate: string | null;
  status: number;
  url: string;
  raw: unknown;
  /** Which load (1-based) this response belongs to. */
  loadSeq: number;
  at: Date;
}

export interface WatcherDeps {
  log: Logger;
  notifier: Notifier;
  /** Block until the human presses Enter in the console. */
  waitForEnter(prompt: string): Promise<void>;
  /** Called once a free slot was reported and the alert went out. */
  afterAlert(result: CalendarResult): Promise<'resume' | 'stop'>;
  now?: () => Date;
}

export type RunOutcome =
  | { reason: 'alert'; result: CalendarResult }
  | { reason: 'stopped' };

/** Pure: turn an HTTP status + parsed JSON body into a CalendarResult (minus bookkeeping fields). */
export function evaluateCalendar(status: number, body: unknown): Pick<CalendarResult, 'available' | 'availableDays' | 'nextBookableDate'> {
  const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const days = Array.isArray(o.availableDays) ? o.availableDays.length : 0;
  const nextRaw = o.nextBookableDate;
  const next = nextRaw === null || nextRaw === undefined || nextRaw === '' ? null : String(nextRaw);
  return { available: status < 400 && (days > 0 || next !== null), availableDays: days, nextBookableDate: next };
}

export const RATE_LIMIT_STATUSES = new Set([429, 403]);

/**
 * Selectors that would indicate an *interactive* check. We only look; we never click.
 * The bounding-box filter below keeps tiny/invisible badges from counting.
 */
const CAPTCHA_SELECTOR = [
  'iframe[src*="captcha" i]',
  'iframe[title*="captcha" i]',
  'iframe[src*="challenge" i]',
  '[class*="captcha" i]',
  '[id*="captcha" i]',
].join(', ');

const MIN_CHALLENGE_WIDTH = 150;
const MIN_CHALLENGE_HEIGHT = 60;

export class Watcher {
  private readonly log: Logger;
  private readonly now: () => Date;
  private stopped = false;
  private loadSeq = 0;
  private waiters: Array<{ minSeq: number; resolve: (r: CalendarResult) => void }> = [];
  private wakeSleep: (() => void) | null = null;
  private pendingAlert: CalendarResult | null = null;
  private rateLimitAttempt = 0;
  private pauseTimes: Date[] = [];
  private intervalMultiplier = 1;

  constructor(private readonly cfg: Config, private readonly deps: WatcherDeps) {
    this.log = deps.log;
    this.now = deps.now ?? (() => new Date());
  }

  /** Ask the loop to end at the next opportunity (Ctrl+C, browser closed). */
  stop(): void {
    this.stopped = true;
    this.wake();
  }

  get currentMultiplier(): number {
    return this.intervalMultiplier;
  }

  async run(page: Page): Promise<RunOutcome> {
    page.on('response', (res) => void this.onResponse(res));
    page.on('close', () => this.stop());

    let first = true;
    while (!this.stopped) {
      const decision = decide(this.now(), this.cfg);
      if (decision.state === 'sleep') {
        const ms = decision.until.getTime() - this.now().getTime();
        this.log.info(
          { reason: decision.reason, until: decision.until.toLocaleString('de-DE') },
          `outside active hours, sleeping ${humanDuration(ms / 1000)} until ${decision.until.toLocaleString('de-DE')}`,
        );
        await this.sleep(ms);
        continue;
      }

      const outcome = await this.cycle(page, first);
      first = false;
      if (outcome === 'stop') return { reason: 'stopped' };
      if (outcome === 'pause') continue; // human handled something, re-check right away
      if (outcome === 'alert' && this.pendingAlert) {
        const result = this.pendingAlert;
        this.pendingAlert = null;
        const next = await this.handleAlert(page, result);
        if (next === 'stop') return { reason: 'alert', result };
        continue; // resume: reload right away
      }

      const baseSec = decision.intervalSec * this.intervalMultiplier;
      const waitSec = outcome === 'rate-limited' ? backoffSec(baseSec, this.rateLimitAttempt) : baseSec;
      this.log.info(
        { intervalSec: waitSec, hot: decision.hotWindow?.start ?? null, multiplier: this.intervalMultiplier },
        `next reload in ${humanDuration(waitSec)}`,
      );
      await this.sleep(waitSec * 1000);
      if (this.pendingAlert) {
        // a late response in the same load reported availability
        const result = this.pendingAlert;
        this.pendingAlert = null;
        const next = await this.handleAlert(page, result);
        if (next === 'stop') return { reason: 'alert', result };
      }
    }
    return { reason: 'stopped' };
  }

  // ---------------------------------------------------------------- one load

  private async cycle(page: Page, first: boolean): Promise<'ok' | 'alert' | 'pause' | 'rate-limited' | 'stop'> {
    const seq = ++this.loadSeq;
    this.pendingAlert = null; // anything from a previous load is stale now
    const timeoutMs = this.cfg.responseTimeoutSec * 1000;
    const calendar = this.waitForCalendar(seq, timeoutMs);

    this.log.info({ load: seq }, first ? 'opening page' : 'reloading page');
    let navStatus: number | null = null;
    try {
      const res = first
        ? await page.goto(this.cfg.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        : await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      navStatus = res?.status() ?? null;
    } catch (e) {
      if (this.stopped) return 'stop';
      this.log.warn({ err: (e as Error).message }, 'navigation failed (network?), will retry after the interval');
      this.cancelWaiter(seq);
      return 'ok';
    }
    if (this.stopped) return 'stop';

    if (navStatus !== null && RATE_LIMIT_STATUSES.has(navStatus)) {
      this.cancelWaiter(seq);
      return this.rateLimited(navStatus, 'page');
    }

    let raceOver = false;
    const result = await Promise.race([
      calendar,
      this.watchForChallenge(page, timeoutMs, () => raceOver || this.stopped),
    ]);
    raceOver = true;
    if (this.stopped) return 'stop';

    if (result === 'challenge' || result === null) {
      await this.pause(page, result === 'challenge' ? 'challenge-visible' : 'no-calendar-response');
      return this.stopped ? 'stop' : 'pause';
    }

    if (RATE_LIMIT_STATUSES.has(result.status)) {
      return this.rateLimited(result.status, 'calendar');
    }
    if (result.status >= 400) {
      this.log.warn({ status: result.status }, 'calendar request returned an error status');
      return 'ok';
    }

    this.rateLimitAttempt = 0;
    this.log.info(
      { availableDays: result.availableDays, nextBookableDate: result.nextBookableDate, status: result.status },
      `availableDays=${result.availableDays} nextBookableDate=${result.nextBookableDate ?? 'null'}`,
    );
    if (result.available) {
      this.pendingAlert = result;
      return 'alert';
    }
    return 'ok';
  }

  private rateLimited(status: number, where: 'page' | 'calendar'): 'rate-limited' {
    this.rateLimitAttempt += 1;
    const msg = `HTTP ${status} on ${where} load (attempt ${this.rateLimitAttempt}) — backing off`;
    this.log.warn({ status, attempt: this.rateLimitAttempt }, msg);
    if (this.rateLimitAttempt === 1 || this.rateLimitAttempt % 5 === 0) {
      void this.deps.notifier.attention('Site is rate limiting', msg);
    }
    return 'rate-limited';
  }

  // ------------------------------------------------------------ alert & pause

  private async handleAlert(page: Page, result: CalendarResult): Promise<'resume' | 'stop'> {
    const summary =
      `availableDays=${result.availableDays}` +
      (result.nextBookableDate ? `, nextBookableDate=${result.nextBookableDate}` : '');
    this.log.info({ availableDays: result.availableDays, nextBookableDate: result.nextBookableDate }, 'SLOT AVAILABLE');
    await page.bringToFront().catch(() => undefined);
    await this.deps.notifier.alert('KVR: appointment slot available!', `${summary}. Go book it now.`, this.cfg.url);
    if (this.stopped) return 'stop';
    return this.deps.afterAlert(result);
  }

  private async pause(page: Page, why: 'challenge-visible' | 'no-calendar-response'): Promise<void> {
    const now = this.now();
    this.pauseTimes = this.pauseTimes.filter((t) => now.getTime() - t.getTime() < 60 * 60 * 1000);
    this.pauseTimes.push(now);

    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const shot = path.join(this.cfg.logDir, `manual-check-${stamp}.png`);
    await page.screenshot({ path: shot }).catch((e: Error) => this.log.warn({ err: e.message }, 'screenshot failed'));

    const reason =
      why === 'challenge-visible'
        ? 'a check widget is visible on the page'
        : `no calendar response within ${this.cfg.responseTimeoutSec} s`;
    this.log.warn({ why, screenshot: shot, pausesLastHour: this.pauseTimes.length }, `paused: ${reason}`);
    await page.bringToFront().catch(() => undefined);
    await this.deps.notifier.attention(
      'Site is asking for a manual check',
      `${reason}. Handle it in the browser window, then press Enter in the console.`,
    );

    if (this.pauseTimes.length >= 3) {
      this.intervalMultiplier *= 2;
      this.pauseTimes = [];
      const msg = `Paused 3 times within an hour — polling interval doubled (now x${this.intervalMultiplier}).`;
      this.log.warn({ multiplier: this.intervalMultiplier }, msg);
      void this.deps.notifier.attention('Slowing down', msg);
    }

    if (this.stopped) return;
    await this.deps.waitForEnter('>>> Handle the check in the browser, then press Enter here to continue... ');
    this.log.info('resumed by user');
  }

  // ------------------------------------------------------ response plumbing

  private async onResponse(res: Response): Promise<void> {
    const url = res.url();
    if (!url.includes(CALENDAR_URL_MARKER)) return;
    const status = res.status();
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      try {
        const text = await res.text();
        this.log.debug({ status, url, text: text.slice(0, 200) }, 'calendar response is not JSON');
      } catch {
        /* response body may be gone after navigation */
      }
    }
    const result: CalendarResult = {
      ...evaluateCalendar(status, body),
      status,
      url,
      raw: body,
      loadSeq: this.loadSeq,
      at: this.now(),
    };
    this.log.debug({ status, url, availableDays: result.availableDays, nextBookableDate: result.nextBookableDate }, 'calendar response');

    const waiting = this.waiters.filter((w) => result.loadSeq >= w.minSeq);
    this.waiters = this.waiters.filter((w) => result.loadSeq < w.minSeq);
    for (const w of waiting) w.resolve(result);

    // A later response in the same load may report availability while we sleep: don't miss it.
    if (waiting.length === 0 && result.available && result.loadSeq === this.loadSeq && !this.pendingAlert) {
      this.pendingAlert = result;
      this.wake();
    }
  }

  private waitForCalendar(minSeq: number, timeoutMs: number): Promise<CalendarResult | null> {
    return new Promise((resolve) => {
      const entry = {
        minSeq,
        resolve: (r: CalendarResult) => {
          clearTimeout(timer);
          resolve(r);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== entry);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.waiters.push(entry);
    });
  }

  private cancelWaiter(seq: number): void {
    this.waiters = this.waiters.filter((w) => w.minSeq !== seq);
  }

  /**
   * Poll (read-only) for a sizeable visible check widget while the calendar response is outstanding.
   * Some widgets show briefly and complete on their own; only after a grace period (half the
   * response timeout) with no calendar response does a still-visible widget count as a challenge.
   */
  private async watchForChallenge(page: Page, timeoutMs: number, cancelled: () => boolean): Promise<'challenge' | never> {
    const deadline = Date.now() + timeoutMs;
    const graceUntil = Date.now() + timeoutMs / 2;
    while (Date.now() < graceUntil && !cancelled()) {
      await new Promise((r) => setTimeout(r, 500).unref?.());
    }
    while (Date.now() < deadline && !cancelled()) {
      if (await this.challengeVisible(page)) return 'challenge';
      // plain timer on purpose: must not touch the interruptible interval sleep
      await new Promise((r) => setTimeout(r, 2000).unref?.());
    }
    return new Promise<never>(() => undefined); // never settles; the calendar/timeout branch wins the race
  }

  private async challengeVisible(page: Page): Promise<boolean> {
    try {
      const boxes = await page.locator(CAPTCHA_SELECTOR).evaluateAll((els) =>
        els.map((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const cs = getComputedStyle(el as HTMLElement);
          const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
          return { w: r.width, h: r.height, visible };
        }),
      );
      return boxes.some((b) => b.visible && b.w >= MIN_CHALLENGE_WIDTH && b.h >= MIN_CHALLENGE_HEIGHT);
    } catch {
      return false; // page navigating / closed
    }
  }

  // ------------------------------------------------------------------- sleep

  private sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        if (self.wakeSleep === done) self.wakeSleep = null;
        resolve();
      }
      this.wakeSleep = done;
    });
  }

  private wake(): void {
    this.wakeSleep?.();
  }
}
