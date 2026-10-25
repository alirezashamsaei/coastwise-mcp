/**
 * Fixed facts CoastWise carries around: upstream endpoints, the attribution
 * string required by the Open-Meteo licence, and the limitations that must
 * accompany every tool response.
 *
 * See docs/adr/0005-never-pass-cell-selection.md for why requests are built
 * the way they are.
 */

export const WEATHER_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
/** The marine API lives on its own host — api.open-meteo.com/v1/marine is a 404. */
export const MARINE_ENDPOINT = 'https://marine-api.open-meteo.com/v1/marine';

/** CC BY 4.0 attribution; required in every response that carries Open-Meteo data. */
export const ATTRIBUTION = 'Weather data by Open-Meteo.com';
export const ATTRIBUTION_URL = 'https://open-meteo.com/';

/**
 * Open-Meteo's real forecast reach. Weather offers 16 days but marine holds
 * out for only ~7, and we cap at 7 so the two stay aligned rather than
 * silently returning a weather-only horizon.
 */
export const MAX_FORECAST_DAYS = 7;

/** The window applied when a caller omits one: a deterministic daylight-ish block. */
export const DEFAULT_WINDOW = { start: '07:00', end: '19:00' } as const;

/** `find_best_activity_window` slides these across the requested period. */
export const WINDOW_HOURS = 3;
export const WINDOW_STRIDE_HOURS = 1;

/** Verdict cutoffs on the normalized 0-100 Suitability score. */
export const FAVORABLE_THRESHOLD = 70;
export const MIXED_THRESHOLD = 40;

export const LIMITATIONS: readonly string[] = [
  'The score is a suitability heuristic, not a safety guarantee.',
  'No tide data: Open-Meteo has no tide API, and sea_level_height_msl uses a mean datum that is not suitable for coastal navigation.',
  'No rip currents, beach flags, surf ratings, or lifeguard warnings exist in any Open-Meteo product.',
  'Wave direction is not scored, because shore orientation cannot be derived from a coordinate.',
  'Offshore versus onshore wind is not distinguished, for the same reason.',
  'Marine coverage is unreliable within roughly 15 km of open water; beyond that, surfing returns insufficient_data.',
  'Marine forecast horizon is about 7 days, shorter than the weather horizon.',
] as const;
