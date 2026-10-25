/**
 * Window evaluation — the decision behind `rate_activity_conditions`.
 *
 * Aggregates a set of hours into one verdict by feeding the merged per-hour
 * values into the scoring engine (Stage 1 + Stage 2), then applying the
 * hard Vetoes from `src/vetoes.ts` on top (ADR-0001).
 *
 * Aggregation rules, stated once because they are what a reviewer will probe:
 *  - a required Factor must be present in **every** hour of the window, or the
 *    window is `insufficient_data`;
 *  - continuous Factors are averaged across the window;
 *  - `weather_code` is categorical, so it takes the mode — averaging WMO
 *    codes would invent a code nobody reported;
 *  - a Veto fires if **any** hour in the window trips it. One thunderstorm in
 *    the window disqualifies the window.
 */

import { FACTOR_META, REQUIRED_FACTORS, factorsFor, type Factor } from './bands.js';
import { evaluate, type FactorValues } from './scoring.js';
import { DEFAULT_WINDOW, FAVORABLE_THRESHOLD, LIMITATIONS, MIXED_THRESHOLD } from './constants.js';
import { evaluateVeto } from './vetoes.js';
import type {
  Activity,
  FactorDetail,
  HourReading,
  LocationInfo,
  MissingFactor,
  MissingReason,
  RatingResponse,
  SkillLevel,
  VetoDetail,
  WindowSpec,
} from './types.js';

export interface EvaluateWindowInput {
  activity: Activity;
  skillLevel?: SkillLevel;
  hours: HourReading[];
  location: LocationInfo;
  /** Raw window the caller asked for; omitted applies the default block. */
  requestedWindow?: { start: string; end: string };
  missing: MissingFactor[];
}

export class EvaluationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationInputError';
  }
}

/** Validate activity/skillLevel pairing before anything is computed. */
export function resolveSkillLevel(activity: Activity, skillLevel?: SkillLevel): SkillLevel | undefined {
  if (activity === 'surfing' && skillLevel === undefined) {
    throw new EvaluationInputError('skillLevel is required when activity is "surfing"');
  }
  return activity === 'surfing' ? skillLevel : undefined;
}

/** Resolve the window to evaluate, defaulting to the daylight block. */
export function resolveWindow(
  requested?: { start: string; end: string },
): { start: string; end: string; defaulted: boolean } {
  const win = requested ?? DEFAULT_WINDOW;
  if (win.start === win.end) {
    throw new EvaluationInputError('window start and end cannot be the same time');
  }
  if (win.start > win.end) {
    throw new EvaluationInputError('window start must be earlier than end (same-day windows only)');
  }
  return { start: win.start, end: win.end, defaulted: requested === undefined };
}

/**
 * Keep only the hours inside the window. `time` is a beach-local ISO string
 * with no offset, so a plain string comparison is correct.
 */
export function hoursInRange(hours: HourReading[], start: string, end: string): HourReading[] {
  return hours.filter((hour) => {
    const t = hour.time.slice(11, 16);
    return t >= start && t <= end;
  });
}

/** Most frequent value, first-seen wins ties — used for categorical codes. */
function mode(values: Array<number | null>): number | null {
  const counts = new Map<number, number>();
  for (const value of values) {
    if (value === null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Collapse the window's hours into one `FactorValues` map, plus which Factors
 * are unusable because they are not present in every hour.
 */
export function aggregateHours(
  activity: Activity,
  hours: HourReading[],
): { values: FactorValues; incomplete: Factor[] } {
  const considered = factorsFor(activity);
  const values: FactorValues = {};
  const incomplete: Factor[] = [];

  for (const factor of considered) {
    const column = hours.map((hour) => hour.values[factor] ?? null);
    const present = column.filter((value): value is number => value !== null);

    if (present.length !== hours.length || present.length === 0) {
      incomplete.push(factor);
      continue;
    }

    values[factor] = factor === 'weather_code' ? (mode(column) ?? null) : mean(present);
  }

  return { values, incomplete };
}

/** Reasons an incomplete Factor can be reported as missing. */
/** Why a Factor could not be aggregated across the window. */
function reasonFor(hours: HourReading[]): MissingReason {
  // No hours at all means the requested date is outside what upstream returned;
  // otherwise the Factor is absent from at least one hour of the window.
  return hours.length === 0 ? 'out_of_horizon' : 'upstream_null';
}

/** Run scoring for the window, then apply Vetoes on top. */
export function evaluateWindow(input: EvaluateWindowInput): RatingResponse {
  const { activity, skillLevel, hours, location, requestedWindow, missing } = input;
  const window = resolveWindow(requestedWindow);
  const required = REQUIRED_FACTORS[activity];

  const { values, incomplete } = aggregateHours(activity, hours);
  const consideredFactors = factorsFor(activity);

  const base = evaluate({ activity, skillLevel, values });

  // Vetoes inspect every hour, not just the aggregate: one storm in the
  // window disqualifies the window even if the mode code is clear sky.
  const vetoOutcome = pickVeto(activity, skillLevel, hours, base.score?.value ?? null);

  const missingAll: MissingFactor[] = [
    ...missing,
    ...incomplete.map((factor) => ({
      factor,
      reason: reasonFor(hours),
      scope: FACTOR_META[factor].scope,
    })),
  ];
  // De-duplicate by factor, keeping the first reason.
  const seen = new Set<string>();
  const dedupedMissing = missingAll.filter((entry) =>
    seen.has(entry.factor) ? false : (seen.add(entry.factor), true),
  );

  const factors: FactorDetail[] = base.factors.map((row) => {
    if (row.status === 'optional_missing' && required.includes(row.factor as Factor)) {
      return { ...row, required: true, status: 'optional_missing' as const };
    }
    return row;
  });

  const improving = factors
    .filter((row) => (row.contribution ?? 0) > 0)
    .sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0))
    .map((row) => row.factor);

  const reducing = factors
    .filter((row) => (row.contribution ?? 0) < 0)
    .sort((a, b) => (a.contribution ?? 0) - (b.contribution ?? 0))
    .map((row) => row.factor);

  const gated = base.verdict === 'insufficient_data';

  return {
    verdict: gated ? 'insufficient_data' : (vetoOutcome?.id ? 'unfavorable' : base.verdict),
    score: gated ? null : base.score,
    veto: gated ? null : vetoOutcome,
    factors,
    improving,
    reducing,
    missing: dedupedMissing,
    window: { ...window, timezone: location.timezone },
    location,
    limitations: [...LIMITATIONS],
  };
}

/** First Veto any hour trips, already carrying the score it overrode. */
function pickVeto(
  activity: Activity,
  skillLevel: SkillLevel | undefined,
  hours: HourReading[],
  overriddenScore: number | null,
): VetoDetail | null {
  for (const hour of hours) {
    const weatherCode = hour.values['weather_code'] ?? null;
    const waveHeight = hour.values['wave_height'] ?? null;
    const { veto } = evaluateVeto({ activity, skillLevel, weatherCode, waveHeight }, overriddenScore);
    if (veto) return veto;
  }
  return null;
}

export { FAVORABLE_THRESHOLD, MIXED_THRESHOLD };

/**
 * Merge the weather and marine blocks into one hourly series, keyed by time.
 * Hours present in only one block keep their partial values — coverage is
 * decided later by the required-Factor gate, not here.
 */
export function mergeHours(
  weather: HourReading[],
  marine: HourReading[],
): HourReading[] {
  const byTime = new Map<string, Record<string, number | null>>();

  for (const hour of weather) {
    byTime.set(hour.time, { ...hour.values });
  }
  for (const hour of marine) {
    const existing = byTime.get(hour.time);
    if (existing) Object.assign(existing, hour.values);
    else byTime.set(hour.time, { ...hour.values });
  }

  return [...byTime.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([time, values]) => ({
    time,
    values,
  }));
}
