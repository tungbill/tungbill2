import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { chromium, type BrowserContext } from 'playwright';
import { loadConfig, ConfigError } from './config.js';
import { createLogger } from './log.js';
import { createNotifier } from './notify.js';
import { Watcher } from './watcher.js';

// dist/src/index.js -> project root is two levels up
const ROOT = path.resolve(__dirname, '..', '..');
const LOCK_FILE = path.join(ROOT, 'watcher.lock');

function acquireLock(): void {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) {
      console.error(`kvr-termin-watcher is already running (PID ${pid}). Close that window first.`);
      console.error(`If you are sure it is not running, delete ${LOCK_FILE}.`);
      process.exit(2);
    }
    console.log('Removing stale lock file from a previous run.');
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE) && fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  acquireLock();
  process.on('exit', releaseLock);

  let cfg;
  try {
    cfg = loadConfig(path.join(ROOT, 'config.json'));
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  const log = createLogger(cfg.logDir);
  const notifier = createNotifier(cfg, log, { alertWavPath: path.join(ROOT, 'alert.wav') });

  log.info(
    {
      url: cfg.url,
      hotWindows: cfg.hotWindows.map((w) => `${w.start}-${w.end}@${w.intervalSec}s`).join(', ') || 'none',
      coldIntervalSec: cfg.coldIntervalSec,
      activeHours: `${cfg.activeHours.start}-${cfg.activeHours.end}`,
      weekdaysOnly: cfg.weekdaysOnly,
      telegram: cfg.telegram.botToken ? 'on' : 'off',
    },
    'kvr-termin-watcher starting (passive observer: it only reloads and reads, you book)',
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt: string) => new Promise<void>((resolve) => rl.question(prompt, () => resolve()));

  const watcher = new Watcher(cfg, {
    log,
    notifier,
    waitForEnter: ask,
    afterAlert: async () => {
      await ask('>>> Book the appointment in the browser. Press Enter here to resume watching (Ctrl+C to quit)... ');
      return 'resume';
    },
  });

  log.info({ profileDir: cfg.profileDir }, 'launching Chromium (visible window, persistent profile)');
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(cfg.profileDir, {
      headless: false,
      viewport: null,
    });
  } catch (e) {
    log.error({ err: (e as Error).message }, 'could not launch Chromium. Run "npx playwright install chromium" and try again.');
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`shutting down (${why})`);
    watcher.stop();
    rl.close();
    await context.close().catch(() => undefined);
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('Ctrl+C'));
  rl.on('SIGINT', () => void shutdown('Ctrl+C')); // readline swallows Ctrl+C on a TTY unless handled here
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  context.on('close', () => void shutdown('browser window closed'));

  const page = context.pages()[0] ?? (await context.newPage());
  await notifier.info(`kvr-termin-watcher started on ${new Date().toLocaleString('de-DE')}`);

  const outcome = await watcher.run(page);
  log.info({ outcome: outcome.reason }, 'watcher finished');
  await shutdown('finished');
}

main().catch((e) => {
  console.error('fatal:', e);
  releaseLock();
  process.exit(1);
});
