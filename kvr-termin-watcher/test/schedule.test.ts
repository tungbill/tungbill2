import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffSec,
  currentHotWindow,
  decide,
  humanDuration,
  inWindow,
  intervalAt,
  isWeekend,
  nextActiveStart,
  type ScheduleConfig,
} from '../src/schedule.js';

const cfg: ScheduleConfig = {
  hotWindows: [
    { start: '07:10', end: '07:50', intervalSec: 20 },
    { start: '12:00', end: '13:45', intervalSec: 30 },
  ],
  coldIntervalSec: 300,
  activeHours: { start: '07:00', end: '16:00' },
  weekdaysOnly: true,
};

// Local-time constructor so the tests do not depend on the machine's time zone.
// 2026-09-14 is a Monday, 2026-09-12 a Saturday, 2026-09-13 a Sunday.
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0, 0);

describe('inWindow', () => {
  test('start is inclusive, end is exclusive', () => {
    assert.equal(inWindow(local(2026, 9, 14, 7, 10), '07:10', '07:50'), true);
    assert.equal(inWindow(local(2026, 9, 14, 7, 49), '07:10', '07:50'), true);
    assert.equal(inWindow(local(2026, 9, 14, 7, 50), '07:10', '07:50'), false);
    assert.equal(inWindow(local(2026, 9, 14, 7, 9), '07:10', '07:50'), false);
  });
});

describe('isWeekend', () => {
  test('Saturday and Sunday are weekend, Monday and Friday are not', () => {
    assert.equal(isWeekend(local(2026, 9, 12, 10, 0)), true);
    assert.equal(isWeekend(local(2026, 9, 13, 10, 0)), true);
    assert.equal(isWeekend(local(2026, 9, 14, 10, 0)), false);
    assert.equal(isWeekend(local(2026, 9, 18, 10, 0)), false);
  });
});

describe('currentHotWindow / intervalAt', () => {
  test('inside the morning hot window', () => {
    const d = local(2026, 9, 14, 7, 30);
    assert.equal(currentHotWindow(d, cfg)?.start, '07:10');
    assert.equal(intervalAt(d, cfg), 20);
  });
  test('inside the noon hot window', () => {
    const d = local(2026, 9, 14, 13, 44);
    assert.equal(currentHotWindow(d, cfg)?.start, '12:00');
    assert.equal(intervalAt(d, cfg), 30);
  });
  test('outside any hot window falls back to cold interval', () => {
    const d = local(2026, 9, 14, 9, 0);
    assert.equal(currentHotWindow(d, cfg), null);
    assert.equal(intervalAt(d, cfg), 300);
  });
  test('no hot windows at all', () => {
    assert.equal(intervalAt(local(2026, 9, 14, 7, 30), { ...cfg, hotWindows: [] }), 300);
  });
});

describe('nextActiveStart', () => {
  test('before active hours on a weekday -> same day start', () => {
    const next = nextActiveStart(local(2026, 9, 14, 6, 30), cfg);
    assert.deepEqual(next, local(2026, 9, 14, 7, 0));
  });
  test('after active hours on a weekday -> next day start', () => {
    const next = nextActiveStart(local(2026, 9, 14, 16, 0), cfg);
    assert.deepEqual(next, local(2026, 9, 15, 7, 0));
  });
  test('Friday evening -> Monday morning when weekdaysOnly', () => {
    const next = nextActiveStart(local(2026, 9, 18, 17, 0), cfg);
    assert.deepEqual(next, local(2026, 9, 21, 7, 0));
  });
  test('Saturday -> Monday morning when weekdaysOnly', () => {
    const next = nextActiveStart(local(2026, 9, 12, 10, 0), cfg);
    assert.deepEqual(next, local(2026, 9, 14, 7, 0));
  });
  test('Saturday -> Sunday morning when weekends are allowed', () => {
    const next = nextActiveStart(local(2026, 9, 12, 10, 0), { ...cfg, weekdaysOnly: false });
    assert.deepEqual(next, local(2026, 9, 13, 7, 0));
  });
  test('exactly at start time -> the following active day (strictly after now)', () => {
    const next = nextActiveStart(local(2026, 9, 14, 7, 0), cfg);
    assert.deepEqual(next, local(2026, 9, 15, 7, 0));
  });
});

describe('decide', () => {
  test('weekday inside hot window -> active with hot interval', () => {
    const d = decide(local(2026, 9, 14, 12, 15), cfg);
    assert.equal(d.state, 'active');
    if (d.state === 'active') {
      assert.equal(d.intervalSec, 30);
      assert.equal(d.hotWindow?.start, '12:00');
    }
  });
  test('weekday outside hot window -> active with cold interval', () => {
    const d = decide(local(2026, 9, 14, 15, 59), cfg);
    assert.equal(d.state, 'active');
    if (d.state === 'active') {
      assert.equal(d.intervalSec, 300);
      assert.equal(d.hotWindow, null);
    }
  });
  test('weekday before active hours -> sleep until 07:00', () => {
    const d = decide(local(2026, 9, 14, 5, 0), cfg);
    assert.equal(d.state, 'sleep');
    if (d.state === 'sleep') {
      assert.equal(d.reason, 'outside-active-hours');
      assert.deepEqual(d.until, local(2026, 9, 14, 7, 0));
    }
  });
  test('weekday at end of active hours -> sleep until tomorrow', () => {
    const d = decide(local(2026, 9, 14, 16, 0), cfg);
    assert.equal(d.state, 'sleep');
    if (d.state === 'sleep') assert.deepEqual(d.until, local(2026, 9, 15, 7, 0));
  });
  test('Sunday -> sleep until Monday with reason weekend', () => {
    const d = decide(local(2026, 9, 13, 12, 15), cfg);
    assert.equal(d.state, 'sleep');
    if (d.state === 'sleep') {
      assert.equal(d.reason, 'weekend');
      assert.deepEqual(d.until, local(2026, 9, 14, 7, 0));
    }
  });
  test('Sunday is active when weekdaysOnly is false', () => {
    const d = decide(local(2026, 9, 13, 12, 15), { ...cfg, weekdaysOnly: false });
    assert.equal(d.state, 'active');
  });
});

describe('backoffSec', () => {
  test('doubles per attempt and caps', () => {
    assert.equal(backoffSec(30, 0), 30);
    assert.equal(backoffSec(30, 1), 60);
    assert.equal(backoffSec(30, 3), 240);
    assert.equal(backoffSec(300, 10), 1800);
    assert.equal(backoffSec(300, 2, 600), 600);
  });
});

describe('humanDuration', () => {
  test('formats seconds, minutes, hours', () => {
    assert.equal(humanDuration(0), '0 s');
    assert.equal(humanDuration(45), '45 s');
    assert.equal(humanDuration(300), '5 min');
    assert.equal(humanDuration(3725), '1 h 2 min 5 s');
  });
});
