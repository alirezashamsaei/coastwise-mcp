/**
 * docs/spec.md §3 — contribution, normalization, verdict.
 *
 * Pure and deterministic: same inputs, same output. No clock, no randomness, no
 * network, no I/O of any kind. The two hard rules from §3.3 are structural here
 * rather than remembered at each call site:
 *
 * - A Factor with no value is never substituted and never scored as `0`. It is
 *   reported with `value: null` and, if required, gates the verdict to
 *   `insufficient_data`.
 * - An optional Factor with no value is skipped entirely: it contributes
 *   nothing *and* does not widen the attainable range, so omitting it and
 *   passing `null` produce byte-identical results.
 *
 * ## Two decisions worth knowing
 *
 * **Degenerate normalization.** `value = round((raw − min) / (max − min) × 100)`
 * divides by zero when the considered Factor set is empty (`min === max === 0`).
 * This module returns **0** for that case rather than 50: an evaluation with
 * nothing scored earned nothing, and `evaluate` returns `insufficient_data` with
 * a `null` score before a caller can ever see that 0.
 *
 * **Status vocabulary.** `FactorDetail.status` has three values and the spec
 * never assigns them case by case, so this module uses:
 *
 * | status | meaning |
 * |---|---|
 * | `scored` | value present, Band found, contribution computed |
 * | `optional_missing` | no value — `required` in the same row says whether it gated |
 * | `context_only` | value present but not scored for this Activity: either the Activity has no weight for it, or no Band covers the value |
 *
 * The first gap is a spec gap: §2.3 calls out "a required entry with
 * `value: null`" separately from `status: 'optional_missing'` but never names a
 * fourth status, and the type offers none. `required: true` on the row carries
 * the distinction.
 *
 * The second case matters for §4.8, whose merged grid leaves real holes —
 * `advanced` has no Band for `0.3–0.4 m`, and every surfing table stops at its
 * ceiling. Such a value is reported, not guessed at: no Band means no score, no
 * contribution, and no widening of the attainable range.
 *
 * Vetoes (§5) are deliberately absent from this module — they are
 * `src/vetoes.ts`, and a Veto must never fire on evidence we do not have.
 */

import { FAVORABLE_THRESHOLD, MIXED_THRESHOLD } from './constants.js';
import {
  ACTIVITY_FACTORS,
  FACTORS,
  FACTOR_META,
  REQUIRED_FACTORS,
  bandsFor,
  findBand,
  weightFor,
} from './bands.js';
import type { Band, Factor } from './bands.js';
import type { Activity, FactorDetail, ScoreBlock, SkillLevel, Verdict } from './types.js';

/** One Factor's value for the evaluated window; `null`/absent means no data. */
export type FactorValues = Partial<Record<Factor, number | null>>;

/** Signed points an evaluation can reach, over exactly the Factors considered. */
export interface AttainableRange {
  min: number;
  max: number;
}

export interface EvaluationInput {
  activity: Activity;
  /** Required by spec §2.1 whenever `activity === 'surfing'`. */
  skillLevel?: SkillLevel;
  /** Values for the hour or window being evaluated. Missing keys mean no data. */
  values: FactorValues;
}

export interface Evaluation {
  verdict: Verdict;
  /** `null` exactly when the verdict is `insufficient_data`. */
  score: ScoreBlock | null;
  /** One row per Factor, in spec §4.1 order. */
  factors: FactorDetail[];
  /** Required Factors that had no value. Empty whenever a score was produced. */
  missingRequired: Factor[];
}

/* -------------------------------------------------------------------------- */
/* Stage 1 — band lookup and contribution (§3.1)                               */
/* -------------------------------------------------------------------------- */

/**
 * The Band containing `value` for a Factor under an Activity at a Skill level,
 * or `null` when no Band covers it.
 *
 * Boundaries are inclusive-low, exclusive-high: a value sitting exactly on a
 * boundary takes the upper Band.
 *
 * Returns `null` rather than guessing when `activity` is `surfing`, the Factor
 * is `wave_height`, and no `skillLevel` was given — §4.8's table is per Skill
 * level and picking one would be inventing data. Spec §2.1 makes that an input
 * error one layer up.
 */
export function bandFor(
  factor: Factor,
  value: number,
  activity: Activity,
  skillLevel?: SkillLevel,
): Band | null {
  if (!Number.isFinite(value)) return null;
  const bands = bandsFor(factor, activity, skillLevel);
  if (!bands) return null;
  return findBand(bands, value);
}

export interface Contribution {
  band: Band;
  /** Band score before weighting: −2…+2. */
  score: number;
  weight: number;
  /** `score × weight`. */
  contribution: number;
}

/**
 * A Factor's contribution, or `null` when it cannot be contributed: the value
 * is absent, non-finite, uncovered by a Band, or the Activity does not score
 * this Factor at all (§4.1's em-dash).
 */
export function contributionFor(
  factor: Factor,
  value: number | null | undefined,
  activity: Activity,
  skillLevel?: SkillLevel,
): Contribution | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const weight = weightFor(factor, activity);
  if (weight === null) return null;
  const band = bandFor(factor, value, activity, skillLevel);
  if (band === null) return null;
  return { band, score: band.score, weight, contribution: band.score * weight };
}

/* -------------------------------------------------------------------------- */
/* Stage 2 — normalize (§3.2)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `attainable = { min: Σ(−2 × weight), max: Σ(+2 × weight) }` over the Factors
 * actually considered — so a day scored with 4 Factors and a day scored with 8
 * land on the same 0–100 scale.
 */
export function attainableRangeFor(weights: readonly number[]): AttainableRange {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return { min: -2 * total, max: 2 * total };
}

/**
 * `round((raw − min) / (max − min) × 100)`.
 *
 * When `min === max` there is no scale to map onto; this returns **0**, on the
 * grounds that nothing scored earned nothing. See the module header —
 * `evaluate` gates that case to `insufficient_data` before it can surface.
 */
export function normalize(raw: number, range: AttainableRange): number {
  const span = range.max - range.min;
  if (span === 0) return 0;
  return Math.round(((raw - range.min) / span) * 100);
}

/* -------------------------------------------------------------------------- */
/* Verdict (§3.3)                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Map a normalized Suitability score to a Verdict.
 *
 * `value === null`, or `requiredMissing === true`, yields `insufficient_data`
 * with a `null` score — a required Factor absent beats any arithmetic. Vetoes
 * are applied elsewhere (§5), so `unfavorable` here means only "below 40".
 */
export function verdictFor(value: number | null, requiredMissing = false): Verdict {
  if (value === null || requiredMissing) return 'insufficient_data';
  if (value >= FAVORABLE_THRESHOLD) return 'favorable';
  if (value >= MIXED_THRESHOLD) return 'mixed';
  return 'unfavorable';
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Score one window: Band every Factor, sum Contributions, normalize over the
 * attainable range for this exact Factor set, and name the Verdict.
 *
 * Never substitutes a value, never scores missing data as 0, and never fires a
 * Veto — this is Stage 1 and Stage 2 only.
 */
export function evaluate(input: EvaluationInput): Evaluation {
  const { activity, skillLevel, values } = input;
  const required = REQUIRED_FACTORS[activity];
  const scored = new Set<Factor>(ACTIVITY_FACTORS[activity]);

  const rows: FactorDetail[] = [];
  const consideredWeights: number[] = [];
  const missingRequired: Factor[] = [];
  let raw = 0;

  for (const factor of FACTORS) {
    // Only Factors this Activity scores appear in the response; a Factor the
    // caller passed that §4.1 leaves as an em-dash is not ours to explain.
    if (!scored.has(factor)) continue;

    const meta = FACTOR_META[factor];
    const requiredFlag = required.includes(factor);
    const tableWeight = weightFor(factor, activity) ?? 0;
    const candidate = values[factor];
    const value = typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;

    if (value === null) {
      if (requiredFlag) missingRequired.push(factor);
      rows.push({
        factor,
        label: meta.label,
        unit: meta.unit,
        value: null,
        band: null,
        score: null,
        weight: tableWeight,
        contribution: null,
        required: requiredFlag,
        status: 'optional_missing',
      });
      continue;
    }

    const contribution = contributionFor(factor, value, activity, skillLevel);

    if (contribution === null) {
      // Present but unscored: no weight for this Activity, or no Band covers it.
      rows.push({
        factor,
        label: meta.label,
        unit: meta.unit,
        value,
        band: null,
        score: null,
        weight: tableWeight,
        contribution: null,
        required: requiredFlag,
        status: 'context_only',
      });
      continue;
    }

    consideredWeights.push(contribution.weight);
    raw += contribution.contribution;
    rows.push({
      factor,
      label: meta.label,
      unit: meta.unit,
      value,
      band: contribution.band.label,
      score: contribution.score,
      weight: contribution.weight,
      contribution: contribution.contribution,
      required: requiredFlag,
      status: 'scored',
    });
  }

  const range = attainableRangeFor(consideredWeights);
  const gateFailed = missingRequired.length > 0 || consideredWeights.length === 0;

  if (gateFailed) {
    return { verdict: 'insufficient_data', score: null, factors: rows, missingRequired };
  }

  const value = normalize(raw, range);
  const score: ScoreBlock = {
    value,
    raw,
    attainableRange: range,
    thresholds: { favorable: FAVORABLE_THRESHOLD, mixed: MIXED_THRESHOLD },
  };

  return { verdict: verdictFor(value), score, factors: rows, missingRequired: [] };
}
