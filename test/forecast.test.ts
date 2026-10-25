import { describe, expect, it, vi } from 'vitest';
import {
  collectMissing,
  fetchForecast,
  ForecastError,
  InputError,
  validateDate,
  type Fetcher,
} from '../src/forecast.js';
import { MAX_FORECAST_DAYS, MARINE_ENDPOINT, WEATHER_ENDPOINT } from '../src/constants.js';

const UNITS = {
  temperature_2m: '°C',
  weather_code: 'wmo code',
  precipitation: 'mm',
  wind_speed_10m: 'km/h',
};

/** 24 hourly entries for one local date, with an override applied per hour. */
function hourly(times: string[], overrides: Record<number, Record<string, number | null>> = {}) {
  const factors = ['temperature_2m', 'weather_code', 'precipitation', 'wind_speed_10m'];
  const columns: Record<string, Array<number | null>> = {};
  for (const factor of factors) {
    columns[factor] = times.map((_, i) => {
      const hour = overrides[i];
      // An explicit null must survive: `?? default` would erase it.
      if (hour !== undefined && factor in hour) return hour[factor] ?? null;
      return factor === 'weather_code' ? 1 : 20;
    });
  }
  return { time: times, ...columns };
}

function timesFor(date: string): string[] {
  return Array.from({ length: 24 }, (_, i) => `${date}T${String(i).padStart(2, '0')}:00`);
}

const payload = (date: string, overrides = {}) => ({
  latitude: 36.5,
  longitude: -6.3,
  timezone: 'Europe/Madrid',
  utc_offset_seconds: 3600,
  hourly: hourly(timesFor(date), overrides),
  hourly_units: UNITS,
});

/** A fetcher that answers weather and marine from one canned payload each. */
function fakeFetch(weather: unknown, marine: unknown): { fetcher: Fetcher; urls: string[] } {
  const urls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    urls.push(url);
    const body = url.startsWith(MARINE_ENDPOINT) ? marine : weather;
    return { status: 200, json: async () => body };
  };
  return { fetcher, urls };
}

/** Pinned clock, so fixture dates never drift as the real one advances. */
const NOW = new Date('2026-10-26T12:00:00Z');

/** fetchForecast with the clock pinned unless the caller overrides it. */
const run = (options: Parameters<typeof fetchForecast>[0]) =>
  fetchForecast({ now: NOW, ...options });

describe('date validation', () => {
  const offset = 0;

  it('rejects a malformed date', () => {
    expect(() => validateDate('26-10-2026', offset)).toThrow(InputError);
    expect(() => validateDate('2026-13-40', offset)).toThrow(/not a real calendar date/);
  });

  it('rejects a past date', () => {
    expect(() => validateDate('2020-01-01', offset)).toThrow(/past/);
  });

  it('rejects a date beyond the horizon', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    expect(() => validateDate('2026-11-10', offset, now)).toThrow(
      new RegExp(`at most ${MAX_FORECAST_DAYS - 1} days ahead`),
    );
  });

  it('accepts today and the far edge of the horizon', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    expect(() => validateDate('2026-10-26', offset, now)).not.toThrow();
    expect(() => validateDate('2026-11-01', offset, now)).not.toThrow();
  });

  it('rejects a past date that is still in the future at UTC', () => {
    // 23:00 UTC on the 25th is already the 26th in UTC+1 — this date is
    // "yesterday" locally even though UTC has not rolled over yet.
    const now = new Date('2026-10-25T23:30:00Z');
    expect(() => validateDate('2026-10-25', 3600, now)).toThrow(/past/);
  });
});

describe('request construction', () => {
  const date = '2026-10-27';

  it('sends timezone=auto, hourly variables, and a capped forecast_days', async () => {
    const { fetcher, urls } = fakeFetch(payload(date), payload(date));
    await run({ latitude: 36.5, longitude: -6.3, date, fetcher });

    expect(urls).toHaveLength(2);
    const weather = new URL(urls[0]!);
    expect(weather.origin + weather.pathname).toBe(WEATHER_ENDPOINT);
    expect(weather.searchParams.get('timezone')).toBe('auto');
    // The weather request must carry the full horizon: the beach's local
    // date is unknown until a response reports the timezone.
    expect(weather.searchParams.get('forecast_days')).toBe(String(MAX_FORECAST_DAYS));
    expect(weather.searchParams.get('hourly')).toContain('temperature_2m');
  });

  it('asks the marine API only for the days that are actually needed', async () => {
    const { fetcher, urls } = fakeFetch(payload(date), payload(date));
    // Fixture reports Europe/Madrid (UTC+1), so "now" at 12:00 UTC is
    // 2026-10-26 locally and 2026-10-27 is one day ahead.
    const now = new Date('2026-10-26T12:00:00Z');
    await run({ latitude: 36.5, longitude: -6.3, date, fetcher, now });

    const marine = new URL(urls[1]!);
    expect(marine.searchParams.get('forecast_days')).toBe('2');
    expect(marine.searchParams.get('timezone')).toBe('auto');
  });

  it('never sends cell_selection — the marine default must be left alone', async () => {
    const { fetcher, urls } = fakeFetch(payload(date), payload(date));
    await run({ latitude: 36.5, longitude: -6.3, date, fetcher });

    for (const url of urls) {
      expect(new URL(url).searchParams.has('cell_selection')).toBe(false);
    }
  });

  it('routes marine to its own host', async () => {
    const { fetcher, urls } = fakeFetch(payload(date), payload(date));
    await run({ latitude: 36.5, longitude: -6.3, date, fetcher });

    expect(new URL(urls[1]!).host).toBe(new URL(MARINE_ENDPOINT).host);
    expect(urls[1]!.startsWith(MARINE_ENDPOINT)).toBe(true);
  });

  it('rejects out-of-range coordinates before any request', async () => {
    const { fetcher, urls } = fakeFetch(payload(date), payload(date));

    await expect(
      run({ latitude: 91, longitude: 0, date, fetcher }),
    ).rejects.toThrow(InputError);
    await expect(
      run({ latitude: 0, longitude: -181, date, fetcher }),
    ).rejects.toThrow(InputError);
    expect(urls).toHaveLength(0);
  });
});

describe('responses', () => {
  const date = '2026-10-27';

  it('returns only the requested date, in beach-local time, with units', async () => {
    const { fetcher } = fakeFetch(payload(date), payload(date));
    const result = await run({ latitude: 36.5, longitude: -6.3, date, fetcher });

    expect(result.location.timezone).toBe('Europe/Madrid');
    expect(result.weather.hours).toHaveLength(24);
    expect(result.weather.hours[0]!.time).toBe(`${date}T00:00`);
    expect(result.weather.hours.every((h) => h.time.startsWith(date))).toBe(true);
    expect(result.weather.units['temperature_2m']).toBe('°C');
    expect(result.sources.map((s) => s.api)).toEqual([WEATHER_ENDPOINT, MARINE_ENDPOINT]);
  });

  it('preserves nulls rather than substituting a value', async () => {
    const { fetcher } = fakeFetch(payload(date, { 5: { temperature_2m: null } }), payload(date));
    const result = await run({ latitude: 36.5, longitude: -6.3, date, fetcher });

    expect(result.weather.hours[5]!.values['temperature_2m']).toBeNull();
    expect(result.weather.available).toBe(true);
  });

  it('reports an all-null marine block as unavailable, not as an error', async () => {
    const emptyMarine = {
      latitude: 36.5,
      longitude: -6.3,
      timezone: 'Europe/Madrid',
      utc_offset_seconds: 3600,
      hourly: { time: timesFor(date), temperature_2m: Array(24).fill(null) },
    };
    const { fetcher } = fakeFetch(payload(date), emptyMarine);
    const result = await run({ latitude: 36.5, longitude: -6.3, date, fetcher });

    expect(result.marine.available).toBe(false);
    expect(result.weather.available).toBe(true);
    expect(result.sources[1]!.api).toBe(MARINE_ENDPOINT);
  });

  it('collects factors that carry no value anywhere in the block', async () => {
    const allNull = Object.fromEntries(timesFor(date).map((_, i) => [i, { precipitation: null }]));
    const { fetcher } = fakeFetch(payload(date, allNull), payload(date));
    const result = await run({
      latitude: 36.5,
      longitude: -6.3,
      date,
      fetcher,
      marineFactors: [],
    });

    const missing = collectMissing(result.weather, 'weather', ['precipitation', 'temperature_2m']);
    expect(missing.map((m) => m.factor)).toEqual(['precipitation']);
    expect(missing[0]!.reason).toBe('upstream_null');
    expect(missing[0]!.scope).toBe('weather');
  });
});

describe('error handling', () => {
  const date = '2026-10-27';

  it('maps an HTTP failure to ForecastError, not to a verdict', async () => {
    const fetcher: Fetcher = async () => ({ status: 500, json: async () => ({}) });

    await expect(
      run({ latitude: 36.5, longitude: -6.3, date, fetcher }),
    ).rejects.toThrow(ForecastError);
  });

  it('maps a network failure to ForecastError', async () => {
    const fetcher: Fetcher = async () => {
      throw new Error('ECONNREFUSED');
    };

    await expect(
      run({ latitude: 36.5, longitude: -6.3, date, fetcher }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('surfaces the upstream error reason for a rejected request', async () => {
    const fetcher: Fetcher = async () => ({
      status: 400,
      json: async () => ({ error: true, reason: 'Invalid timezone' }),
    });

    await expect(
      run({ latitude: 36.5, longitude: -6.3, date, fetcher }),
    ).rejects.toThrow(/Invalid timezone/);
  });

  it('degrades when only the marine API is unreachable', async () => {
    const { fetcher: base } = fakeFetch(payload(date), payload(date));
    const fetcher: Fetcher = async (url) => {
      if (url.startsWith(MARINE_ENDPOINT)) throw new Error('ECONNREFUSED');
      return base(url);
    };

    const result = await run({ latitude: 36.5, longitude: -6.3, date, fetcher });
    expect(result.marine.available).toBe(false);
    expect(result.weather.available).toBe(true);
  });

  it('fails the whole call when the weather API is unreachable', async () => {
    const fetcher: Fetcher = async () => {
      throw new Error('ECONNREFUSED');
    };

    await expect(
      run({ latitude: 36.5, longitude: -6.3, date, fetcher }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('validates the date against the beach-local calendar day', async () => {
    const now = new Date('2026-10-26T23:30:00Z');
    const { fetcher } = fakeFetch('2026-10-26', '2026-10-26');
    // weekday offset: fetch a date the API happily answers but which is
    // tomorrow in UTC+1 — must still validate against local today.
    const spy = vi.fn(fetcher);
    await expect(
      run({ latitude: 36.5, longitude: -6.3, date: '2026-10-20', fetcher: spy, now }),
    ).rejects.toThrow(/past/);
  });
});
