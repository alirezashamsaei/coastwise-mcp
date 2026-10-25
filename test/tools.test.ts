import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import type { Fetcher } from '../src/forecast.js';
import { LIMITATIONS, MARINE_ENDPOINT } from '../src/constants.js';

const DATE = '2026-10-27';

function timesFor(date: string): string[] {
  return Array.from({ length: 24 }, (_, i) => `${date}T${String(i).padStart(2, '0')}:00`);
}

function baseBlock(date: string) {
  const n = 24;
  return {
    time: timesFor(date),
    temperature_2m: Array.from({ length: n }, () => 21),
    weather_code: Array.from({ length: n }, () => 1),
    precipitation: Array.from({ length: n }, () => 0),
    wind_speed_10m: Array.from({ length: n }, () => 14),
    wind_gusts_10m: Array.from({ length: n }, () => 22),
    uv_index: Array.from({ length: n }, () => 5),
    cloud_cover: Array.from({ length: n }, () => 30),
    visibility: Array.from({ length: n }, () => 20000),
    wave_height: Array.from({ length: n }, () => 0.8),
    wave_period: Array.from({ length: n }, () => 9),
    wind_wave_height: Array.from({ length: n }, () => 0.5),
    swell_wave_height: Array.from({ length: n }, () => 0.7),
    swell_wave_period: Array.from({ length: n }, () => 9),
    sea_surface_temperature: Array.from({ length: n }, () => 19),
  };
}

const WEATHER_UNITS = { temperature_2m: '°C', wind_speed_10m: 'km/h', uv_index: '' };
const MARINE_UNITS = { wave_height: 'm', wave_period: 's', sea_surface_temperature: '°C' };

function weatherPayload(date: string, overrides: Record<string, unknown> = {}) {
  return {
    latitude: 36.53,
    longitude: -6.29,
    timezone: 'Europe/Madrid',
    utc_offset_seconds: 3600,
    hourly_units: WEATHER_UNITS,
    hourly: { ...baseBlock(date), ...overrides },
  };
}

function marinePayload(date: string, overrides: Record<string, unknown> = {}) {
  return {
    latitude: 36.5417,
    longitude: -6.2917,
    timezone: 'Europe/Madrid',
    utc_offset_seconds: 3600,
    hourly_units: MARINE_UNITS,
    hourly: { ...baseBlock(date), ...overrides },
  };
}

/** Routes by host and serves canned bodies; records every URL it saw. */
function fetcherFor(weather: unknown, marine: unknown) {
  const urls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    urls.push(url);
    const body = url.startsWith(MARINE_ENDPOINT) ? marine : weather;
    return { status: 200, json: async () => body };
  };
  return { fetcher, urls };
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

  return { client, call, text };
}

describe('get_beach_forecast', () => {
  it('returns hourly weather and marine data with units and attribution', async () => {
    const { fetcher } = fetcherFor(weatherPayload(DATE), marinePayload(DATE));
    const { call, text } = await connected(fetcher);

    const result = await call('get_beach_forecast', {
      latitude: 36.53,
      longitude: -6.29,
      date: DATE,
    });

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(text(result));
    expect(body.date).toBe(DATE);
    expect(body.location.timezone).toBe('Europe/Madrid');
    expect(body.weather.hours).toHaveLength(24);
    expect(body.marine.hours).toHaveLength(24);
    expect(body.weather.units['temperature_2m']).toBe('°C');
    expect(body.weather.hours[0].values.temperature_2m).toBe(21);
    expect(body.sources).toHaveLength(2);
    expect(body.sources[0].attribution).toBe('Weather data by Open-Meteo.com');
    expect(body.limitations).toHaveLength(LIMITATIONS.length);
  });

  it('lists factors that are entirely null without inventing values', async () => {
    const nullColumn = Array.from({ length: 24 }, () => null);
    const { fetcher } = fetcherFor(
      weatherPayload(DATE, { uv_index: nullColumn }),
      marinePayload(DATE),
    );
    const { call, text } = await connected(fetcher);

    const result = await call('get_beach_forecast', {
      latitude: 36.53,
      longitude: -6.29,
      date: DATE,
    });
    const body = JSON.parse(text(result));

    expect(body.weather.hours[3].values.uv_index).toBeNull();
    expect(body.missing.map((m: { factor: string }) => m.factor)).toContain('uv_index');
    expect(body.missing.find((m: { factor: string }) => m.factor === 'uv_index').scope).toBe(
      'weather',
    );
  });

  it('reports an all-null marine block as unavailable rather than erroring', async () => {
    const nullMarine = {
      latitude: 36.5,
      longitude: -6.3,
      timezone: 'Europe/Madrid',
      utc_offset_seconds: 3600,
      hourly: { time: timesFor(DATE), wave_height: Array(24).fill(null) },
    };
    const { fetcher } = fetcherFor(weatherPayload(DATE), nullMarine);
    const { call, text } = await connected(fetcher);

    const result = await call('get_beach_forecast', {
      latitude: 36.53,
      longitude: -6.29,
      date: DATE,
    });
    const body = JSON.parse(text(result));

    expect(result.isError).toBeFalsy();
    expect(body.marine.available).toBe(false);
    expect(body.weather.available).toBe(true);
  });

  it('rejects a date beyond the forecast horizon with a clear error, not a verdict', async () => {
    const { fetcher } = fetcherFor(weatherPayload(DATE), marinePayload(DATE));
    const { call, text } = await connected(fetcher);

    const result = await call('get_beach_forecast', {
      latitude: 36.53,
      longitude: -6.29,
      date: '2027-01-01',
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Invalid input/);
    expect(text(result)).toMatch(/past|days out/);
  });

  it('rejects out-of-range coordinates without calling the API', async () => {
    const { fetcher, urls } = fetcherFor(weatherPayload(DATE), marinePayload(DATE));
    const { call, text } = await connected(fetcher);

    const result = await call('get_beach_forecast', {
      latitude: 999,
      longitude: 0,
      date: DATE,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/latitude/i);
    expect(urls).toHaveLength(0);
  });

  it('reports an upstream failure as an error, distinct from missing data', async () => {
    const failing: Fetcher = async () => ({ status: 503, json: async () => ({}) });
    const { call, text } = await connected(failing);

    const result = await call('get_beach_forecast', {
      latitude: 36.53,
      longitude: -6.29,
      date: DATE,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Forecast unavailable/);
  });

  it('never sends cell_selection and always resolves timezone', async () => {
    const { fetcher, urls } = fetcherFor(weatherPayload(DATE), marinePayload(DATE));
    const { call } = await connected(fetcher);

    await call('get_beach_forecast', { latitude: 36.53, longitude: -6.29, date: DATE });

    expect(urls).toHaveLength(2);
    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.searchParams.has('cell_selection')).toBe(false);
      expect(parsed.searchParams.get('timezone')).toBe('auto');
    }
  });
});
