/**
 * Hard Vetoes — the three conditions that force `unfavorable` regardless of
 * how the Suitability score came out (docs/spec.md §5, ADR-0001).
 *
 * A Veto must always report the score it overrode; an unexplained override
 * looks arbitrary to whoever reads the response.
 *
 * Missing evidence never fires a Veto. Absence is reported under `missing`
 * and nowhere else — CoastWise does not infer conditions it never observed.
 */

import type { Activity, SkillLevel, VetoDetail } from './types.js';

/** WMO weather codes that disqualify both activities. */
const THUNDERSTORM_CODES = new Set([95, 96, 99]);
const FROZEN_PRECIP_CODES = new Set([66, 67, 71, 73, 75, 77, 85, 86]);

/**
 * Wave height above which no amount of good weather rescues a session.
 * The value itself fires; one hundredth below it does not.
 */
export const WAVE_CEILING_M: Record<SkillLevel, number> = {
  beginner: 1.5,
  intermediate: 2.5,
  advanced: 4.0,
};

export interface VetoInput {
  activity: Activity;
  skillLevel?: SkillLevel;
  /** A null value means we never observed it — a Veto cannot fire on that. */
  weatherCode: number | null;
  waveHeight: number | null;
}

/** The score the ordinary rules produced, which a Veto would override. */
export interface VetoOutcome {
  veto: VetoDetail | null;
}

export function evaluateVeto(input: VetoInput, overriddenScore: number | null): VetoOutcome {
  const { activity, skillLevel, weatherCode, waveHeight } = input;

  if (weatherCode !== null) {
    if (THUNDERSTORM_CODES.has(weatherCode)) {
      return {
        veto: {
          id: 'thunderstorm',
          factor: 'weather_code',
          value: weatherCode,
          unit: 'wmo code',
          reason: `Thunderstorm (WMO ${weatherCode}) disqualifies outdoor conditions.`,
          overriddenScore,
        },
      };
    }

    if (FROZEN_PRECIP_CODES.has(weatherCode)) {
      return {
        veto: {
          id: 'frozen_precipitation',
          factor: 'weather_code',
          value: weatherCode,
          unit: 'wmo code',
          reason: `Frozen precipitation (WMO ${weatherCode}) disqualifies outdoor conditions.`,
          overriddenScore,
        },
      };
    }
  }

  if (activity === 'surfing' && waveHeight !== null && skillLevel !== undefined) {
    const ceiling = WAVE_CEILING_M[skillLevel];
    if (waveHeight > ceiling) {
      return {
        veto: {
          id: 'wave_above_skill_ceiling',
          factor: 'wave_height',
          value: waveHeight,
          unit: 'm',
          reason: `Wave height ${waveHeight} m exceeds the ${skillLevel} ceiling of ${ceiling} m.`,
          overriddenScore,
        },
      };
    }
  }

  return { veto: null };
}
