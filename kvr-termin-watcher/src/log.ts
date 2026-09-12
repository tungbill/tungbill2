import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';

/**
 * pino logger that writes structured JSON to logs/watcher.log and a short
 * human-readable line to the console. No extra transport packages needed.
 */
export function createLogger(logDir: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  fs.mkdirSync(logDir, { recursive: true });
  const file = fs.createWriteStream(path.join(logDir, 'watcher.log'), { flags: 'a' });

  const stream = {
    write(chunk: string) {
      file.write(chunk);
      try {
        const o = JSON.parse(chunk) as Record<string, unknown>;
        const { time, level: lvl, msg, pid: _pid, hostname: _host, ...rest } = o;
        void _pid;
        void _host;
        const ts = new Date(time as number).toLocaleTimeString('de-DE', { hour12: false });
        const label = pino.levels.labels[lvl as number] ?? String(lvl);
        const extra = Object.keys(rest).length ? ' ' + Object.entries(rest).map(([k, v]) => `${k}=${fmt(v)}`).join(' ') : '';
        process.stdout.write(`${ts} ${label.toUpperCase().padEnd(5)} ${msg as string}${extra}\n`);
      } catch {
        process.stdout.write(chunk);
      }
    },
  };

  return pino({ level, base: {} }, stream);
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  const s = JSON.stringify(v);
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}
