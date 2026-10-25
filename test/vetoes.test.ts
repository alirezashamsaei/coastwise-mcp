import { describe, expect, it } from 'vitest';
import { WAVE_CEILING_M, evaluateVeto } from '../src/vetoes.js';

const clear = { activity: 'beach_day', weatherCode: 0, waveHeight: 0.5 } as const;
const SCORE = 81;

describe('thunderstorm veto', () => {
  it.each([95, 96, 99])('fires on WMO %i for both activities', (code) => {
    for (const activity of ['beach_day', 'surfing'] as const) {
      const { veto } = evaluateVeto({ activity, skillLevel: 'beginner', weatherCode: code, waveHeight: 0.5 }, SCORE);
      expect(veto?.id).toBe('thunderstorm');
      expect(veto?.value).toBe(code);
      expect(veto?.reason).toMatch(/thunderstorm/i);
    }
  });

  it('reports the score it overrode', () => {
    const { veto } = evaluateVeto({ ...clear, weatherCode: 99 }, SCORE);
    expect(veto?.overriddenScore).toBe(SCORE);
  });

  it('does not fire on non-thunderstorm codes', () => {
    for (const code of [0, 1, 2, 3, 45, 61, 80]) {
      expect(evaluateVeto({ ...clear, weatherCode: code }, SCORE).veto).toBeNull();
    }
  });
});

describe('frozen precipitation veto', () => {
  it.each([66, 67, 71, 73, 75, 77, 85, 86])('fires on WMO %i', (code) => {
    const { veto } = evaluateVeto({ ...clear, weatherCode: code }, SCORE);
    expect(veto?.id).toBe('frozen_precipitation');
    expect(veto?.value).toBe(code);
  });

  it('does not fire on liquid precipitation codes', () => {
    for (const code of [51, 55, 61, 65, 80, 82]) {
      expect(evaluateVeto({ ...clear, weatherCode: code }, SCORE).veto).toBeNull();
    }
  });
});

describe('wave ceiling veto', () => {
  it('fires above the beginner ceiling', () => {
    const { veto } = evaluateVeto(
      { activity: 'surfing', skillLevel: 'beginner', weatherCode: 1, waveHeight: 1.51 },
      SCORE,
    );
    expect(veto?.id).toBe('wave_above_skill_ceiling');
    expect(veto?.unit).toBe('m');
    expect(veto?.reason).toMatch(/beginner/);
    expect(veto?.reason).toMatch(/1\.5 m/);
  });

  it('is exact at the ceiling boundary', () => {
    expect(
      evaluateVeto(
        { activity: 'surfing', skillLevel: 'beginner', weatherCode: 1, waveHeight: 1.5 },
        SCORE,
      ).veto,
    ).toBeNull();

    expect(
      evaluateVeto(
        { activity: 'surfing', skillLevel: 'beginner', weatherCode: 1, waveHeight: 1.501 },
        SCORE,
      ).veto,
    ).not.toBeNull();
  });

  it('uses a different ceiling per skill level', () => {
    const cases = [
      { skillLevel: 'beginner', ceiling: 1.5 },
      { skillLevel: 'intermediate', ceiling: 2.5 },
      { skillLevel: 'advanced', ceiling: 4.0 },
    ] as const;

    for (const { skillLevel, ceiling } of cases) {
      expect(WAVE_CEILING_M[skillLevel]).toBe(ceiling);
      // Just above the ceiling fires.
      expect(
        evaluateVeto(
          { activity: 'surfing', skillLevel, weatherCode: 1, waveHeight: ceiling + 0.01 },
          SCORE,
        ).veto,
      ).not.toBeNull();
      // A wave good for a beginner is fine for everyone.
      expect(
        evaluateVeto(
          { activity: 'surfing', skillLevel, weatherCode: 1, waveHeight: 1.4 },
          SCORE,
        ).veto,
      ).toBeNull();
    }
  });

  it('never fires for beach_day, however big the waves', () => {
    expect(
      evaluateVeto(
        { activity: 'beach_day', weatherCode: 0, waveHeight: 9 },
        SCORE,
      ).veto,
    ).toBeNull();
  });
});

describe('missing evidence never vetoes', () => {
  it('does not veto on a null weather code', () => {
    expect(evaluateVeto({ ...clear, weatherCode: null }, SCORE).veto).toBeNull();
  });

  it('does not veto on a null wave height', () => {
    expect(
      evaluateVeto(
        { activity: 'surfing', skillLevel: 'beginner', weatherCode: 0, waveHeight: null },
        SCORE,
      ).veto,
    ).toBeNull();
  });

  it('does not veto on a missing skill level', () => {
    expect(
      evaluateVeto(
        { activity: 'surfing', weatherCode: 0, waveHeight: 8 },
        SCORE,
      ).veto,
    ).toBeNull();
  });

  it('does not veto when no score was produced either', () => {
    const { veto } = evaluateVeto({ ...clear, weatherCode: 95 }, null);
    expect(veto?.overriddenScore).toBeNull();
  });
});
