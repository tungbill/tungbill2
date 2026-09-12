import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import type { Config } from './config.js';

export type Severity = 'alert' | 'attention' | 'info';

export interface Notifier {
  /** Loud multi-channel alert: sound + toast + Telegram + console. Used when a slot is free. */
  alert(title: string, message: string, url?: string): Promise<void>;
  /** Something needs the human (manual check, back-off, repeated pauses). Toast + Telegram + short sound. */
  attention(title: string, message: string): Promise<void>;
  /** Telegram-only status line (start/stop). Never throws. */
  info(message: string): Promise<void>;
}

export interface NotifyDeps {
  fetchFn?: typeof fetch;
  alertWavPath?: string;
  platform?: NodeJS.Platform;
}

/** Sends a message via the Telegram Bot API using plain fetch. Resolves false on any failure. */
export async function sendTelegram(
  cfg: Config['telegram'],
  text: string,
  log: Logger,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  if (!cfg.botToken || !cfg.chatId) return false;
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log.warn({ status: res.status, body: (await res.text()).slice(0, 200) }, 'telegram send failed');
      return false;
    }
    return true;
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'telegram send error');
    return false;
  }
}

/** Plays a WAV file. Windows: PowerShell SoundPlayer (built in). Other OS: best effort, silent if no player. */
export function playSound(wavPath: string, log: Logger, platform: NodeJS.Platform = process.platform): Promise<void> {
  return new Promise((resolve) => {
    if (!fs.existsSync(wavPath)) {
      log.warn({ wavPath }, 'alert.wav missing, run "npm run gen-alert"');
      process.stdout.write('\x07');
      return resolve();
    }
    let cmd: string;
    let args: string[];
    if (platform === 'win32') {
      cmd = 'powershell';
      args = [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(New-Object System.Media.SoundPlayer '${wavPath.replace(/'/g, "''")}').PlaySync()`,
      ];
    } else if (platform === 'darwin') {
      cmd = 'afplay';
      args = [wavPath];
    } else {
      cmd = 'aplay';
      args = ['-q', wavPath];
    }
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
      child.on('error', (e) => {
        log.warn({ err: e.message }, 'could not play sound');
        process.stdout.write('\x07');
        resolve();
      });
      child.on('exit', () => resolve());
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'could not play sound');
      resolve();
    }
  });
}

export async function showToast(title: string, message: string, log: Logger, sound = true): Promise<void> {
  try {
    const mod = await import('node-notifier');
    const notifier = mod.default;
    await new Promise<void>((resolve) => {
      notifier.notify({ title, message, sound, wait: false, appID: 'KVR Termin Watcher' }, (err) => {
        if (err) log.warn({ err: err.message }, 'toast failed');
        resolve();
      });
      // node-notifier sometimes never calls back on Windows; don't hang on it.
      setTimeout(resolve, 5000).unref();
    });
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'toast unavailable');
  }
}

export function createNotifier(cfg: Config, log: Logger, deps: NotifyDeps = {}): Notifier {
  const fetchFn = deps.fetchFn ?? fetch;
  const wav = deps.alertWavPath ?? path.resolve(process.cwd(), 'alert.wav');
  const platform = deps.platform ?? process.platform;

  const banner = (title: string, message: string) => {
    const line = '='.repeat(64);
    process.stdout.write(`\n${line}\n  ${title}\n  ${message}\n${line}\n\n`);
  };

  return {
    async alert(title, message, url) {
      banner(title, message + (url ? `\n  ${url}` : ''));
      const text = `🔔 ${title}\n${message}${url ? `\n${url}` : ''}`;
      const tasks: Promise<unknown>[] = [sendTelegram(cfg.telegram, text, log, fetchFn)];
      if (cfg.toast) tasks.push(showToast(title, message, log, true));
      if (cfg.sound) {
        tasks.push((async () => {
          for (let i = 0; i < 3; i++) await playSound(wav, log, platform);
        })());
      }
      await Promise.allSettled(tasks);
    },
    async attention(title, message) {
      banner(title, message);
      const tasks: Promise<unknown>[] = [sendTelegram(cfg.telegram, `⚠️ ${title}\n${message}`, log, fetchFn)];
      if (cfg.toast) tasks.push(showToast(title, message, log, true));
      if (cfg.sound) tasks.push(playSound(wav, log, platform));
      await Promise.allSettled(tasks);
    },
    async info(message) {
      await sendTelegram(cfg.telegram, `ℹ️ ${message}`, log, fetchFn);
    },
  };
}
