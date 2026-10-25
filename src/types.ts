/**
 * Shared output shapes for CoastWise MCP.
 *
 * These mirror docs/spec.md sections 2 and 8. Nothing in here knows about
 * HTTP or about how a score is computed — they are the contract between the
 * fetch layer, the rule engine, and the three tool handlers.
 */

/** The two things a person can intend to do at the beach. */
export type Activity = 'beach_day' | 'surfing';

/** Surfing experience; required only for the `surfing` Activity. */
export type SkillLevel = 'beginner' | 'intermediate' | 'advanced';

export type Verdict = 'favorable' | 'mixed' | 'unfavorable' | 'insufficient_data';

/**
 * Reasons an evaluation refuses to produce a score. Missing data is reported,
 * never substituted and never scored as zero.
 */
export type MissingReason =
  | 'not_requested'
  | 'upstream_null'
  | 'block_unavailable'
  | 'out_of_horizon';

export interface MissingFactor {
  factor: string;
  reason: MissingReason;
  /** Which upstream API the factor would have come from. */
  scope?: 'weather' | 'marine';
}

/** A single forecast value for one hour, with its unit. */
export interface HourReading {
  /** Beach-local ISO timestamp without an offset, e.g. `2026-10-26T09:00`. */
  time: string;
  values: Record<string, number | null>;
}

/** One upstream API's contribution for the requested date. */
export interface HourlyBlock {
  /**
   * False when every value across the block is null — Open-Meteo answers
   * HTTP 200 with a full-length array of nulls for out-of-coverage points,
   * so coverage must be detected here rather than by status code.
   */
  available: boolean;
  units: Record<string, string>;
  hours: HourReading[];
}

export interface Attribution {
  api: string;
  url: string;
  attribution: string;
  /** ISO timestamp of when the data was fetched. */
  issuedAt: string;
}

export interface LocationInfo {
  latitude: number;
  longitude: number;
  timezone: string;
  utcOffsetSeconds?: number;
}

export interface WindowSpec {
  start: string;
  end: string;
  timezone: string;
  /** True when the caller omitted a window and 07:00-19:00 was applied. */
  defaulted: boolean;
}

/** One row of the per-Factor explanation that `rate_activity_conditions` returns. */
export interface FactorDetail {
  factor: string;
  label: string;
  unit: string;
  value: number | null;
  band: string | null;
  /** Band score before weighting: -2..+2. */
  score: number | null;
  weight: number;
  /** score × weight. */
  contribution: number | null;
  required: boolean;
  status: 'scored' | 'optional_missing' | 'context_only';
}

export interface ScoreBlock {
  /** 0-100, rounded, normalized across the range attainable here. */
  value: number;
  /** Signed point total before normalization. */
  raw: number;
  attainableRange: { min: number; max: number };
  thresholds: { favorable: number; mixed: number };
}

export interface VetoDetail {
  id: 'thunderstorm' | 'frozen_precipitation' | 'wave_above_skill_ceiling';
  factor: string;
  value: number;
  unit: string;
  reason: string;
  /** The score the raw rules produced before the override. */
  overriddenScore: number | null;
}

export interface ForecastResponse {
  location: LocationInfo;
  date: string;
  sources: Attribution[];
  weather: HourlyBlock;
  marine: HourlyBlock;
  missing: MissingFactor[];
  limitations: string[];
}

export interface RatingResponse {
  verdict: Verdict;
  score: ScoreBlock | null;
  veto: VetoDetail | null;
  factors: FactorDetail[];
  improving: string[];
  reducing: string[];
  missing: MissingFactor[];
  window: WindowSpec;
  location: LocationInfo;
  limitations: string[];
}

export interface WindowCandidate {
  start: string;
  end: string;
  score: number | null;
  verdict: Verdict;
}

export interface BestWindowResponse {
  searched: { start: string; end: string; timezone: string };
  windowHours: number;
  strideHours: number;
  best: { start: string; end: string; score: number; verdict: Verdict } | null;
  /** Set only when `best` is null; never an empty object instead. */
  reason: string | null;
  candidates: WindowCandidate[];
  evaluatedHours: number;
  skippedHours: Array<{ time: string; reason: string }>;
  limitations: string[];
}
