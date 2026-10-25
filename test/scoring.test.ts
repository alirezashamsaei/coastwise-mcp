import { describe, expect, it } from 'vitest';
import type { Factor } from '../src/bands.js';
import { WAVE_HEIGHT_CEILING, factorsFor, isRequired, weightFor } from '../src/bands.js';
import type { FactorValues } from '../src/scoring.js';
import { bandFor, contributionFor, evaluate, normalize, verdictFor } from '../src/scoring.js';
import type { Activity, SkillLevel } from '../src/types.js';

/* -------------------------------------------------------------------------- */
/* §4.1 — every weight, transcribed independently of the implementation        */
/* -------------------------------------------------------------------------- */

/** docs/spec.md §4.1 written out by hand: `—` becomes `null`. */
const SPEC_WEIGHTS: Record<Activity, Record<Factor, number | null>> = {
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
};

/** docs/spec.md §6 required-Factor sets. */
const SPEC_REQUIRED: Record<Activity, Factor[]> = {
  beach_day: ['temperature_2m', 'weather_code', 'precipitation', 'wind_speed_10m'],
  surfing: ['wave_height', 'wave_period', 'wind_speed_10m', 'temperature_2m', 'precipitation'],
};

describe('weights (spec §4.1)', () => {
  for (const activity of ['beach_day', 'surfing'] as const) {
    it(`applies every ${activity} weight as specified`, () => {
      for (const [factor, expected] of Object.entries(SPEC_WEIGHTS[activity])) {
        expect(weightFor(factor as Factor, activity), factor).toBe(expected);
      }
    });
  }

  it('scores contribution = band score × weight', () => {
    // temperature 28 °C → 26–32 band (+2), beach_day weight 4 → +8.
    expect(contributionFor('temperature_2m', 28, 'beach_day')).toMatchObject({
      score: 2,
      weight: 4,
      contribution: 8,
    });
    // wave height 0.6 m → 0.3–0.7 band (+1), surfing weight 4 → +4.
    expect(contributionFor('wave_height', 0.6, 'surfing', 'intermediate')).toMatchObject({
      score: 1,
      weight: 4,
      contribution: 4,
    });
    // UV 9 → 8–10 band (+1), beach_day weight 2 → +2.
    expect(contributionFor('uv_index', 9, 'beach_day')).toMatchObject({
      score: 1,
      weight: 2,
      contribution: 2,
    });
    // Wind gusts 45 → 40–55 band (−1), weight 1 → −1.
    expect(contributionFor('wind_gusts_10m', 45, 'beach_day')).toMatchObject({
      score: -1,
      weight: 1,
      contribution: -1,
    });
  });

  it('refuses to score a Factor the Activity does not weight', () => {
    expect(contributionFor('wave_period', 10, 'beach_day')).toBeNull();
    expect(contributionFor('uv_index', 4, 'surfing')).toBeNull();
    expect(contributionFor('swell_wave_height', 1, 'beach_day')).toBeNull();
  });
});

describe('required-Factor sets (spec §6)', () => {
  for (const activity of ['beach_day', 'surfing'] as const) {
    it(`marks exactly the ${activity} required Factors`, () => {
      for (const factor of SPEC_REQUIRED[activity]) {
        expect(isRequired(factor, activity), factor).toBe(true);
      }
    });
  }

  it('does not require weather_code for surfing, per §6', () => {
    // §4.1 marks it required "both" but §6's surfing row omits it; §6 wins.
    expect(isRequired('weather_code', 'beach_day')).toBe(true);
    expect(isRequired('weather_code', 'surfing')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Band boundaries — inclusive low, exclusive high                            */
/* -------------------------------------------------------------------------- */

describe('band boundaries (spec §4)', () => {
  it('gives a value exactly on a boundary the upper band', () => {
    expect(bandFor('temperature_2m', 14, 'beach_day')?.label).toBe('14–18 °C');
    expect(bandFor('temperature_2m', 18, 'beach_day')?.score).toBe(0);
    expect(bandFor('temperature_2m', 26, 'beach_day')?.score).toBe(2);
    expect(bandFor('temperature_2m', 35, 'beach_day')?.score).toBe(0);
    expect(bandFor('wind_speed_10m', 12, 'beach_day')?.score).toBe(1);
    expect(bandFor('wind_speed_10m', 40, 'beach_day')?.score).toBe(-2);
    expect(bandFor('wind_gusts_10m', 55, 'beach_day')?.score).toBe(-2);
    expect(bandFor('uv_index', 11, 'beach_day')?.score).toBe(0);
  });

  it('gives a value just below a boundary the lower band', () => {
    expect(bandFor('temperature_2m', 13.999, 'beach_day')?.score).toBe(-2);
    expect(bandFor('temperature_2m', 17.999, 'beach_day')?.score).toBe(-1);
    expect(bandFor('temperature_2m', 25.999, 'beach_day')?.score).toBe(1);
    expect(bandFor('temperature_2m', 34.999, 'beach_day')?.score).toBe(1);
    expect(bandFor('wind_speed_10m', 11.999, 'beach_day')?.score).toBe(2);
    expect(bandFor('wind_speed_10m', 39.999, 'beach_day')?.score).toBe(-1);
  });

  it('uses exclusive-high for precipitation rows, per the §4 header', () => {
    // §4.4 writes `(0, 0.5]`, contradicting the inclusive-low/exclusive-high
    // header. The header wins: 0.5 lands in 0.5–2.
    expect(bandFor('precipitation', 0, 'beach_day')?.score).toBe(2);
    expect(bandFor('precipitation', 0.001, 'beach_day')?.score).toBe(1);
    expect(bandFor('precipitation', 0.5, 'beach_day')?.score).toBe(0);
    expect(bandFor('precipitation', 2, 'beach_day')?.score).toBe(-1);
    expect(bandFor('precipitation', 10, 'beach_day')?.score).toBe(-2);
    expect(bandFor('precipitation', 0.4999, 'beach_day')?.score).toBe(1);
  });

  it('matches discrete WMO codes exactly, one band each', () => {
    expect(bandFor('weather_code', 0, 'beach_day')?.score).toBe(2);
    expect(bandFor('weather_code', 2, 'beach_day')?.score).toBe(1);
    expect(bandFor('weather_code', 3, 'beach_day')?.score).toBe(0);
    expect(bandFor('weather_code', 45, 'beach_day')?.score).toBe(-1);
    expect(bandFor('weather_code', 61, 'beach_day')?.score).toBe(0);
    expect(bandFor('weather_code', 80, 'beach_day')?.score).toBe(0);
    // §4.3 VETO rows are transcribed at the table floor; vetoes.ts applies §5.
    expect(bandFor('weather_code', 71, 'beach_day')?.score).toBe(-2);
    expect(bandFor('weather_code', 95, 'beach_day')?.score).toBe(-2);
    expect(bandFor('weather_code', 99, 'beach_day')?.score).toBe(-2);
  });

  it('returns null rather than inventing a Band for an uncovered value', () => {
    // Continuous tables are total by design, so the only gaps left are
    // categorical: an unrecognised WMO code has no Band and no score.
    expect(bandFor('weather_code', 4, 'beach_day')).toBeNull();
    expect(bandFor('weather_code', 999, 'surfing')).toBeNull();
  });

  it('refuses to band surfing wave height without a skill level', () => {
    expect(bandFor('wave_height', 1, 'surfing')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* §4.8 — wave height is per Skill level                                       */
/* -------------------------------------------------------------------------- */

describe('wave-height tables differ by skill level (spec §4.8)', () => {
  it('treats 0.8 m as excellent for a beginner and poor for an advanced surfer', () => {
    expect(bandFor('wave_height', 0.8, 'surfing', 'beginner')?.score).toBe(2);
    expect(bandFor('wave_height', 0.8, 'surfing', 'intermediate')?.score).toBe(1);
    expect(bandFor('wave_height', 0.8, 'surfing', 'advanced')?.score).toBe(0);
  });

  it('splits the three tables on their shared 1.0 m boundary', () => {
    // Exclusive-high puts 1.0 in 1.0–1.3 for every level.
    expect(bandFor('wave_height', 1.0, 'surfing', 'beginner')?.score).toBe(0);
    expect(bandFor('wave_height', 1.0, 'surfing', 'intermediate')?.score).toBe(1);
    expect(bandFor('wave_height', 1.0, 'surfing', 'advanced')?.score).toBe(0);
    // Just under it, beginner's peak band applies.
    expect(bandFor('wave_height', 0.99, 'surfing', 'beginner')?.score).toBe(2);
  });

  it('peaks each curve where the spec says it does', () => {
    expect(bandFor('wave_height', 0.7, 'surfing', 'beginner')?.score).toBe(2);
    expect(bandFor('wave_height', 1.6, 'surfing', 'intermediate')?.score).toBe(2);
    expect(bandFor('wave_height', 3.0, 'surfing', 'advanced')?.score).toBe(2);
    // Flat water scores badly for everyone.
    expect(bandFor('wave_height', 0.2, 'surfing', 'beginner')?.score).toBe(-2);
    expect(bandFor('wave_height', 0.2, 'surfing', 'advanced')?.score).toBe(-2);
  });

  it('reverses the curve for beach_day, where smaller is calmer', () => {
    expect(bandFor('wave_height', 0.2, 'beach_day')?.score).toBe(2);
    expect(bandFor('wave_height', 3.0, 'beach_day')?.score).toBe(-2);
  });

  it('publishes the §5 veto ceilings', () => {
    expect(WAVE_HEIGHT_CEILING).toEqual({ beginner: 1.5, intermediate: 2.5, advanced: 4.0 });
  });
});

/* -------------------------------------------------------------------------- */
/* Normalization (spec §3.2)                                                   */
/* -------------------------------------------------------------------------- */

/** Every required Factor at its best band. */
const BEST_REQUIRED: FactorValues = {
  temperature_2m: 28, // 26–32 → +2
  weather_code: 0, // clear → +2
  precipitation: 0, // → +2
  wind_speed_10m: 5, // < 12 → +2
};

/** Every required Factor at its worst reachable band. */
const WORST_REQUIRED: FactorValues = {
  temperature_2m: 10, // < 14 → −2
  weather_code: 95, // thunderstorm → −2 (floor of §4.3's VETO row)
  precipitation: 11, // > 10 → −2
  wind_speed_10m: 45, // > 40 → −2
};

/** The required beach_day Factors, used as the base for optional-Factor cases. */
const base: FactorValues = BEST_REQUIRED;


describe('normalization (spec §3.2)', () => {
  it('gives a full-best day 100', () => {
    const result = evaluate({ activity: 'beach_day', values: BEST_REQUIRED });
    expect(result.verdict).toBe('favorable');
    expect(result.score).toMatchObject({
      value: 100,
      raw: 28,
      attainableRange: { min: -28, max: 28 },
      thresholds: { favorable: 70, mixed: 40 },
    });
  });

  it('gives a full-worst day 0', () => {
    const result = evaluate({ activity: 'beach_day', values: WORST_REQUIRED });
    expect(result.verdict).toBe('unfavorable');
    expect(result.score).toMatchObject({
      value: 0,
      raw: -28,
      attainableRange: { min: -28, max: 28 },
    });
  });

  it('lands differently-sized Factor sets on the same 0–100 scale', () => {
    const small = evaluate({ activity: 'beach_day', values: BEST_REQUIRED });
    const large = evaluate({
      activity: 'beach_day',
      values: {
        ...BEST_REQUIRED,
        wave_height: 1.5,
        uv_index: 1,
        wind_gusts_10m: 60,
        sea_surface_temperature: 10,
      },
    });

    for (const result of [small, large]) {
      expect(result.score?.value).toBeGreaterThanOrEqual(0);
      expect(result.score?.value).toBeLessThanOrEqual(100);
    }
    // Different Factor-set sizes must not produce the same attainable range.
    expect(small.score?.attainableRange).toEqual({ min: -28, max: 28 });
    expect(large.score?.attainableRange).toEqual({ min: -38, max: 38 });
  });

  it('keeps a mid-range day mid-range under either Factor-set size', () => {
    const mid = evaluate({
      activity: 'beach_day',
      values: { ...BEST_REQUIRED, wave_height: 0.9, uv_index: 1, wind_gusts_10m: 45 },
    });
    expect(mid.score?.value).toBeGreaterThan(0);
    expect(mid.score?.value).toBeLessThan(100);
    expect(mid.verdict).toBe('favorable');
  });

  it('returns 0 for the degenerate empty scale rather than NaN', () => {
    // min === max: no span to divide by. Documented choice in scoring.ts.
    expect(normalize(0, { min: 0, max: 0 })).toBe(0);
    expect(normalize(7, { min: 0, max: 0 })).toBe(0);
    expect(Number.isNaN(normalize(0, { min: 0, max: 0 }))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Verdict thresholds (spec §3.3)                                              */
/* -------------------------------------------------------------------------- */

describe('verdict thresholds (spec §3.3)', () => {
  it('crosses favorable at 70', () => {
    expect(verdictFor(69)).toBe('mixed');
    expect(verdictFor(70)).toBe('favorable');
    expect(verdictFor(100)).toBe('favorable');
  });

  it('crosses mixed at 40', () => {
    expect(verdictFor(39)).toBe('unfavorable');
    expect(verdictFor(40)).toBe('mixed');
    expect(verdictFor(69)).toBe('mixed');
  });

  it('prefers insufficient_data over any numeric verdict', () => {
    expect(verdictFor(100, true)).toBe('insufficient_data');
    expect(verdictFor(null)).toBe('insufficient_data');
    expect(verdictFor(null, true)).toBe('insufficient_data');
  });

  it('reports thresholds from a real evaluation', () => {
    const result = evaluate({ activity: 'beach_day', values: BEST_REQUIRED });
    expect(result.score?.thresholds).toEqual({ favorable: 70, mixed: 40 });
    expect(result.verdict).toBe('favorable');
  });
});

/* -------------------------------------------------------------------------- */
/* Missing data (spec §3.3, §6)                                                */
/* -------------------------------------------------------------------------- */

describe('missing required Factors (spec §6)', () => {
  it('yields insufficient_data with a null score', () => {
    const { temperature_2m: _temperature, ...withoutTemperature } = BEST_REQUIRED;
    const result = evaluate({ activity: 'beach_day', values: withoutTemperature });

    expect(result.verdict).toBe('insufficient_data');
    expect(result.score).toBeNull();
    expect(result.missingRequired).toEqual(['temperature_2m']);

    const row = result.factors.find((f) => f.factor === 'temperature_2m');
    expect(row).toMatchObject({ value: null, required: true, status: 'optional_missing' });
    expect(row?.contribution).toBeNull();
  });

  it('gates surfing on its marine Factors', () => {
    const result = evaluate({
      activity: 'surfing',
      skillLevel: 'beginner',
      values: { temperature_2m: 22, precipitation: 0, wind_speed_10m: 15 },
    });

    expect(result.verdict).toBe('insufficient_data');
    expect(result.score).toBeNull();
    expect(result.missingRequired.sort()).toEqual(['wave_height', 'wave_period']);
  });

  it('refuses to score when no Factor has a value at all', () => {
    const result = evaluate({ activity: 'beach_day', values: {} });
    expect(result.verdict).toBe('insufficient_data');
    expect(result.score).toBeNull();
  });

  it('never scores missing data as 0', () => {
    const values: FactorValues = { ...BEST_REQUIRED };
    delete values.temperature_2m;
    const result = evaluate({ activity: 'beach_day', values });
    const row = result.factors.find((f) => f.factor === 'temperature_2m');
    expect(row?.score).toBeNull();
    expect(row?.contribution).toBeNull();
    expect(row?.band).toBeNull();
    expect(row?.value).toBeNull();
  });

  it('requires every §6 Factor for beach_day', () => {
    for (const factor of SPEC_REQUIRED.beach_day) {
      const values = { ...BEST_REQUIRED };
      delete values[factor];
      const result = evaluate({ activity: 'beach_day', values });
      expect(result.verdict, factor).toBe('insufficient_data');
      expect(result.missingRequired, factor).toContain(factor);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Optional Factors (spec §3.1)                                                */
/* -------------------------------------------------------------------------- */

describe('optional Factors (spec §3.1)', () => {
  it('skips an optional Factor that is null, exactly as if omitted', () => {
    const omitted = evaluate({ activity: 'beach_day', values: { ...base } });
    const nulled = evaluate({ activity: 'beach_day', values: { ...base, uv_index: null } });

    expect(nulled.score?.attainableRange).toEqual(omitted.score?.attainableRange);
    expect(nulled.score?.value).toBe(omitted.score?.value);
    expect(nulled.score?.raw).toBe(omitted.score?.raw);
    expect(nulled.verdict).toBe(omitted.verdict);
  });

  it('does not widen the attainable range for a null optional Factor', () => {
    const nulled = evaluate({
      activity: 'beach_day',
      values: { ...base, uv_index: null, sea_surface_temperature: null, wind_gusts_10m: null },
    });
    expect(nulled.score?.attainableRange).toEqual({ min: -28, max: 28 });
  });

  it('does widen the attainable range when the optional Factor has a value', () => {
    const withUv = evaluate({ activity: 'beach_day', values: { ...base, uv_index: 4 } });
    // uv_index weight 2 → ±4 on top of ±28.
    expect(withUv.score?.attainableRange).toEqual({ min: -32, max: 32 });
    expect(withUv.score?.value).not.toBe(evaluate({ activity: 'beach_day', values: base }).score?.value);
  });

  it('reports a null optional Factor as optional_missing without gating', () => {
    const result = evaluate({ activity: 'beach_day', values: { ...base, uv_index: null } });
    const row = result.factors.find((f) => f.factor === 'uv_index');

    expect(row).toMatchObject({ value: null, required: false, status: 'optional_missing' });
    expect(result.verdict).toBe('favorable');
    expect(result.missingRequired).toEqual([]);
  });

  it('reports an unbandable value as context_only, not scored', () => {
    // Continuous tables are total, so the unbandable case only arises for a
    // categorical Factor carrying a code the table does not know.
    const result = evaluate({
      activity: 'surfing',
      skillLevel: 'beginner',
      values: {
        temperature_2m: 22,
        precipitation: 0,
        wind_speed_10m: 15,
        wave_height: 1.9,
        wave_period: 10,
        weather_code: 999,
        sea_surface_temperature: 20,
      },
    });

    const row = result.factors.find((f) => f.factor === 'weather_code');
    expect(row).toMatchObject({
      value: 999,
      band: null,
      score: null,
      contribution: null,
      status: 'context_only',
    });
    // A Factor that could not be banded is still present, so the required
    // gate does not fire — it simply contributes nothing.
    expect(result.verdict).not.toBe('insufficient_data');
    expect(result.score).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* FactorDetail rows and Factor lists                                          */
/* -------------------------------------------------------------------------- */

describe('FactorDetail rows', () => {
  it('reports unit, band, score, weight, contribution and required flag', () => {
    const result = evaluate({ activity: 'beach_day', values: { ...BEST_REQUIRED, uv_index: 4 } });
    const row = result.factors.find((f) => f.factor === 'temperature_2m');

    expect(row).toEqual({
      factor: 'temperature_2m',
      label: 'Air temperature',
      unit: '°C',
      value: 28,
      band: '26–32 °C',
      score: 2,
      weight: 4,
      contribution: 8,
      required: true,
      status: 'scored',
    });
  });

  it('lists a row for every Factor the Activity scores', () => {
    const beach = evaluate({ activity: 'beach_day', values: base });
    expect(beach.factors.map((f) => f.factor)).toEqual(factorsFor('beach_day'));

    const surf = evaluate({ activity: 'surfing', skillLevel: 'advanced', values: {} });
    expect(surf.factors.map((f) => f.factor)).toEqual(factorsFor('surfing'));
  });

  it('never reports a Factor the Activity does not consider', () => {
    const result = evaluate({
      activity: 'surfing',
      skillLevel: 'beginner',
      values: { ...BEST_REQUIRED, wave_height: 0.8, wave_period: 11, uv_index: 5 },
    });
    expect(result.factors.map((f) => f.factor)).not.toContain('uv_index');
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism                                                                 */
/* -------------------------------------------------------------------------- */

describe('determinism', () => {
  const inputs = [
    { activity: 'beach_day', values: BEST_REQUIRED },
    { activity: 'beach_day', values: { ...BEST_REQUIRED, uv_index: null } },
    { activity: 'surfing', skillLevel: 'intermediate', values: { ...BEST_REQUIRED, wave_height: 1.4, wave_period: 8 } },
  ] as const;

  it('produces identical output for identical input', () => {
    for (const input of inputs) {
      const first = evaluate({ ...input, values: { ...input.values } });
      const second = evaluate({ ...input, values: { ...input.values } });
      expect(second).toEqual(first);
    }
  });

  it('scores surfing wave height at every skill level', () => {
    const levels: SkillLevel[] = ['beginner', 'intermediate', 'advanced'];
    const scores = levels.map(
      (level) => bandFor('wave_height', 0.8, 'surfing', level)?.score,
    );
    expect(scores).toEqual([2, 1, 0]);
  });
});

/* -------------------------------------------------------------------------- */
/* Totality: no Band table may leave a value unbandable                       */
/* -------------------------------------------------------------------------- */

describe('Band tables are total', () => {
  const factors: Factor[] = [
    'temperature_2m',
    'weather_code',
    'precipitation',
    'wind_speed_10m',
    'uv_index',
    'wind_gusts_10m',
    'wave_height',
    'wave_period',
    'swell_wave_height',
    'swell_wave_period',
    'sea_surface_temperature',
  ];

  // A present-but-unbandable value scores no Contribution while still
  // satisfying the required-Factor gate, so a gap would let an obviously
  // unsuitable day score normally. Every table must cover the number line.
  it('covers every value from zero to well above any table', () => {
    const probes = [0, 0.01, 0.29, 0.3, 0.49, 0.5, 1.49, 1.5, 1.79, 1.8, 2.1, 2.49, 2.5, 3.19, 3.2, 3.99, 4.0, 4.5, 6.5, 10, 40, 100, 1000];
    // weather_code is categorical — an unknown code has no Band by design.
    // Precipitation legitimately starts at zero: a negative value is not a
    // gap in the table but a physically impossible input.
    const continuous = factors.filter((f) => f !== 'weather_code');

    for (const factor of continuous) {
      for (const activity of ['beach_day', 'surfing'] as const) {
        if (factor === 'wave_height') continue; // covered separately per skill level
        if (weightFor(factor, activity) === null) continue;
        for (const value of probes) {
          expect(
            bandFor(factor, value, activity),
            `${factor} @ ${value} (${activity})`,
          ).not.toBeNull();
        }
      }
    }
  });

  it('bands negative temperatures — the one Factor whose scale crosses zero', () => {
    for (const value of [-40, -10, -0.01, 0]) {
      expect(bandFor('temperature_2m', value, 'beach_day'), String(value)).not.toBeNull();
      expect(bandFor('temperature_2m', value, 'surfing'), String(value)).not.toBeNull();
    }
  });

  it('covers every value at every surfing skill level', () => {
    const probes = [-1, 0, 0.3, 0.35, 0.4, 0.5, 1.0, 1.3, 1.49, 1.5, 1.8, 2.0, 2.1, 2.49, 2.5, 3.0, 3.19, 3.2, 4.0, 4.01, 5, 12];
    const levels: SkillLevel[] = ['beginner', 'intermediate', 'advanced'];

    for (const level of levels) {
      for (const value of probes) {
        expect(bandFor('wave_height', value, 'surfing', level), `${level} @ ${value} m`).not.toBeNull();
      }
    }
  });

  it('keeps every surfing table monotonic downward past its ceiling', () => {
    // Once a value exceeds the ceiling the curve must already sit at its
    // floor, so the band and the veto agree about what the day is worth.
    const levels: SkillLevel[] = ['beginner', 'intermediate', 'advanced'];
    for (const level of levels) {
      const above = bandFor('wave_height', WAVE_HEIGHT_CEILING[level] + 0.6, 'surfing', level);
      expect(above?.score, level).toBe(-2);
    }
  });

  it('bands the advanced 0.3–0.4 m value the spec left as an em-dash', () => {
    expect(bandFor('wave_height', 0.35, 'surfing', 'advanced')?.score).toBe(-2);
  });
});
