/**
 * Integration test: a real (headless, test-only) Chromium tab whose network is mocked with
 * page.route. The page's own script fetches "available-calendar" on load, exactly like the
 * real site does; the watcher only listens. Telegram is mocked via an injected fetch.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { chromium, type Browser, type Page } from 'playwright';
import type { Config } from '../src/config.js';
import { createNotifier, type Notifier } from '../src/notify.js';
import { Watcher, evaluateCalendar, type CalendarResult } from '../src/watcher.js';

const URL = 'https://stadt.muenchen.de/buergerservice/terminvereinbarung.html#/services/10339028/locations/10461';
const CALENDAR_API = 'https://stadt.muenchen.de/api/available-calendar?office=10461';

const PAGE_HTML = `<!doctype html><html><body><h1>Terminvereinbarung (mock)</h1>
<script>fetch(${JSON.stringify(CALENDAR_API)}).then(r => r.json()).then(d => {
  document.body.insertAdjacentHTML('beforeend', '<pre id="out">' + JSON.stringify(d) + '</pre>');
});</script></body></html>`;

const log = pino({ level: 'silent' });
let browser: Browser;
let tmp: string;

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    url: URL,
    hotWindows: [],
    coldIntervalSec: 1, // tests bypass validateConfig's 15 s floor on purpose
    activeHours: { start: '07:00', end: '16:00' },
    weekdaysOnly: true,
    telegram: { botToken: 'TEST_TOKEN', chatId: '42' },
    sound: false,
    toast: false,
    responseTimeoutSec: 30,
    minIntervalSec: 1,
    profileDir: path.join(tmp, 'profile'),
    logDir: path.join(tmp, 'logs'),
    ...over,
  };
}

interface Mocks {
  telegramCalls: Array<{ url: string; body: Record<string, unknown> }>;
  notifier: Notifier;
  alerts: string[];
  attentions: string[];
}

function makeMocks(cfg: Config): Mocks {
  const telegramCalls: Mocks['telegramCalls'] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    telegramCalls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response('{"ok":true}', { status: 200 });
  };
  const real = createNotifier(cfg, log, { fetchFn });
  const alerts: string[] = [];
  const attentions: string[] = [];
  const notifier: Notifier = {
    alert: async (t, m, u) => { alerts.push(`${t} | ${m} | ${u ?? ''}`); await real.alert(t, m, u); },
    attention: async (t, m) => { attentions.push(`${t} | ${m}`); await real.attention(t, m); },
    info: (m) => real.info(m),
  };
  return { telegramCalls, notifier, alerts, attentions };
}

/** Weekday (Mon 2026-09-14) inside active hours, so the schedule is always "active". */
const activeNow = () => new Date(2026, 8, 14, 12, 15, 0);

async function newPage(calendarBody: unknown | null, status = 200): Promise<{ page: Page; hits: () => number }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let hits = 0;
  await page.route('**/available-calendar*', async (route) => {
    hits++;
    if (calendarBody === null) return; // never answer: simulates a page that did not load the calendar
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(calendarBody) });
  });
  await page.route('**/terminvereinbarung.html*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE_HTML }),
  );
  return { page, hits: () => hits };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kvr-watcher-test-'));
  fs.mkdirSync(path.join(tmp, 'logs'), { recursive: true });
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('evaluateCalendar (pure)', () => {
  test('nothing free', () => {
    const r = evaluateCalendar(200, { prevBookableDate: null, nextBookableDate: null, availableDays: [] });
    assert.deepEqual(r, { available: false, availableDays: 0, nextBookableDate: null });
  });
  test('availableDays non-empty', () => {
    const r = evaluateCalendar(200, { nextBookableDate: null, availableDays: [{ time: '2026-09-20' }] });
    assert.equal(r.available, true);
    assert.equal(r.availableDays, 1);
  });
  test('nextBookableDate set', () => {
    const r = evaluateCalendar(200, { nextBookableDate: '2026-10-01', availableDays: [] });
    assert.equal(r.available, true);
    assert.equal(r.nextBookableDate, '2026-10-01');
  });
  test('error status never counts as available', () => {
    assert.equal(evaluateCalendar(403, { availableDays: [1] }).available, false);
  });
  test('garbage body is not available', () => {
    assert.equal(evaluateCalendar(200, null).available, false);
    assert.equal(evaluateCalendar(200, 'x').available, false);
  });
});

describe('Watcher (headless Chromium + mocked network)', () => {
  test('alert path: one available day -> alert fires, Telegram gets the link, polling stops', async () => {
    const cfg = makeConfig();
    const mocks = makeMocks(cfg);
    const { page, hits } = await newPage({
      prevBookableDate: null,
      nextBookableDate: '2026-09-20',
      availableDays: [{ time: '2026-09-20', providerIDs: '1' }],
    });

    let afterAlertResult: CalendarResult | null = null;
    const watcher = new Watcher(cfg, {
      log,
      notifier: mocks.notifier,
      now: activeNow,
      waitForEnter: async () => assert.fail('waitForEnter must not be called on the alert path'),
      afterAlert: async (r) => { afterAlertResult = r; return 'stop'; },
    });

    const outcome = await watcher.run(page);
    assert.equal(outcome.reason, 'alert');
    assert.equal(afterAlertResult!.availableDays, 1);
    assert.equal(afterAlertResult!.nextBookableDate, '2026-09-20');

    assert.equal(mocks.alerts.length, 1, 'exactly one alert');
    assert.match(mocks.alerts[0], /availableDays=1/);
    assert.ok(mocks.alerts[0].includes(URL), 'alert carries the booking URL');
    assert.equal(mocks.attentions.length, 0);

    const tg = mocks.telegramCalls;
    assert.equal(tg.length, 1, 'one Telegram message');
    assert.equal(tg[0].url, 'https://api.telegram.org/botTEST_TOKEN/sendMessage');
    assert.equal(tg[0].body.chat_id, '42');
    assert.ok(String(tg[0].body.text).includes(URL));

    const hitsAtAlert = hits();
    assert.equal(hitsAtAlert, 1, 'calendar fetched once by the page');
    await sleep(2500); // interval is 1 s: any further reload would have shown up here
    assert.equal(hits(), hitsAtAlert, 'no reload after the alert: polling stopped');
    await page.context().close();
  });

  test('nothing free: keeps reloading at the interval, never alerts, stop() ends the loop', async () => {
    const cfg = makeConfig();
    const mocks = makeMocks(cfg);
    const { page, hits } = await newPage({ prevBookableDate: null, nextBookableDate: null, availableDays: [] });

    const watcher = new Watcher(cfg, {
      log,
      notifier: mocks.notifier,
      now: activeNow,
      waitForEnter: async () => assert.fail('no pause expected in normal conditions'),
      afterAlert: async () => assert.fail('no alert expected'),
    });
    const run = watcher.run(page);
    const t0 = Date.now();
    while (hits() < 3 && Date.now() - t0 < 10_000) await sleep(100);
    assert.ok(hits() >= 3, `expected repeated reloads, got ${hits()}`);
    watcher.stop();
    const outcome = await run;
    assert.equal(outcome.reason, 'stopped');
    assert.equal(mocks.alerts.length, 0);
    assert.equal(mocks.telegramCalls.length, 0);
    await page.context().close();
  });

  test('pause path: no calendar response -> screenshot, attention notice, waits for Enter', async () => {
    const cfg = makeConfig({ responseTimeoutSec: 1 });
    const mocks = makeMocks(cfg);
    const { page } = await newPage(null);

    let enterPrompts = 0;
    const watcher = new Watcher(cfg, {
      log,
      notifier: mocks.notifier,
      now: activeNow,
      waitForEnter: async () => { enterPrompts++; watcher.stop(); },
      afterAlert: async () => assert.fail('no alert expected'),
    });
    const outcome = await watcher.run(page);
    assert.equal(outcome.reason, 'stopped');
    assert.equal(enterPrompts, 1);
    assert.equal(mocks.attentions.length, 1);
    assert.match(mocks.attentions[0], /manual check/);
    assert.match(mocks.telegramCalls[0].body.text as string, /manual check/);
    const shots = fs.readdirSync(cfg.logDir).filter((f) => f.startsWith('manual-check-') && f.endsWith('.png'));
    assert.equal(shots.length, 1, 'one screenshot written');
    await page.context().close();
  });

  test('pause 3x within an hour doubles the interval and says so', async () => {
    const cfg = makeConfig({ responseTimeoutSec: 1 });
    const mocks = makeMocks(cfg);
    const { page } = await newPage(null);
    let pauses = 0;
    const watcher = new Watcher(cfg, {
      log,
      notifier: mocks.notifier,
      now: activeNow,
      waitForEnter: async () => { if (++pauses >= 3) watcher.stop(); },
      afterAlert: async () => assert.fail('no alert expected'),
    });
    await watcher.run(page);
    assert.equal(pauses, 3);
    assert.equal(watcher.currentMultiplier, 2);
    assert.ok(mocks.attentions.some((a) => /doubled/.test(a)), 'user told about the slowdown');
    await page.context().close();
  });

  test('HTTP 429 on the calendar -> attention notice, no alert', async () => {
    const cfg = makeConfig();
    const mocks = makeMocks(cfg);
    const { page, hits } = await newPage({ error: 'too many' }, 429);
    const watcher = new Watcher(cfg, {
      log,
      notifier: mocks.notifier,
      now: activeNow,
      waitForEnter: async () => assert.fail('no pause expected'),
      afterAlert: async () => assert.fail('no alert expected'),
    });
    const run = watcher.run(page);
    const t0 = Date.now();
    while (mocks.attentions.length === 0 && Date.now() - t0 < 10_000) await sleep(50);
    watcher.stop();
    await run;
    assert.equal(hits(), 1);
    assert.match(mocks.attentions[0], /429/);
    assert.equal(mocks.alerts.length, 0);
    await page.context().close();
  });
});

describe('Watcher: visible check widget', () => {
  test('a sizeable visible "captcha" iframe still there after the grace period pauses before the timeout', async () => {
    const cfg = makeConfig({ responseTimeoutSec: 8 }); // grace = 4 s, timeout = 8 s
    const mocks = makeMocks(cfg);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.route('**/terminvereinbarung.html*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><body><iframe title="Captcha challenge" src="about:blank" style="width:300px;height:300px"></iframe></body></html>',
      }),
    );
    const watcher: Watcher = new Watcher(cfg, {
      log,
      notifier: mocks.notifier,
      now: activeNow,
      waitForEnter: async (): Promise<void> => { watcher.stop(); },
      afterAlert: async () => assert.fail('no alert expected'),
    });
    const t0 = Date.now();
    const outcome = await watcher.run(page);
    assert.equal(outcome.reason, 'stopped');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 3_500, `must not pause before the grace period (took ${elapsed} ms)`);
    assert.ok(elapsed < 7_500, `paused before the 8 s response timeout (took ${elapsed} ms)`);
    assert.equal(mocks.attentions.length, 1);
    assert.match(mocks.attentions[0], /check widget is visible/);
    await ctx.close();
  });

  test('a hidden/tiny "captcha" element does not trigger a pause', async () => {
    const cfg = makeConfig();
    const mocks = makeMocks(cfg);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let hits = 0;
    await page.route('**/available-calendar*', (route) => {
      hits++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"prevBookableDate":null,"nextBookableDate":null,"availableDays":[]}' });
    });
    await page.route('**/terminvereinbarung.html*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: PAGE_HTML.replace('</body>', '<div class="captcha-badge" style="width:60px;height:20px"></div><iframe src="https://x/captcha" style="display:none"></iframe></body>'),
      }),
    );
    const watcher = new Watcher(cfg, {
      log,
      notifier: mocks.notifier,
      now: activeNow,
      waitForEnter: async () => assert.fail('must not pause for an invisible/small element'),
      afterAlert: async () => assert.fail('no alert expected'),
    });
    const run = watcher.run(page);
    const t0 = Date.now();
    while (hits < 2 && Date.now() - t0 < 10_000) await sleep(100);
    watcher.stop();
    await run;
    assert.ok(hits >= 2);
    assert.equal(mocks.attentions.length, 0);
    await ctx.close();
  });
});
