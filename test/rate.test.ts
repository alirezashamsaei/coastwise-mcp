import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import type { Fetcher } from '../src/forecast.js';
import { MARINE_ENDPOINT } from '../src/constants.js';
import { aggregateHours, mergeHours, resolveWindow } from '../src/evaluate.js';

const DATE = '2026-10-27';

function timesFor(date: string): string[] {
  return Array.from({ length: 24 }, (_, i) => `${date}T${String(i).padStart(2, '0')}:00`);
}

interface Options {
  weather?: Record<string, number | null>;
  marine?: Record<string, number | null>;
}

/** Builds a payload whose every hour carries the same values. */
function block(date: string, values: Record<string, number | null>) {
  const times = timesFor(date);
  const hourly: Record<string, Array<number | null>> = { time: times };
  for (const [factor, value] of Object.entries(values)) {
    hourly[factor] = times.map(() => value);
  }
  return hourly;
}

function payloads(date: string, options: Options = {}) {
  const weatherValues = {
    temperature_2m: 24,
    weather_code: 0,
    precipitation: 0,
    wind_speed_10m: 12,
    wind_gusts_10m: 20,
    uv_index: 5,
    cloud_cover: 20,
    visibility: 20000,
    ...options.weather,
  };
  const marineValues = {
    wave_height: 0.8,
    wave_period: 10,
    wind_wave_height: 0.4,
    swell_wave_height: 0.7,
    swell_wave_period: 10,
    sea_surface_temperature: 20,
    ...options.marine,
  };

  return {
    weather: {
      latitude: 36.53,
      longitude: -6.29,
      timezone: 'Europe/Madrid',
      utc_offset_seconds: 3600,
      hourly: block(date, weatherValues),
      hourly_units: { temperature_2m: '°C' },
    },
    marine: {
      latitude: 36.54,
      longitude: -6.29,
      timezone: 'Europe/Madrid',
      utc_offset_seconds: 3600,
      hourly: block(date, marineValues),
      hourly_units: { wave_height: 'm' },
    },
  };
}

function fetcherFor(weather: unknown, marine: unknown) {
  const fetcher: Fetcher = async (url) => ({
    status: 200,
    json: async () => (url.startsWith(MARINE_ENDPOINT) ? marine : weather),
  });
  return fetcher;
}

async function connected(fetcher?: Fetcher) {
  const server = createServer(fetcher ? { fetcher } : {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const call = async (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const text = (result: { content: unknown }) =>
    (result.content as Array<{ type: string; text?: string }>)
      .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
      .join('');
  const json = (result: { content: unknown }) => JSON.parse(text(result));

  return { call, text, json };
}

const BASE = { latitude: 36.53, longitude: -6.29, date: DATE };

describe('rate_activity_conditions — happy path', () => {
  it('returns a favorable verdict with a normalized score', async () => {
    const { call, json } = await connected(fetcherFor(...Object.values(payloads(DATE))));
    const result = await call('rate_activity_conditions', {
      ...BASE,
      activity: 'beach_day',
    });

    expect(result.isError).toBeFalsy();
    const body = json(result);
    expect(body.verdict).toBe('favorable');
    expect(body.score.value).toBeGreaterThan(0);
    expect(body.score.value).toBeLessThanOrEqual(100);
    expect(body.score.raw).toBeGreaterThan(0);
    expect(body.score.thresholds).toEqual({ favorable: 70, mixed: 40 });
    expect(body.veto).toBeNull();
  });

  it('explains itself: every Factor carries a unit, band, and contribution', async () => {
    const { call, json } = await connected(fetcherFor(...Object.values(payloads(DATE))));
    const body = json(await call('rate_activity_conditions', { ...BASE, activity: 'beach_day' }));

    expect(body.factors.length).toBeGreaterThan(0);
    for (const row of body.factors) {
      expect(typeof row.unit, row.factor).toBe('string');
      expect(typeof row.label, row.factor).toBe('string');
      expect(typeof row.required, row.factor).toBe('boolean');
      expect(['scored', 'optional_missing', 'context_only']).toContain(row.status);
    }
    const scored = body.factors.filter((f: { status: string }) => f.status === 'scored');
    expect(scored.length).toBeGreaterThan(0);
    for (const row of scored) {
      expect(row.band, row.factor).not.toBeNull();
      expect(row.score, row.factor).toBeGreaterThanOrEqual(-2);
      expect(row.score, row.factor).toBeLessThanOrEqual(2);
      expect(row.contribution, row.factor).toBe(row.score * row.weight);
    }
  });

  it('separates improving from reducing factors', async () => {
    const { call, json } = await connected(
      fetcherFor(...Object.values(payloads(DATE, { weather: { precipitation: 25 } }))),
    );
    const body = json(await call('rate_activity_conditions', { ...BASE, activity: 'beach_day' }));

    expect(body.improving.length).toBeGreaterThan(0);
    expect(body.reducing).toContain('precipitation');
    expect(body.improving).not.toContain('precipitation');
    // Every reducing entry has a negative contribution, and vice versa.
    for (const factor of body.reducing) {
      const row = body.factors.find((f: { factor: string }) => f.factor === factor);
      expect(row.contribution, factor).toBeLessThan(0);
    }
  });

  it('applies the default window and says it did', async () => {
    const { call, json } = await connected(fetcherFor(...Object.values(payloads(DATE))));
    const body = json(await call('rate_activity_conditions', { ...BASE, activity: 'beach_day' }));

    expect(body.window).toMatchObject({ start: '07:00', end: '19:00', defaulted: true });
    expect(body.window.timezone).toBe('Europe/Madrid');
  });

  it('honours an explicit window', async () => {
    const { call, json } = await connected(fetcherFor(...Object.values(payloads(DATE))));
    const body = json(
      await call('rate_activity_conditions', {
        ...BASE,
        activity: 'beach_day',
        window: { start: '09:00', end: '13:00' },
      }),
    );

    expect(body.window).toMatchObject({ start: '09:00', end: '13:00', defaulted: false });
  });

  it('carries all seven limitations with every response', async () => {
    const { call, json } = await connected(fetcherFor(...Object.values(payloads(DATE))));
    const body = json(await call('rate_activity_conditions', { ...BASE, activity: 'beach_day' }));

    expect(body.limitations).toHaveLength(7);
    expect(body.location.timezone).toBe('Europe/Madrid');
  });
});

describe('rate_activity_conditions — input validation', () => {
  it('refuses surfing without a skill level', async () => {
    const { call, text } = await connected(fetcherFor(...Object.values(payloads(DATE))));
    const result = await call('rate_activity_conditions', { ...BASE, activity: 'surfing' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/skillLevel/);
  });

  it('reports a skill level supplied for beach_day instead of dropping it', async () => {
    const { call, json } = await connected(fetcherFor(...Object.values(payloads(DATE))));
    const body = json(
      await call('rate_activity_conditions', {
        ...BASE,
        activity: 'beach_day',
        skillLevel: 'advanced',
      }),
    );

    expect(body.unusedSkillLevel).toBe('advanced');
    expect(body.verdict).not.toBe('insufficient_data');
  });

  it('rejects a window whose start is after its end', async () => {
    const { call, text } = await connected(fetcherFor(...Object.values(payloads(DATE))));
    const result = await call('rate_activity_conditions', {
      ...BASE,
      activity: 'beach_day',
      window: { start: '16:00', end: '10:00' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Invalid input/);
  });

  it('rejects out-of-range coordinates before calling the API', async () => {
    const { call, text } = await connected(fetcherFor(...Object.values(payloads(DATE))));
    const result = await call('rate_activity_conditions', {
      ...BASE,
      latitude: 1000,
      activity: 'beach_day',
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/latitude/i);
  });
});

describe('rate_activity_conditions — Vetoes', () => {
  it('forces unfavorable and reports the score it overrode', async () => {
    const { call, json } = await connected(
      fetcherFor(...Object.values(payloads(DATE, { weather: { weather_code: 99 } }))),
    );
    const body = json(
      await call('rate_activity_conditions', {
        ...BASE,
        activity: 'surfing',
        skillLevel: 'beginner',
      }),
    );

    expect(body.verdict).toBe('unfavorable');
    expect(body.veto.id).toBe('thunderstorm');
    expect(body.veto.factor).toBe('weather_code');
    expect(body.veto.value).toBe(99);
    expect(body.veto.reason).toMatch(/thunderstorm/i);
    expect(body.veto.overriddenScore).toBe(body.score.value);
    expect(body.score.value).toBeGreaterThan(0);
  });

  it('fires the wave ceiling for a beginner but not for an advanced surfer', async () => {
    const marine = { wave_height: 3.0 };

    const { call, json } = await connected(
      fetcherFor(...Object.values(payloads(DATE, { marine }))),
    );
    const beginner = json(
      await call('rate_activity_conditions', { ...BASE, activity: 'surfing', skillLevel: 'beginner' }),
    );
    const advanced = json(
      await call('rate_activity_conditions', { ...BASE, activity: 'surfing', skillLevel: 'advanced' }),
    );

    expect(beginner.veto?.id).toBe('wave_above_skill_ceiling');
    expect(beginner.verdict).toBe('unfavorable');
    expect(advanced.veto).toBeNull();
    expect(advanced.verdict).not.toBe('unfavorable');
  });

  it('never vetoes when the evidence is missing', async () => {
    const nullMarine = { wave_height: null };
    const { call, json } = await connected(
      fetcherFor(...Object.values(payloads(DATE, { marine: nullMarine }))),
    );
    const body = json(
      await call('rate_activity_conditions', { ...BASE, activity: 'surfing', skillLevel: 'beginner' }),
    );

    expect(body.veto).toBeNull();
    expect(body.missing.map((m: { factor: string }) => m.factor)).toContain('wave_height');
    expect(body.verdict).toBe('insufficient_data');
    expect(body.score).toBeNull();
  });
});

describe('rate_activity_conditions — missing data', () => {
  it('returns insufficient_data rather than a score built from what is left', async () => {
    const weather = { temperature_2m: null };
    const { call, json } = await connected(fetcherFor(...Object.values(payloads(DATE, { weather }))));
    const body = json(await call('rate_activity_conditions', { ...BASE, activity: 'beach_day' }));

    expect(body.verdict).toBe('insufficient_data');
    expect(body.score).toBeNull();
    expect(body.veto).toBeNull();
    const row = body.factors.find((f: { factor: string }) => f.factor === 'temperature_2m');
    expect(row.value).toBeNull();
    expect(row.contribution).toBeNull();
    expect(body.missing.map((m: { factor: string }) => m.factor)).toContain('temperature_2m');
  });

  it('keeps scoring when only an optional Factor is missing', async () => {
    const weather = { uv_index: null };
    const { call, json } = await connected(fetcherFor(...Object.values(payloads(DATE, { weather }))));
    const body = json(await call('rate_activity_conditions', { ...BASE, activity: 'beach_day' }));

    expect(body.verdict).not.toBe('insufficient_data');
    expect(body.score).not.toBeNull();
    expect(body.missing.map((m: { factor: string }) => m.factor)).toContain('uv_index');
    const row = body.factors.find((f: { factor: string }) => f.factor === 'uv_index');
    expect(row.status).toBe('optional_missing');
    expect(row.contribution).toBeNull();
  });
});

describe('window aggregation', () => {
  it('keeps every hour of the requested date', () => {
    const merged = mergeHours(
      [{ time: `${DATE}T09:00`, values: { temperature_2m: 20 } }],
      [{ time: `${DATE}T09:00`, values: { wave_height: 1 } }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.values).toEqual({ temperature_2m: 20, wave_height: 1 });
  });

  it('averages continuous factors and takes the mode for weather codes', () => {
    const hours = [
      { time: `${DATE}T09:00`, values: { temperature_2m: 20, weather_code: 0 } },
      { time: `${DATE}T10:00`, values: { temperature_2m: 30, weather_code: 3 } },
      { time: `${DATE}T11:00`, values: { temperature_2m: 40, weather_code: 3 } },
    ];
    const { values } = aggregateHours('beach_day', hours);

    expect(values['temperature_2m']).toBe(30);
    // Averaging WMO codes would invent one nobody reported.
    expect(values['weather_code']).toBe(3);
  });

  it('treats a factor missing from any hour as incomplete', () => {
    const hours = [
      { time: `${DATE}T09:00`, values: { temperature_2m: 20, precipitation: 0 } },
      { time: `${DATE}T10:00`, values: { temperature_2m: 20, precipitation: null } },
    ];
    const { values, incomplete } = aggregateHours('beach_day', hours);

    expect(values['precipitation']).toBeUndefined();
    expect(incomplete).toContain('precipitation');
    expect(values['temperature_2m']).toBe(20);
  });

  it('defaults the window and rejects an inverted one', () => {
    expect(resolveWindow()).toEqual({ start: '07:00', end: '19:00', defaulted: true });
    expect(resolveWindow({ start: '09:00', end: '13:00' })).toEqual({
      start: '09:00',
      end: '13:00',
      defaulted: false,
    });
    expect(() => resolveWindow({ start: '13:00', end: '09:00' })).toThrow(/earlier/);
    expect(() => resolveWindow({ start: '09:00', end: '09:00' })).toThrow(/same time/);
  });
});
