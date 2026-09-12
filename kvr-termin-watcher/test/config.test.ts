import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, ConfigError, HARD_MIN_INTERVAL_SEC } from '../src/config.js';

const base = {
  url: 'https://stadt.muenchen.de/buergerservice/terminvereinbarung.html#/services/10339028/locations/10461',
  hotWindows: [{ start: '07:10', end: '07:50', intervalSec: 20 }],
  coldIntervalSec: 300,
  activeHours: { start: '07:00', end: '16:00' },
  weekdaysOnly: true,
  telegram: { botToken: '', chatId: '' },
  sound: true,
  toast: true,
};

describe('validateConfig', () => {
  test('accepts the example config and fills defaults', () => {
    const c = validateConfig(base, '/x');
    assert.equal(c.responseTimeoutSec, 30);
    assert.equal(c.minIntervalSec, HARD_MIN_INTERVAL_SEC);
    assert.ok(c.profileDir.endsWith('browser-profile'));
    assert.ok(c.logDir.endsWith('logs'));
  });

  test('clamps intervals below the hard floor', () => {
    const c = validateConfig({ ...base, hotWindows: [{ start: '07:10', end: '07:50', intervalSec: 2 }], coldIntervalSec: 1 }, '/x');
    assert.equal(c.hotWindows[0].intervalSec, HARD_MIN_INTERVAL_SEC);
    assert.equal(c.coldIntervalSec, HARD_MIN_INTERVAL_SEC);
  });

  test('rejects a url outside stadt.muenchen.de', () => {
    assert.throws(() => validateConfig({ ...base, url: 'https://example.com/' }), ConfigError);
  });

  test('rejects malformed times and inverted windows', () => {
    assert.throws(() => validateConfig({ ...base, activeHours: { start: '7:00', end: '16:00' } }), /HH:MM/);
    assert.throws(() => validateConfig({ ...base, hotWindows: [{ start: '08:00', end: '07:00', intervalSec: 20 }] }), /before end/);
  });

  test('telegram must be both set or both empty', () => {
    assert.throws(() => validateConfig({ ...base, telegram: { botToken: 'x', chatId: '' } }), /both/);
    const c = validateConfig({ ...base, telegram: { botToken: ' t ', chatId: 123 } });
    assert.equal(c.telegram.botToken, 't');
    assert.equal(c.telegram.chatId, '123');
  });
});
