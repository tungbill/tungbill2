import fs from 'node:fs';
import path from 'node:path';

export interface HotWindow {
  /** "HH:MM" local time, inclusive */
  start: string;
  /** "HH:MM" local time, exclusive */
  end: string;
  intervalSec: number;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface Config {
  url: string;
  hotWindows: HotWindow[];
  coldIntervalSec: number;
  activeHours: { start: string; end: string };
  weekdaysOnly: boolean;
  telegram: TelegramConfig;
  sound: boolean;
  toast: boolean;
  /** Seconds to wait for the available-calendar response after a load before pausing. */
  responseTimeoutSec: number;
  /** Absolute floor for any polling interval. Never goes below this, whatever the config says. */
  minIntervalSec: number;
  /** Folder for the persistent Chromium profile (cookies, consent). */
  profileDir: string;
  /** Folder for logs and screenshots. */
  logDir: string;
}

/** Hard floor. The site is a public service; we refresh no faster than a patient human would. */
export const HARD_MIN_INTERVAL_SEC = 15;

export const DEFAULTS = {
  responseTimeoutSec: 30,
  minIntervalSec: HARD_MIN_INTERVAL_SEC,
  profileDir: 'browser-profile',
  logDir: 'logs',
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseHHMM(value: string, field: string): number {
  const m = HHMM.exec(value);
  if (!m) throw new ConfigError(`${field}: expected "HH:MM", got ${JSON.stringify(value)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`config.json: ${message}`);
    this.name = 'ConfigError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqString(o: Record<string, unknown>, key: string, ctx: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new ConfigError(`${ctx}${key} must be a string`);
  return v;
}

function reqPositiveInt(o: Record<string, unknown>, key: string, ctx: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new ConfigError(`${ctx}${key} must be a positive number`);
  }
  return Math.round(v);
}

function optBool(o: Record<string, unknown>, key: string, dflt: boolean): boolean {
  const v = o[key];
  if (v === undefined) return dflt;
  if (typeof v !== 'boolean') throw new ConfigError(`${key} must be true or false`);
  return v;
}

/** Validate a parsed JSON object and fill in defaults. Throws ConfigError with a readable message. */
export function validateConfig(raw: unknown, baseDir = process.cwd()): Config {
  if (!isRecord(raw)) throw new ConfigError('top level must be an object');

  const url = reqString(raw, 'url', '');
  if (!/^https:\/\/stadt\.muenchen\.de\//.test(url)) {
    throw new ConfigError('url must start with https://stadt.muenchen.de/');
  }

  const minIntervalSec = Math.max(
    HARD_MIN_INTERVAL_SEC,
    raw.minIntervalSec === undefined ? DEFAULTS.minIntervalSec : reqPositiveInt(raw, 'minIntervalSec', ''),
  );

  const hotWindowsRaw = raw.hotWindows === undefined ? [] : raw.hotWindows;
  if (!Array.isArray(hotWindowsRaw)) throw new ConfigError('hotWindows must be an array');
  const hotWindows: HotWindow[] = hotWindowsRaw.map((w, i) => {
    const ctx = `hotWindows[${i}].`;
    if (!isRecord(w)) throw new ConfigError(`hotWindows[${i}] must be an object`);
    const start = reqString(w, 'start', ctx);
    const end = reqString(w, 'end', ctx);
    if (parseHHMM(start, ctx + 'start') >= parseHHMM(end, ctx + 'end')) {
      throw new ConfigError(`${ctx}start must be before end`);
    }
    const intervalSec = Math.max(minIntervalSec, reqPositiveInt(w, 'intervalSec', ctx));
    return { start, end, intervalSec };
  });

  const coldIntervalSec = Math.max(minIntervalSec, reqPositiveInt(raw, 'coldIntervalSec', ''));

  if (!isRecord(raw.activeHours)) throw new ConfigError('activeHours must be an object');
  const activeHours = {
    start: reqString(raw.activeHours, 'start', 'activeHours.'),
    end: reqString(raw.activeHours, 'end', 'activeHours.'),
  };
  if (parseHHMM(activeHours.start, 'activeHours.start') >= parseHHMM(activeHours.end, 'activeHours.end')) {
    throw new ConfigError('activeHours.start must be before activeHours.end');
  }

  const telegramRaw = raw.telegram === undefined ? {} : raw.telegram;
  if (!isRecord(telegramRaw)) throw new ConfigError('telegram must be an object');
  const telegram: TelegramConfig = {
    botToken: typeof telegramRaw.botToken === 'string' ? telegramRaw.botToken.trim() : '',
    chatId: typeof telegramRaw.chatId === 'string' || typeof telegramRaw.chatId === 'number'
      ? String(telegramRaw.chatId).trim()
      : '',
  };
  if ((telegram.botToken === '') !== (telegram.chatId === '')) {
    throw new ConfigError('telegram: set both botToken and chatId, or leave both empty');
  }

  const responseTimeoutSec =
    raw.responseTimeoutSec === undefined ? DEFAULTS.responseTimeoutSec : reqPositiveInt(raw, 'responseTimeoutSec', '');

  const profileDir = path.resolve(
    baseDir,
    typeof raw.profileDir === 'string' ? raw.profileDir : DEFAULTS.profileDir,
  );
  const logDir = path.resolve(baseDir, typeof raw.logDir === 'string' ? raw.logDir : DEFAULTS.logDir);

  return {
    url,
    hotWindows,
    coldIntervalSec,
    activeHours,
    weekdaysOnly: optBool(raw, 'weekdaysOnly', true),
    telegram,
    sound: optBool(raw, 'sound', true),
    toast: optBool(raw, 'toast', true),
    responseTimeoutSec,
    minIntervalSec,
    profileDir,
    logDir,
  };
}

/** Read and validate config.json. Environment variables TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID override the file. */
export function loadConfig(file: string): Config {
  if (!fs.existsSync(file)) {
    throw new ConfigError(`${file} not found. Copy config.example.json to config.json and edit it.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`not valid JSON (${(e as Error).message})`);
  }
  if (isRecord(raw)) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_CHAT_ID;
    if (token || chat) {
      const t = isRecord(raw.telegram) ? raw.telegram : {};
      raw.telegram = { ...t, ...(token ? { botToken: token } : {}), ...(chat ? { chatId: chat } : {}) };
    }
  }
  return validateConfig(raw, path.dirname(path.resolve(file)));
}
