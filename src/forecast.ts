/**
 * The only module in CoastWise that performs HTTP.
 *
 * Every other module is pure, which is what lets the tests stay offline:
 * callers inject a fetcher, so nothing in the suite ever reaches the network.
 *
 * Two upstream facts shape everything here (see docs/adr/0005):
 *  - the marine API lives on its own host;
 *  - `cell_selection` must never be sent, because the default `sea` snaps a
 *    coastal on-land point to the nearest sea cell while an explicit value
 *    resolves the same point to a land cell and returns all-null data.
 */

import {
  ATTRIBUTION,
  ATTRIBUTION_URL,
  MARINE_ENDPOINT,
  MAX_FORECAST_DAYS,
  WEATHER_ENDPOINT,
} from './constants.js';
import type { Attribution, HourlyBlock, HourReading, LocationInfo, MissingFactor } from './types.js';

/** Minimal slice of fetch we depend on, so tests can substitute a fake. */
export type Fetcher = (url: string) => Promise<FetchResponse>;

export interface FetchResponse {
  status: number;
  json(): Promise<unknown>;
}

/** Weather variables, verbatim Open-Meteo names. */
export const WEATHER_FACTORS = [
  'temperature_2m',
  'weather_code',
  'precipitation',
  'wind_speed_10m',
  'wind_gusts_10m',
  'uv_index',
  'cloud_cover',
  'visibility',
] as const;

/** Marine variables, verbatim Open-Meteo names. */
export const MARINE_FACTORS = [
  'wave_height',
  'wave_period',
  'wind_wave_height',
  'swell_wave_height',
  'swell_wave_period',
  'sea_surface_temperature',
] as const;

/**
 * An upstream failure that must surface as an MCP error — distinct from a
 * request that succeeded with null values, which is `insufficient_data`.
 */
export class ForecastError extends Error {
  constructor(
    message: string,
    readonly scope: 'weather' | 'marine',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ForecastError';
  }
}

/** Input rejected before any request is made. Never a verdict. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

export interface FetchForecastOptions {
  latitude: number;
  longitude: number;
  date: string;
  weatherFactors?: readonly string[];
  marineFactors?: readonly string[];
  fetcher?: Fetcher;
  /** Injection point for tests; production callers omit it. */
  now?: Date;
}

export interface ForecastPair {
  weather: HourlyBlock;
  marine: HourlyBlock;
  location: LocationInfo;
  sources: Attribution[];
}

const defaultFetcher: Fetcher = async (url) => {
  const response = await fetch(url);
  return { status: response.status, json: () => response.json() };
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse `YYYY-MM-DD` as a UTC date to avoid local-timezone drift. */
function parseDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate the requested date against the beach's own calendar day and return
 * how many days ahead it is. The horizon is 7 days; anything outside that is a
 * caller error, not a data gap.
 */
export function validateDate(
  date: string,
  timezoneOffsetSeconds: number,
  now = new Date(),
): number {
  if (!DATE_RE.test(date)) {
    throw new InputError(`date must be YYYY-MM-DD, received "${date}"`);
  }

  const requested = parseDate(date);
  if (Number.isNaN(requested.getTime())) {
    throw new InputError(`date "${date}" is not a real calendar date`);
  }

  const localNow = new Date(now.getTime() + timezoneOffsetSeconds * 1000);
  const localToday = Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate(),
  );
  const requestedMs = Date.UTC(
    requested.getUTCFullYear(),
    requested.getUTCMonth(),
    requested.getUTCDate(),
  );

  const dayOffset = Math.round((requestedMs - localToday) / 86_400_000);
  if (dayOffset < 0) {
    throw new InputError(`date ${date} is in the past; CoastWise only forecasts forward`);
  }
  if (dayOffset > MAX_FORECAST_DAYS - 1) {
    throw new InputError(
      `date ${date} is ${dayOffset} days out; forecasts reach at most ${MAX_FORECAST_DAYS - 1} days ahead`,
    );
  }
  return dayOffset;
}

function buildUrl(
  endpoint: string,
  params: Record<string, string | number | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    // `cell_selection` is deliberately never sent — see the module docblock.
    if (value !== undefined) query.set(key, String(value));
  }
  return `${endpoint}?${query.toString()}`;
}

async function requestPayload(
  scope: 'weather' | 'marine',
  url: string,
  fetcher: Fetcher,
): Promise<unknown> {
  let response: FetchResponse;
  try {
    response = await fetcher(url);
  } catch (error) {
    throw new ForecastError(
      `Could not reach the ${scope} forecast API: ${(error as Error).message}`,
      scope,
    );
  }

  // Read the body before judging the status: Open-Meteo answers errors with
  // {"error":true,"reason":"..."} and the reason is the only useful message.
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ForecastError(
      `${scope} forecast API returned an unreadable body: ${(error as Error).message}`,
      scope,
      response.status,
    );
  }

  const body = payload as { error?: boolean; reason?: string };
  if (body.error === true || response.status < 200 || response.status >= 300) {
    const reason = body.reason ?? `HTTP ${response.status}`;
    throw new ForecastError(`${scope} forecast API: ${reason}`, scope, response.status);
  }

  return payload;
}

/**
 * Turn an Open-Meteo payload into the 24 hours of the requested date.
 * Values stay `null` when upstream says `null` — they are never filled in.
 */
function parseBlock(
  payload: unknown,
  factors: readonly string[],
  date: string,
  scope: 'weather' | 'marine',
): { block: HourlyBlock; attribution: Attribution } {
  const root = payload as {
    hourly?: { time?: unknown; [k: string]: unknown };
    hourly_units?: Record<string, string>;
  };
  const hourly = root.hourly;
  if (!hourly || !Array.isArray(hourly.time)) {
    throw new ForecastError('Forecast API returned no hourly data', 'weather');
  }

  const times = hourly.time as string[];
  // Keep only the units for factors we actually requested — upstream also
  // reports a `time` unit, which would be meaningless next to real values.
  const rawUnits = root.hourly_units ?? {};
  const units: Record<string, string> = {};
  for (const factor of factors) {
    const unit = rawUnits[factor];
    if (typeof unit === 'string') units[factor] = unit;
  }

  const columns = new Map<string, Array<number | null>>();
  for (const factor of factors) {
    const raw = hourly[factor];
    columns.set(factor, Array.isArray(raw) ? (raw as Array<number | null>) : []);
  }

  const hours: HourReading[] = [];
  for (let index = 0; index < times.length; index += 1) {
    const time = times[index] ?? '';
    if (!time.startsWith(date)) continue;

    const values: Record<string, number | null> = {};
    for (const factor of factors) {
      const cell = columns.get(factor)?.[index];
      values[factor] = isFiniteNumber(cell) ? cell : null;
    }
    hours.push({ time, values });
  }

  const block: HourlyBlock = {
    // A block counts as available if any value in it is real. Open-Meteo
    // answers HTTP 200 with all-null arrays for out-of-coverage points, so
    // status codes alone would be badly misleading here.
    available: hours.some((hour) => Object.values(hour.values).some((v) => v !== null)),
    units,
    hours,
  };

  return { block, attribution: attributionFor(scope === 'marine' ? MARINE_ENDPOINT : WEATHER_ENDPOINT) };
}

function readLocation(payload: unknown, scope: 'weather' | 'marine'): LocationInfo {
  const root = payload as Record<string, unknown>;
  return {
    latitude: isFiniteNumber(root['latitude']) ? root['latitude'] : 0,
    longitude: isFiniteNumber(root['longitude']) ? root['longitude'] : 0,
    timezone: typeof root['timezone'] === 'string' ? root['timezone'] : 'GMT',
    utcOffsetSeconds: isFiniteNumber(root['utc_offset_seconds'])
      ? root['utc_offset_seconds']
      : 0,
  };
}

function attributionFor(endpoint: string): Attribution {
  return {
    api: endpoint,
    url: endpoint,
    attribution: ATTRIBUTION,
    issuedAt: new Date().toISOString(),
  };
}

/** Report which factors carry no value anywhere in the block. */
export function collectMissing(
  block: HourlyBlock,
  scope: 'weather' | 'marine',
  factors: readonly string[],
): MissingFactor[] {
  if (block.hours.length === 0) {
    return factors.map((factor) => ({ factor, reason: 'block_unavailable' as const, scope }));
  }
  return factors
    .filter((factor) => block.hours.every((hour) => hour.values[factor] === null))
    .map((factor) => ({ factor, reason: 'upstream_null' as const, scope }));
}

/**
 * Fetch both APIs for one date.
 *
 * The timezone comes back inside each payload, so the date is validated
 * against the beach's own calendar day rather than the caller's.
 */
export async function fetchForecast(options: FetchForecastOptions): Promise<ForecastPair> {
  const {
    latitude,
    longitude,
    date,
    weatherFactors = WEATHER_FACTORS,
    marineFactors = MARINE_FACTORS,
    fetcher = defaultFetcher,
    now = new Date(),
  } = options;

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new InputError(`latitude must be between -90 and 90, received ${latitude}`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new InputError(`longitude must be between -180 and 180, received ${longitude}`);
  }
  if (weatherFactors.length === 0) {
    throw new InputError('at least one weather factor is required');
  }

  // The beach's local date cannot be known until a response carries its
  // timezone, so the weather request must ask for the full horizon; the
  // marine request, made second, can ask for exactly what is needed.
  const weatherUrl = buildUrl(WEATHER_ENDPOINT, {
    latitude,
    longitude,
    hourly: weatherFactors.join(','),
    timezone: 'auto',
    forecast_days: MAX_FORECAST_DAYS,
  });

  const weatherPayload = await requestPayload('weather', weatherUrl, fetcher);
  const weatherLocation = readLocation(weatherPayload, 'weather');
  // Validate against the beach's own calendar day, before parsing hours —
  // otherwise a past date surfaces as "no hourly data" rather than as the
  // input error the caller actually needs to see.
  const dayOffset = validateDate(date, weatherLocation.utcOffsetSeconds ?? 0, now);
  const weatherBlock = parseBlock(weatherPayload, weatherFactors, date, 'weather');

  const marineUrl = buildUrl(MARINE_ENDPOINT, {
    latitude,
    longitude,
    hourly: marineFactors.join(','),
    timezone: 'auto',
    forecast_days: Math.min(dayOffset + 1, MAX_FORECAST_DAYS),
  });

  let marineBlock: { block: HourlyBlock; attribution: Attribution };
  try {
    const marinePayload = await requestPayload('marine', marineUrl, fetcher);
    marineBlock = parseBlock(marinePayload, marineFactors, date, 'marine');
  } catch (error) {
    // Marine failure degrades the result rather than failing the whole call:
    // beach_day does not require marine data, and an all-null block is a
    // normal condition for a point with no sea cell in range.
    if (error instanceof ForecastError) {
      marineBlock = {
        block: { available: false, units: {}, hours: [] },
        attribution: attributionFor(MARINE_ENDPOINT),
      };
    } else {
      throw error;
    }
  }

  return {
    weather: weatherBlock.block,
    marine: marineBlock.block,
    location: weatherLocation,
    sources: [weatherBlock.attribution, marineBlock.attribution],
  };
}
