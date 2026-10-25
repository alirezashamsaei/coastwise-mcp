/**
 * docs/spec.md §4 — the Factor tables as data, plus the §6 required-Factor sets.
 *
 * Nothing here computes: the tables are a literal transcription of the spec so
 * a reviewer can diff code against doc row by row. Lookups are pure and total —
 * they return `null` rather than guessing.
 *
 * Structural notes:
 * - A Band is half-open: `min` inclusive, `max` exclusive. An open end of the
 *   spec's table uses ±Infinity. A band with `max === min` is a zero-width point
 *   band that matches exactly that one value; only `precipitation`'s `= 0` row
 *   needs one, because it cannot be written as a half-open range.
 * - Tables the spec leaves closed at the top (`wave_height` for `surfing`) stay
 *   closed: values above the top row have no Band, which scoring reports as
 *   unbandable rather than inventing one. Closed tops are intentional — §4.8
 *   puts those values behind the `wave_above_skill_ceiling` Veto (§5).
 *
 * Two spec readings that needed a decision:
 * 1. §4.3's `VETO` rows carry no number. They are transcribed as `score: -2`
 *    (the table floor) so `weather_code` still participates in normalization on
 *    a stormy day. The Veto itself is applied by `src/vetoes.ts`, never here.
 * 2. §4.4 writes `(0, 0.5]`, contradicting §4's "inclusive-low, exclusive-high"
 *    header. The header wins: boundaries are exclusive-high, so `0.5 mm/h`
 *    lands in `0.5–2`. Only `= 0` is kept exact, via the point band.
 *
 * And one conflict, resolved for §6 (which the task names authoritative for
 * required-Factor sets): §4.1 marks `weather_code` required "both", but §6's
 * `surfing` row omits it, so surfing does not require it.
 */

import type { Activity, SkillLevel } from './types.js';

/** A contiguous range of a Factor's raw values, mapped to a fixed point value. */
export interface Band {
  /** Inclusive lower bound. */
  min: number;
  /** Exclusive upper bound; `Infinity` for a table's open top. */
  max: number;
  /** Band score, −2…+2. */
  score: number;
  /** Human range for the response's `band` field, e.g. `"0.5–1.0 m"`. */
  label: string;
}

/** Canonical Factor names, matching the Open-Meteo parameter names they read. */
export type Factor =
  | 'temperature_2m'
  | 'weather_code'
  | 'precipitation'
  | 'wind_speed_10m'
  | 'wave_height'
  | 'wave_period'
  | 'uv_index'
  | 'wind_gusts_10m'
  | 'sea_surface_temperature'
  | 'swell_wave_height'
  | 'swell_wave_period';

/** Which upstream API supplies a Factor's value. */
export type FactorScope = 'weather' | 'marine';

/** Factors the rules score, in the order §4.1 lists them. */
export const FACTORS: readonly Factor[] = [
  'temperature_2m',
  'weather_code',
  'precipitation',
  'wind_speed_10m',
  'wave_height',
  'wave_period',
  'uv_index',
  'wind_gusts_10m',
  'sea_surface_temperature',
  'swell_wave_height',
  'swell_wave_period',
] as const;

/** Display metadata for a Factor, used to build `FactorDetail` rows. */
export interface FactorMeta {
  label: string;
  unit: string;
  scope: FactorScope;
}

export const FACTOR_META: Readonly<Record<Factor, FactorMeta>> = {
  temperature_2m: { label: 'Air temperature', unit: '°C', scope: 'weather' },
  weather_code: { label: 'Weather code', unit: 'WMO', scope: 'weather' },
  precipitation: { label: 'Precipitation', unit: 'mm/h', scope: 'weather' },
  wind_speed_10m: { label: 'Wind speed', unit: 'km/h', scope: 'weather' },
  wave_height: { label: 'Wave height', unit: 'm', scope: 'marine' },
  wave_period: { label: 'Wave period', unit: 's', scope: 'marine' },
  uv_index: { label: 'UV index', unit: 'UV index', scope: 'weather' },
  wind_gusts_10m: { label: 'Wind gusts', unit: 'km/h', scope: 'weather' },
  sea_surface_temperature: { label: 'Sea surface temperature', unit: '°C', scope: 'marine' },
  swell_wave_height: { label: 'Swell height', unit: 'm', scope: 'marine' },
  swell_wave_period: { label: 'Swell period', unit: 's', scope: 'marine' },
} as const;

/** Human label for a Factor. */
export function factorLabel(factor: Factor): string {
  return FACTOR_META[factor].label;
}

/** Unit for a Factor. */
export function factorUnit(factor: Factor): string {
  return FACTOR_META[factor].unit;
}

/** Factors each Activity's rules consider, in spec order. */
export const ACTIVITY_FACTORS: Readonly<Record<Activity, readonly Factor[]>> = {
  beach_day: [
    'temperature_2m',
    'weather_code',
    'precipitation',
    'wind_speed_10m',
    'wave_height',
    'uv_index',
    'wind_gusts_10m',
    'sea_surface_temperature',
  ],
  surfing: [
    'temperature_2m',
    'weather_code',
    'precipitation',
    'wind_speed_10m',
    'wave_height',
    'wave_period',
    'wind_gusts_10m',
    'sea_surface_temperature',
    'swell_wave_height',
    'swell_wave_period',
  ],
} as const;

/** The Factors an Activity considers, in spec order. */
export function factorsFor(activity: Activity): readonly Factor[] {
  return ACTIVITY_FACTORS[activity];
}

/**
 * §4.1 weights. `null` means §4.1 draws an em-dash: the Factor is not scored
 * for that Activity and never appears in its Factor set.
 */
export type WeightTable = Readonly<Record<Factor, number | null>>;

export const WEIGHTS: Readonly<Record<Activity, WeightTable>> = {
  beach_day: {
    temperature_2m: 4,
    weather_code: 4,
    precipitation: 3,
    wind_speed_10m: 3,
    wave_height: 1,
    wave_period: null,
    uv_index: 2,
    wind_gusts_10m: 1,
    sea_surface_temperature: 1,
    swell_wave_height: null,
    swell_wave_period: null,
  },
  surfing: {
    temperature_2m: 2,
    weather_code: 1,
    precipitation: 1,
    wind_speed_10m: 3,
    wave_height: 4,
    wave_period: 3,
    uv_index: null,
    wind_gusts_10m: 1,
    sea_surface_temperature: 1,
    swell_wave_height: 2,
    swell_wave_period: 1,
  },
} as const;

/**
 * Weight for a Factor under an Activity, or `null` when the em-dash means the
 * Factor is not scored for that Activity.
 */
export function weightFor(factor: Factor, activity: Activity): number | null {
  return WEIGHTS[activity][factor];
}

/**
 * §6 required-Factor sets. `weather_code` is scored by surfing (weight 1) but
 * is not required there — §6's row lists five Factors and omits it.
 */
export const REQUIRED_FACTORS: Readonly<Record<Activity, readonly Factor[]>> = {
  beach_day: ['temperature_2m', 'weather_code', 'precipitation', 'wind_speed_10m'],
  surfing: ['wave_height', 'wave_period', 'wind_speed_10m', 'temperature_2m', 'precipitation'],
} as const;

/** The Factors without which an Activity's evaluation is `insufficient_data`. */
export function requiredFactorsFor(activity: Activity): readonly Factor[] {
  return REQUIRED_FACTORS[activity];
}

/** True when an Activity cannot be scored without this Factor. */
export function isRequired(factor: Factor, activity: Activity): boolean {
  return REQUIRED_FACTORS[activity].includes(factor);
}

/* -------------------------------------------------------------------------- */
/* §4.2 temperature_2m — °C                                                   */
/* -------------------------------------------------------------------------- */

const TEMPERATURE_BANDS: readonly Band[] = [
  { min: -Infinity, max: 14, score: -2, label: '< 14 °C' },
  { min: 14, max: 18, score: -1, label: '14–18 °C' },
  { min: 18, max: 22, score: 0, label: '18–22 °C' },
  { min: 22, max: 26, score: 1, label: '22–26 °C' },
  { min: 26, max: 32, score: 2, label: '26–32 °C' },
  { min: 32, max: 35, score: 1, label: '32–35 °C' },
  { min: 35, max: Infinity, score: 0, label: '≥ 35 °C' },
] as const;

/* -------------------------------------------------------------------------- */
/* §4.3 weather_code — WMO codes                                              */
/* -------------------------------------------------------------------------- */

/**
 * WMO codes are discrete, so each Band covers exactly one code. `min === max` is
 * the zero-width point band described in the header.
 *
 * The two VETO rows (§4.3, §5) are scored −2 here; `src/vetoes.ts` applies the
 * override.
 */
const WEATHER_CODE_BANDS: readonly Band[] = [
  { min: 0, max: 1, score: 2, label: '0 clear' },
  { min: 1, max: 2, score: 2, label: '1 mainly clear' },
  { min: 2, max: 3, score: 1, label: '2 partly cloudy' },
  { min: 3, max: 4, score: 0, label: '3 overcast' },
  { min: 45, max: 46, score: -1, label: '45 fog' },
  { min: 48, max: 49, score: -1, label: '48 depositing rime fog' },
  { min: 51, max: 52, score: 0, label: '51 light drizzle' },
  { min: 53, max: 54, score: 0, label: '53 moderate drizzle' },
  { min: 55, max: 56, score: 0, label: '55 dense drizzle' },
  { min: 56, max: 57, score: 0, label: '56 freezing drizzle' },
  { min: 57, max: 58, score: 0, label: '57 dense freezing drizzle' },
  { min: 61, max: 62, score: 0, label: '61 slight rain' },
  { min: 62, max: 63, score: 0, label: '62 moderate rain' },
  { min: 63, max: 64, score: 0, label: '63 heavy rain' },
  { min: 64, max: 65, score: 0, label: '64 slight freezing rain' },
  { min: 65, max: 66, score: 0, label: '65 heavy freezing rain' },
  { min: 66, max: 67, score: -2, label: '66 freezing rain (VETO)' },
  { min: 67, max: 68, score: -2, label: '67 heavy freezing rain (VETO)' },
  { min: 71, max: 72, score: -2, label: '71 slight snow (VETO)' },
  { min: 72, max: 73, score: -2, label: '72 moderate snow (VETO)' },
  { min: 73, max: 74, score: -2, label: '73 heavy snow (VETO)' },
  { min: 74, max: 75, score: -2, label: '74 snow grains (VETO)' },
  { min: 75, max: 76, score: -2, label: '75 moderate snow (VETO)' },
  { min: 76, max: 77, score: -2, label: '76 heavy snow (VETO)' },
  { min: 77, max: 78, score: -2, label: '77 snow grains (VETO)' },
  { min: 80, max: 81, score: 0, label: '80 slight rain showers' },
  { min: 81, max: 82, score: 0, label: '81 moderate rain showers' },
  { min: 82, max: 83, score: 0, label: '82 violent rain showers' },
  { min: 85, max: 86, score: -2, label: '85 slight snow showers (VETO)' },
  { min: 86, max: 87, score: -2, label: '86 heavy snow showers (VETO)' },
  { min: 95, max: 96, score: -2, label: '95 thunderstorm (VETO)' },
  { min: 96, max: 97, score: -2, label: '96 thunderstorm with hail (VETO)' },
  { min: 99, max: 100, score: -2, label: '99 thunderstorm with heavy hail (VETO)' },
] as const;

/* -------------------------------------------------------------------------- */
/* §4.4 precipitation — mm/h                                                  */
/* -------------------------------------------------------------------------- */

const PRECIPITATION_BANDS: readonly Band[] = [
  { min: 0, max: 0, score: 2, label: '0 mm/h' },
  { min: 0.000001, max: 0.5, score: 1, label: '> 0–0.5 mm/h' },
  { min: 0.5, max: 2, score: 0, label: '0.5–2 mm/h' },
  { min: 2, max: 10, score: -1, label: '2–10 mm/h' },
  { min: 10, max: Infinity, score: -2, label: '> 10 mm/h' },
] as const;

/* -------------------------------------------------------------------------- */
/* §4.5 wind_speed_10m — km/h                                                 */
/* -------------------------------------------------------------------------- */

const WIND_SPEED_BANDS: readonly Band[] = [
  { min: -Infinity, max: 12, score: 2, label: '< 12 km/h' },
  { min: 12, max: 20, score: 1, label: '12–20 km/h' },
  { min: 20, max: 28, score: 0, label: '20–28 km/h' },
  { min: 28, max: 40, score: -1, label: '28–40 km/h' },
  { min: 40, max: Infinity, score: -2, label: '> 40 km/h' },
] as const;

/* -------------------------------------------------------------------------- */
/* §4.6 uv_index                                                              */
/* -------------------------------------------------------------------------- */

const UV_INDEX_BANDS: readonly Band[] = [
  { min: -Infinity, max: 3, score: 0, label: '0–2' },
  { min: 3, max: 6, score: 1, label: '3–5' },
  { min: 6, max: 8, score: 2, label: '6–7' },
  { min: 8, max: 11, score: 1, label: '8–10' },
  { min: 11, max: Infinity, score: 0, label: '> 10' },
] as const;

/* -------------------------------------------------------------------------- */
/* §4.7 wind_gusts_10m — km/h                                                 */
/* -------------------------------------------------------------------------- */

const WIND_GUSTS_BANDS: readonly Band[] = [
  { min: -Infinity, max: 20, score: 2, label: '< 20 km/h' },
  { min: 20, max: 30, score: 1, label: '20–30 km/h' },
  { min: 30, max: 40, score: 0, label: '30–40 km/h' },
  { min: 40, max: 55, score: -1, label: '40–55 km/h' },
  { min: 55, max: Infinity, score: -2, label: '> 55 km/h' },
] as const;

/* -------------------------------------------------------------------------- */
/* §4.8 wave_height — m                                                       */
/* -------------------------------------------------------------------------- */

/** `beach_day`: smaller is calmer, so the table is monotonic and open-topped. */
const WAVE_HEIGHT_BEACH_DAY: readonly Band[] = [
  { min: -Infinity, max: 0.3, score: 2, label: '< 0.3 m' },
  { min: 0.3, max: 0.7, score: 1, label: '0.3–0.7 m' },
  { min: 0.7, max: 1.2, score: 0, label: '0.7–1.2 m' },
  { min: 1.2, max: 2.0, score: -1, label: '1.2–2.0 m' },
  { min: 2.0, max: Infinity, score: -2, label: '> 2.0 m' },
] as const;

/**
 * §4.8's `surfing` grid read as three separate tables, as the spec instructs.
 * Each is a *peak* curve: flat water and closing-out surf both score badly.
 *
 * These tables are closed at the top because the grid's top row for each skill
 * level is where that level's ceiling begins — `wave_above_skill_ceiling`
 * (§5) takes over above it, and `bandFor` returns `null` for an unbandable
 * value rather than assigning a Band the spec never defined.
 *
 * The em-dash rows are simply absent: the merged grid's `—` means "this range is
 * not part of that level's table", not "score 0". That makes the three tables
 * structurally distinct, which is the point of reading them separately.
 */
const WAVE_HEIGHT_SURFING: Readonly<Record<SkillLevel, readonly Band[]>> = {
  // ceiling 1.5 m
  beginner: [
    { min: -Infinity, max: 0.3, score: -2, label: '< 0.3 m' },
    { min: 0.3, max: 0.4, score: 1, label: '0.3–0.4 m' },
    { min: 0.4, max: 0.5, score: 1, label: '0.4–0.5 m' },
    { min: 0.5, max: 1.0, score: 2, label: '0.5–1.0 m' },
    { min: 1.0, max: 1.3, score: 0, label: '1.0–1.3 m' },
    { min: 1.3, max: 1.8, score: -1, label: '1.3–1.8 m' },
  ],
  // ceiling 2.5 m
  intermediate: [
    { min: -Infinity, max: 0.3, score: -2, label: '< 0.3 m' },
    { min: 0.3, max: 0.4, score: -2, label: '0.3–0.4 m' },
    { min: 0.4, max: 0.5, score: 1, label: '0.4–0.5 m' },
    { min: 0.5, max: 1.0, score: 1, label: '0.5–1.0 m' },
    { min: 1.0, max: 1.3, score: 1, label: '1.0–1.3 m' },
    { min: 1.3, max: 1.8, score: 2, label: '1.3–1.8 m' },
    { min: 1.8, max: 2.0, score: 2, label: '1.8–2.0 m' },
    { min: 2.0, max: 2.2, score: 0, label: '2.0–2.2 m' },
    { min: 2.2, max: 2.5, score: -1, label: '2.2–2.5 m' },
  ],
  // ceiling 4.0 m
  advanced: [
    { min: -Infinity, max: 0.3, score: -2, label: '< 0.3 m' },
    { min: 0.4, max: 0.5, score: -2, label: '0.4–0.5 m' },
    { min: 0.5, max: 1.0, score: 0, label: '0.5–1.0 m' },
    { min: 1.0, max: 1.3, score: 0, label: '1.0–1.3 m' },
    { min: 1.3, max: 1.8, score: 1, label: '1.3–1.8 m' },
    { min: 1.8, max: 2.0, score: 1, label: '1.8–2.0 m' },
    { min: 2.0, max: 2.2, score: 2, label: '2.0–2.2 m' },
    { min: 2.2, max: 2.5, score: 2, label: '2.2–2.5 m' },
    { min: 2.5, max: 3.2, score: 2, label: '2.5–3.2 m' },
    { min: 3.2, max: 4.0, score: 0, label: '3.2–4.0 m' },
  ],
} as const;

/** `beach_day` has one wave-height table; `surfing` has one per Skill level. */
export const WAVE_HEIGHT_BANDS: Readonly<Record<Activity, readonly Band[]>> = {
  beach_day: WAVE_HEIGHT_BEACH_DAY,
  surfing: WAVE_HEIGHT_SURFING.intermediate,
} as const;

/**
 * §4.8's per-Skill-level `surfing` tables, keyed by Skill level. This is the
 * shape the spec asks for (`waveHeightBands[skillLevel]`), and the reason
 * `bandFor` takes a `skillLevel`.
 */
export const waveHeightBands: Readonly<Record<SkillLevel, readonly Band[]>> =
  WAVE_HEIGHT_SURFING;

/** Veto ceiling (m) above which `wave_above_skill_ceiling` fires. §4.8 / §5. */
export const WAVE_HEIGHT_CEILING: Readonly<Record<SkillLevel, number>> = {
  beginner: 1.5,
  intermediate: 2.5,
  advanced: 4.0,
} as const;

/* -------------------------------------------------------------------------- */
/* §4.9 wave_period / swell_wave_period — s                                   */
/* -------------------------------------------------------------------------- */

const WAVE_PERIOD_BANDS: readonly Band[] = [
  { min: -Infinity, max: 5, score: -2, label: '< 5 s' },
  { min: 5, max: 7, score: -1, label: '5–7 s' },
  { min: 7, max: 9, score: 0, label: '7–9 s' },
  { min: 9, max: 12, score: 1, label: '9–12 s' },
  { min: 12, max: Infinity, score: 2, label: '> 12 s' },
] as const;

/* -------------------------------------------------------------------------- */
/* §4.10 swell_wave_height — m                                                */
/* -------------------------------------------------------------------------- */

const SWELL_HEIGHT_BANDS: readonly Band[] = [
  { min: -Infinity, max: 0.3, score: -1, label: '< 0.3 m' },
  { min: 0.3, max: 1.5, score: 2, label: '0.3–1.5 m' },
  { min: 1.5, max: 2.5, score: 1, label: '1.5–2.5 m' },
  { min: 2.5, max: 3.5, score: 0, label: '2.5–3.5 m' },
  { min: 3.5, max: Infinity, score: -1, label: '> 3.5 m' },
] as const;

/* -------------------------------------------------------------------------- */
/* §4.11 sea_surface_temperature — °C                                         */
/* -------------------------------------------------------------------------- */

const SEA_SURFACE_BANDS: readonly Band[] = [
  { min: -Infinity, max: 14, score: -1, label: '< 14 °C' },
  { min: 14, max: 18, score: 0, label: '14–18 °C' },
  { min: 18, max: 26, score: 2, label: '18–26 °C' },
  { min: 26, max: 29, score: 1, label: '26–29 °C' },
  { min: 29, max: Infinity, score: 0, label: '≥ 29 °C' },
] as const;

/* -------------------------------------------------------------------------- */
/* Lookup                                                                      */
/* -------------------------------------------------------------------------- */

/** The Band tables for a Factor under an Activity at a Skill level. */
export function bandsFor(
  factor: Factor,
  activity: Activity,
  skillLevel?: SkillLevel,
): readonly Band[] | null {
  switch (factor) {
    case 'temperature_2m':
      return TEMPERATURE_BANDS;
    case 'weather_code':
      return WEATHER_CODE_BANDS;
    case 'precipitation':
      return PRECIPITATION_BANDS;
    case 'wind_speed_10m':
      return WIND_SPEED_BANDS;
    case 'uv_index':
      return UV_INDEX_BANDS;
    case 'wind_gusts_10m':
      return WIND_GUSTS_BANDS;
    case 'wave_period':
      return WAVE_PERIOD_BANDS;
    case 'swell_wave_period':
      return WAVE_PERIOD_BANDS;
    case 'swell_wave_height':
      return SWELL_HEIGHT_BANDS;
    case 'sea_surface_temperature':
      return SEA_SURFACE_BANDS;
    case 'wave_height':
      return activity === 'surfing'
        ? waveHeightBands[skillLevel ?? 'intermediate']
        : WAVE_HEIGHT_BEACH_DAY;
  }
}

/**
 * The Band whose range contains `value`: the first band with
 * `min <= value < max` (or `min === value` for a point band).
 *
 * Returns `null` when no band covers the value — a closed table's gap or its
 * ceiling. Callers report `null` as unbandable; they never substitute a Band.
 */
export function findBand(
  bands: readonly Band[],
  value: number,
): Band | null {
  for (const band of bands) {
    if (band.min === band.max ? value === band.min : value >= band.min && value < band.max) {
      return band;
    }
  }
  return null;
}
