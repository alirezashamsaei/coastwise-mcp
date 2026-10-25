import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { findBestWindow, type FindWindowInput } from '../src/window.js';
import { evaluateWindow, hoursInRange, resolveWindow } from '../src/evaluate.js';
import type { Fetcher } from '../src/forecast.js';
import { MARINE_ENDPOINT } from '../src/constants.js';
import type { HourReading, LocationInfo } from '../src/types.js';

const DATE = '2026-10-27';
const LOCATION: LocationInfo = { latitude: 36.53, longitude: -6.29, timezone: 'Europe/Madrid' };

/** A whole day of hourly readings, 00:00–23:00, from a per-hour value map. */
function daySeries(perHour: (hour: number) => Record<string, number | null>): HourReading[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    time: `${DATE}T${String(hour).padStart(2, '0')}:00`,
    values: perHour(hour),
  }));
}

/** Every required beach_day Factor present and comfortable at `hour`. */
function goodHour(hour: number): Record<string, number | null> {
  return { temperature_2m: 27, weather_code: 0, precipitation: 0, wind_speed_10m: 10, uv_index: 5 };
}

function base(overrides: Partial<FindWindowInput> = {}): FindWindowInput {
  return {
    activity: 'beach_day',
    date: DATE,
    hours: daySeries(goodHour),
    location: LOCATION,
    ...overrides,
  };
}

/** Beach-local ISO timestamp for an hour of the fixture date, e.g. `at(7)` → `2026-10-27T07:00`. */
function at(hour: number): string {
  return `${DATE}T${String(hour).padStart(2, '0')}:00`;
}

describe('findBestWindow — stride', () => {
  it('slides a fixed 3-hour block at hourly stride across the default window', () => {
    const result = findBestWindow(base());

    expect(result.windowHours).toBe(3);
    expect(result.strideHours).toBe(1);
    expect(result.searched).toEqual({ start: '07:00', end: '19:00', timezone: 'Europe/Madrid' });

    // 07:00 → 17:00 inclusive: the last block that still fits before 19:00.
    expect(result.candidates).toHaveLength(11);
    expect(result.candidates.map((c) => c.start)).toEqual([
      at(7),
      at(8),
      at(9),
      at(10),
      at(11),
      at(12),
      at(13),
      at(14),
      at(15),
      at(16),
      at(17),
    ]);
    expect(result.candidates[0].end).toBe(at(9));
    expect(result.evaluatedHours).toBe(13);
    expect(result.skippedHours).toEqual([]);
  });

  it('honours a caller-supplied search bounds', () => {
    const result = findBestWindow(
      base({ requestedWindow: { start: '09:00', end: '13:00' } }),
    );

    expect(result.candidates.map((c) => c.start)).toEqual([at(9), at(10), at(11)]);
    expect(result.evaluatedHours).toBe(5);
  });

  it('produces no candidate when the searched window is shorter than the block', () => {
    const result = findBestWindow(base({ requestedWindow: { start: '07:00', end: '08:00' } }));

    expect(result.candidates).toEqual([]);
    expect(result.best).toBeNull();
    expect(result.reason).toMatch(/3-hour/);
    expect(result.evaluatedHours).toBe(0);
    expect(result.skippedHours.map((s) => s.time)).toEqual([at(7), at(8)]);
  });
});

describe('findBestWindow — best candidate', () => {
  /**
   * Hand-computed fixture. Required Factors only (no optional Factor has a
   * value, so the attainable range is ±(2 × 14) = ±28).
   *
   * Hours 07–09: code 0 (+2×4), 0 mm (+2×3), 10 km/h (+2×3), 27 °C (+2×4)
   *   → raw +28 → round(56/56 × 100) = 100, favorable.
   * Hours 10–23: code 3 (0), 1 mm (0), 24 km/h (0), 16 °C (−1×4)
   *   → raw −4 → round(24/56 × 100) = 43, mixed.
   *
   * The two straddling blocks fall in between, computed in the assertions.
   */
  const fixture = daySeries((hour) =>
    hour < 10
      ? { temperature_2m: 27, weather_code: 0, precipitation: 0, wind_speed_10m: 10 }
      : { temperature_2m: 16, weather_code: 3, precipitation: 1, wind_speed_10m: 24 },
  );

  it('picks the highest-scoring block, matching a hand-computed score', () => {
    const result = findBestWindow(base({ hours: fixture }));

    expect(result.best).toEqual({ start: at(7), end: at(9), score: 100, verdict: 'favorable' });
    expect(result.reason).toBeNull();

    const scores = result.candidates.map((c) => c.score);
    // 07:00=100, 08:00=82 (mean temp 23.3 → +1, mode code 0 → +2,
    // mean precip 0.33 → +1, mean wind 14.7 → +1), 09:00=55, then 43 ×8.
    expect(scores).toEqual([100, 82, 55, 43, 43, 43, 43, 43, 43, 43, 43]);
    expect(result.candidates.every((c) => c.score !== null)).toBe(true);
  });

  it('sorts candidates by score descending, ties resolved to the earliest', () => {
    const result = findBestWindow(base({ hours: fixture }));

    const scores = result.candidates.map((c) => c.score ?? -1);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    const tied = result.candidates.filter((c) => c.score === 43);
    expect(tied[0].start).toBe(at(10));
    expect(tied.map((c) => c.start)).toEqual([
      at(10),
      at(11),
      at(12),
      at(13),
      at(14),
      at(15),
      at(16),
      at(17),
    ]);
  });

  it('sets reason only when best is null, and never an empty object', () => {
    const withScore = findBestWindow(base({ hours: fixture }));
    expect(withScore.best).not.toBeNull();
    expect(withScore.reason).toBeNull();

    const withoutScore = findBestWindow(
      base({ hours: daySeries((hour) => ({ ...goodHour(hour), temperature_2m: null })) }),
    );
    expect(withoutScore.best).toBeNull();
    expect(typeof withoutScore.reason).toBe('string');
    expect(withoutScore.reason!.length).toBeGreaterThan(0);
  });
});

describe('findBestWindow — gaps disqualify rather than bridge', () => {
  it('excludes every block that contains a missing middle hour', () => {
    const hours = daySeries((hour) =>
      hour === 12
        ? { ...goodHour(hour), temperature_2m: null }
        : goodHour(hour),
    );

    const result = findBestWindow(base({ hours }));

    const starts = result.candidates.map((c) => c.start);
    // §2.4: a candidate exists only when all three hours are complete, so the
    // blocks starting 10:00, 11:00 and 12:00 (each spans 12:00) are not
    // candidates at all — and 12:00 is not bridged into either neighbour.
    expect(starts).not.toContain(at(10));
    expect(starts).not.toContain(at(11));
    expect(starts).not.toContain(at(12));
    expect(starts).toHaveLength(8);
    expect(starts).toContain(at(9));
    expect(starts).toContain(at(13));
    expect(result.candidates.every((c) => c.score !== null)).toBe(true);

    expect(result.skippedHours).toEqual([
      { time: at(12), reason: 'missing required factor(s): temperature_2m' },
    ]);
    expect(result.evaluatedHours).toBe(12);
  });

  it('splits on an hour the forecast never returned at all', () => {
    const hours = daySeries(goodHour).filter((hour) => hour.time !== at(12));

    const result = findBestWindow(base({ hours }));

    const starts = result.candidates.map((c) => c.start);
    expect(starts).toEqual(
      expect.not.arrayContaining([at(10), at(11), at(12)]),
    );
    expect(result.skippedHours).toEqual([
      { time: at(12), reason: 'the forecast returned no hour for this time' },
    ]);
    expect(result.evaluatedHours).toBe(12);
  });

  it('reports a plain reason when no block qualifies at all', () => {
    const hours = daySeries((hour) => ({ ...goodHour(hour), temperature_2m: null }));

    const result = findBestWindow(base({ hours }));

    expect(result.best).toBeNull();
    expect(result.reason).toBeTruthy();
    expect(result.reason).toMatch(/required/i);
    expect(result.candidates).toEqual([]);
    expect(result.evaluatedHours).toBe(0);
    expect(result.skippedHours).toHaveLength(13);
  });

  it('explains an empty search rather than inventing a window', () => {
    const result = findBestWindow(base({ hours: [] }));

    expect(result.best).toBeNull();
    expect(result.reason).toMatch(/no hours/i);
    expect(result.candidates).toEqual([]);
    expect(result.evaluatedHours).toBe(0);
    expect(result.skippedHours).toHaveLength(13);
  });
});

describe('findBestWindow — agreement with rate_activity_conditions', () => {
  /** Rate one block exactly the way `findBestWindow` does, then compare. */
  function rateBlock(hours: HourReading[], start: string, end: string) {
    const win = resolveWindow({ start: start.slice(11, 16), end: end.slice(11, 16) });
    return evaluateWindow({
      activity: 'beach_day',
      hours: hoursInRange(hours, win.start, win.end),
      location: LOCATION,
      requestedWindow: win,
      missing: [],
    });
  }

  it('gives every candidate the verdict rate gives that same block', () => {
    // One thunderstorm at 11:00 vetoes the three blocks that contain it.
    const hours = daySeries((hour) =>
      hour === 11 ? { ...goodHour(hour), weather_code: 95 } : goodHour(hour),
    );

    const result = findBestWindow(base({ hours }));

    expect(result.candidates).toHaveLength(11);
    for (const candidate of result.candidates) {
      const rated = rateBlock(hours, candidate.start, candidate.end);
      expect(candidate.verdict).toBe(rated.verdict);
      expect(candidate.score).toBe(rated.score?.value ?? null);
    }

    const vetoed = result.candidates.filter((c) => [at(9), at(10), at(11)].includes(c.start));
    expect(vetoed).toHaveLength(3);
    expect(vetoed.every((c) => c.verdict === 'unfavorable')).toBe(true);
    expect(result.candidates.filter((c) => c.verdict === 'favorable')).toHaveLength(8);
  });

  it('lands after the veto rules: a vetoed block keeps its score and its verdict', () => {
    // Every hour is identical apart from the storm at 07:00, so all eleven
    // blocks tie on score and §2.4 resolves the tie to the earliest — which is
    // exactly the block the Veto trips. The Veto reports the score it
    // overrode rather than hiding it, so `best` tells the truth either way.
    const hours = daySeries((hour) =>
      hour === 7 ? { ...goodHour(hour), weather_code: 99 } : goodHour(hour),
    );

    const result = findBestWindow(base({ hours }));

    const best = result.candidates[0];
    expect(result.best).toEqual(best);
    expect(best.start).toBe(at(7));
    expect(best.verdict).toBe('unfavorable');
    expect(rateBlock(hours, best.start, best.end).verdict).toBe('unfavorable');
    expect(best.score).toBe(97);
  });
});

describe('findBestWindow — ties and off-hour bounds', () => {
  it('resolves a tie at the top to the earliest candidate', () => {
    // A uniform day: every block scores identically.
    const result = findBestWindow(base());

    const scores = result.candidates.map((c) => c.score);
    expect(new Set(scores).size).toBe(1);
    expect(result.best?.start).toBe(at(7));
    expect(result.best).toEqual(result.candidates[0]);
  });

  it('snaps off-hour search bounds to the hourly grid', () => {
    // 09:30-15:30 can only ever match whole-hour readings, so the search runs
    // 10:00-15:00 and every reported hour is a real forecast hour.
    const result = findBestWindow(base({ requestedWindow: { start: '09:30', end: '15:30' } }));

    expect(result.candidates.map((c) => c.start)).toEqual([at(10), at(11), at(12), at(13)]);
    expect(result.evaluatedHours).toBe(6);
    expect(result.skippedHours).toEqual([]);
    expect(result.reason).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Through the MCP handler, with a fake fetcher — no network                   */
/* -------------------------------------------------------------------------- */

function timesFor(date: string): string[] {
  return Array.from({ length: 24 }, (_, i) => `${date}T${String(i).padStart(2, '0')}:00`);
}

/**
 * Supplies only the four required beach_day Factors, so the attainable range
 * is exactly ±28 and the fixture's scores stay hand-computable. Optional
 * Factors are left out rather than null: an absent optional Factor is skipped
 * and does not widen the range.
 */
function payloads(temperatureAt: (hour: number) => number) {
  const times = timesFor(DATE);
  const all = (fn: (hour: number) => number | null) => times.map((_, i) => fn(i));

  return {
    weather: {
      latitude: 36.53,
      longitude: -6.29,
      timezone: 'Europe/Madrid',
      utc_offset_seconds: 3600,
      hourly_units: { temperature_2m: '°C' },
      hourly: {
        time: times,
        temperature_2m: all((i) => temperatureAt(i)),
        weather_code: all(() => 0),
        precipitation: all(() => 0),
        wind_speed_10m: all(() => 10),
      },
    },
    marine: {
      latitude: 36.54,
      longitude: -6.29,
      timezone: 'Europe/Madrid',
      utc_offset_seconds: 3600,
      hourly_units: { wave_height: 'm' },
      hourly: { time: times, wave_height: all(() => null) },
    },
  };
}

function fetcherFor(weather: unknown, marine: unknown): Fetcher {
  return async (url) => ({
    status: 200,
    json: async () => (url.startsWith(MARINE_ENDPOINT) ? marine : weather),
  });
}

async function connected(fetcher: Fetcher) {
  const server = createServer({ fetcher });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const call = async (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const json = (result: { content: unknown }) =>
    JSON.parse(
      (result.content as Array<{ type: string; text?: string }>)
        .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
        .join(''),
    );

  return { call, json };
}

const BASE = { latitude: 36.53, longitude: -6.29, date: DATE, activity: 'beach_day' };

describe('find_best_activity_window — tool', () => {
  it('returns the best block for a cool morning and a cold afternoon', async () => {
    const { weather, marine } = payloads((hour) => (hour < 10 ? 27 : 16));
    const { call, json } = await connected(fetcherFor(weather, marine));

    const result = await call('find_best_activity_window', BASE);

    expect(result.isError).toBeFalsy();
    const body = json(result);
    expect(body.windowHours).toBe(3);
    expect(body.strideHours).toBe(1);
    expect(body.candidates).toHaveLength(11);
    expect(body.best).toEqual({
      start: `${DATE}T07:00`,
      end: `${DATE}T09:00`,
      score: 100,
      verdict: 'favorable',
    });
    expect(body.reason).toBeNull();
    expect(body.limitations).toBeInstanceOf(Array);
  });

  it('agrees with rate_activity_conditions on the best block', async () => {
    const { weather, marine } = payloads(() => 21);
    const { call, json } = await connected(fetcherFor(weather, marine));

    const best = json(await call('find_best_activity_window', BASE)).best;
    const rated = json(
      await call('rate_activity_conditions', {
        ...BASE,
        window: { start: best.start.slice(11, 16), end: best.end.slice(11, 16) },
      }),
    );

    expect(rated.verdict).toBe(best.verdict);
    expect(rated.score.value).toBe(best.score);
  });

  it('rejects surfing without a skill level before touching the forecast', async () => {
    const { weather, marine } = payloads(() => 21);
    const { call } = await connected(fetcherFor(weather, marine));

    const result = await call('find_best_activity_window', { ...BASE, activity: 'surfing' });

    expect(result.isError).toBe(true);
    const message = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(message).toMatch(/Invalid input/);
    expect(message).toMatch(/skillLevel/);
  });
});
