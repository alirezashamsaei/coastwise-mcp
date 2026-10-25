/**
 * `find_best_activity_window` — the sliding 3-hour search (docs/spec.md §2.4).
 *
 * The search slides a fixed 3-hour block across the requested window at hourly
 * stride and scores each block by the mean suitability of its hours, reusing
 * the very evaluation `rate_activity_conditions` runs for that block. The two
 * tools therefore agree verdict-for-verdict, vetoes included: a Veto is applied
 * per hour inside `evaluateWindow`, so a stormy block is `unfavorable` here as
 * well.
 *
 * ## What counts, and what does not
 *
 * - **A candidate is 3 consecutive hours that all carry every required Factor**
 *   (§2.4). A gap disqualifies the blocks that span it — it never stitches the
 *   hours either side together — and a disqualified block is not a candidate:
 *   its hours are reported in `skippedHours` with the reason instead.
 * - **`best` is the highest-scoring candidate**, ties resolved to the earliest
 *   (§2.4 / issue #13). It is simply the top entry of `candidates`, so the two
 *   can never disagree. A vetoed block keeps its score and its `unfavorable`
 *   verdict in the list like any other — the Veto reports the score rather than
 *   hiding it (§3.3).
 * - **Nothing qualifying → `best: null` with a human-readable `reason`**, never
 *   an empty object (§2.4).
 *
 * Block starts come from the search bounds, not from the forecast: the block
 * that would start at 12:00 is still considered when the forecast has no 12:00
 * hour, and that absence is reported. Bounds are snapped to the forecast's
 * hourly grid, because a `09:30` window can only ever match whole-hour
 * readings — `slotsIn` floors to `:00`, so `slotsIn` and `blocksIn` always walk
 * the same grid.
 *
 * Pure and deterministic: no clock, no network, no I/O.
 */

import { LIMITATIONS, WINDOW_HOURS, WINDOW_STRIDE_HOURS } from './constants.js';
import { REQUIRED_FACTORS } from './bands.js';
import type { Factor } from './bands.js';
import { evaluateWindow, hoursInRange, resolveWindow } from './evaluate.js';
import type {
  Activity,
  BestWindowResponse,
  HourReading,
  LocationInfo,
  SkillLevel,
  Verdict,
} from './types.js';

export interface FindWindowInput {
  activity: Activity;
  skillLevel?: SkillLevel;
  /** `YYYY-MM-DD` of the search, used to stamp candidate times. */
  date: string;
  /** The full merged hourly series for that date, unfiltered. */
  hours: HourReading[];
  location: LocationInfo;
  /** Search bounds; omitted applies the default daylight block. */
  requestedWindow?: { start: string; end: string };
}

/**
 * A qualifying block: three complete hours and a score. `score` is `number`
 * here, not `number | null` as in `BestWindowResponse['candidates']`, because
 * §2.4 defines a candidate as a block that *did* evaluate — a block that fails
 * the required-Factor gate never reaches this list.
 */
interface Candidate {
  start: string;
  end: string;
  score: number;
  verdict: Verdict;
}

interface Block {
  /** `HH:MM` of the block's first hour. */
  start: string;
  /** `HH:MM` of the block's last hourly slot (3 slots inclusive). */
  end: string;
  /** The block's three hourly slots, in order. */
  clocks: string[];
}

/** `HH:MM` → minutes past midnight. */
function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** Minutes past midnight → `HH:MM`. */
function toTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Beach-local `HH:MM` of an hour reading, e.g. `2026-10-27T09:00` → `09:00`. */
function clockOf(hour: HourReading): string {
  return hour.time.slice(11, 16);
}

/**
 * Every whole-hour slot inside the search bounds, chronologically.
 *
 * A bound like `09:30` cannot match a forecast reading (they are hourly, on
 * the hour), so the first slot rounds *up* and the last rounds *down* — the
 * grid the blocks slide along is never finer than the data.
 */
function slotsIn(start: string, end: string): string[] {
  const first = Math.ceil(toMinutes(start) / 60) * 60;
  const last = Math.floor(toMinutes(end) / 60) * 60;
  const slots: string[] = [];
  for (let m = first; m <= last; m += 60) slots.push(toTime(m));
  return slots;
}

/** Every fixed-length block that fits the slots, at the configured stride. */
function blocksIn(slots: string[]): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i + WINDOW_HOURS <= slots.length; i += WINDOW_STRIDE_HOURS) {
    const start = slots[i];
    const end = slots[i + WINDOW_HOURS - 1];
    if (start === undefined || end === undefined) break;
    blocks.push({ start, end, clocks: slots.slice(i, i + WINDOW_HOURS) });
  }
  return blocks;
}

/** Required Factors with no usable value in this hour, in spec order. */
function missingRequiredIn(activity: Activity, reading: HourReading | undefined): Factor[] {
  if (!reading) return [];
  return REQUIRED_FACTORS[activity].filter((factor) => {
    const value = reading.values[factor];
    return typeof value !== 'number' || !Number.isFinite(value);
  });
}

/** Score descending, then earliest start — the order §2.4 asks candidates in. */
function byScoreThenStart(a: Candidate, b: Candidate): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
}

/**
 * Slide the 3-hour block across the search bounds and name the most suitable
 * stretch — or say plainly that no such stretch exists.
 */
export function findBestWindow(input: FindWindowInput): BestWindowResponse {
  const { activity, skillLevel, date, hours, location, requestedWindow } = input;
  const win = resolveWindow(requestedWindow);

  const byClock = new Map<string, HourReading>();
  for (const hour of hoursInRange(hours, win.start, win.end)) {
    byClock.set(clockOf(hour), hour);
  }

  const slots = slotsIn(win.start, win.end);
  const blocks = blocksIn(slots);
  const required = REQUIRED_FACTORS[activity];

  /** Why an hour produced no usable evidence, keyed by `HH:MM`. */
  const reasons = new Map<string, string>();
  for (const clock of slots) {
    const reading = byClock.get(clock);
    if (!reading) {
      reasons.set(clock, 'the forecast returned no hour for this time');
      continue;
    }
    const missing = missingRequiredIn(activity, reading);
    if (missing.length > 0) reasons.set(clock, `missing required factor(s): ${missing.join(', ')}`);
  }

  const candidates: Candidate[] = [];
  /** Hours that took part in at least one qualifying block. */
  const evaluated = new Set<string>();

  for (const block of blocks) {
    const blockHours = block.clocks
      .map((clock) => byClock.get(clock))
      .filter((reading): reading is HourReading => reading !== undefined);

    const qualifies =
      blockHours.length === WINDOW_HOURS &&
      block.clocks.every((clock) => missingRequiredIn(activity, byClock.get(clock)).length === 0);

    if (!qualifies) continue;

    // The identical call `rate_activity_conditions` makes for this block, so
    // the verdict — veto included — cannot disagree between the two tools.
    const rating = evaluateWindow({
      activity,
      skillLevel,
      hours: blockHours,
      location,
      requestedWindow: { start: block.start, end: block.end },
      missing: [],
    });

    if (rating.score === null) continue; // §3.3: a gate failure is not a candidate
    const { value: score } = rating.score;

    for (const clock of block.clocks) evaluated.add(clock);
    candidates.push({
      start: `${date}T${block.start}`,
      end: `${date}T${block.end}`,
      score,
      verdict: rating.verdict,
    });
  }

  candidates.sort(byScoreThenStart);

  for (const clock of slots) {
    if (evaluated.has(clock)) reasons.delete(clock);
    else if (!reasons.has(clock)) {
      reasons.set(
        clock,
        blocks.length === 0
          ? `the search bounds are shorter than the ${WINDOW_HOURS}-hour block`
          : `no complete ${WINDOW_HOURS}-hour block containing this hour could be scored`,
      );
    }
  }

  const inRange = hoursInRange(hours, win.start, win.end).length;
  // §2.4: best is the top candidate; ties were already broken to the earliest.
  const top: Candidate | null = candidates[0] ?? null;

  const skippedHours = slots
    .filter((clock) => reasons.has(clock))
    .map((clock) => ({ time: `${date}T${clock}`, reason: reasons.get(clock)! }));

  return {
    searched: { start: win.start, end: win.end, timezone: location.timezone },
    windowHours: WINDOW_HOURS,
    strideHours: WINDOW_STRIDE_HOURS,
    best: top,
    reason: top === null ? explainNoBest(win, inRange, blocks.length, skippedHours.length, activity, required) : null,
    candidates,
    evaluatedHours: evaluated.size,
    skippedHours,
    limitations: [...LIMITATIONS],
  };
}

/** Why no block won, in a sentence a person can act on. */
function explainNoBest(
  win: { start: string; end: string },
  inRangeHours: number,
  blockCount: number,
  skipped: number,
  activity: Activity,
  required: readonly Factor[],
): string {
  if (inRangeHours === 0) {
    return `The forecast returned no hours for the searched window ${win.start}-${win.end}.`;
  }
  if (blockCount === 0) {
    return (
      `No ${WINDOW_HOURS}-hour block fits inside the searched window ${win.start}-${win.end}: ` +
      `the search bounds are shorter than the block, so nothing was evaluated.`
    );
  }
  if (skipped === 0) {
    return `No block inside ${win.start}-${win.end} produced a score.`;
  }
  return (
    `No ${WINDOW_HOURS}-hour stretch inside ${win.start}-${win.end} has every required ` +
    `${activity} factor (${required.join(', ')}) in all three hours; ` +
    `${skipped} hour(s) could not be evaluated.`
  );
}
