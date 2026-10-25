/**
 * Tool registrations.
 *
 * Handlers stay thin: validate input, delegate to the fetch/scoring layers,
 * and assemble the response. Any InputError or ForecastError becomes an MCP
 * error result — never a verdict, because an upstream failure is not a
 * statement about the beach.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Fetcher } from './forecast.js';
import { ForecastError, InputError, collectMissing, fetchForecast } from './forecast.js';
import { MARINE_FACTORS, WEATHER_FACTORS } from './forecast.js';
import { LIMITATIONS } from './constants.js';
import {
  EvaluationInputError,
  evaluateWindow,
  hoursInRange,
  mergeHours,
  resolveSkillLevel,
  resolveWindow,
} from './evaluate.js';
import * as schemas from './schemas.js';
import { findBestWindow } from './window.js';
import type { ForecastResponse } from './types.js';

/** Injection point so tests never reach the network. */
export interface ToolDeps {
  fetcher?: Fetcher;
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Turn a thrown error into an MCP error result with a readable message. */
export function toErrorResult(error: unknown): ToolResult {
  if (error instanceof InputError || error instanceof EvaluationInputError) {
    return fail(`Invalid input: ${error.message}`);
  }
  if (error instanceof ForecastError) return fail(`Forecast unavailable: ${error.message}`);
  if (error instanceof Error) return fail(`Unexpected error: ${error.message}`);
  return fail('Unexpected error');
}

export function registerForecastTool(server: McpServer, deps: ToolDeps = {}): void {
  server.registerTool(
    'get_beach_forecast',
    {
      title: 'Get beach forecast',
      description:
        'Raw weather and marine forecast for one beach on one date, with units, ' +
        'which factors are missing, and the limitations of the data. Returns no ' +
        'verdict and no score — use rate_activity_conditions for that.',
      inputSchema: schemas.locationShape,
    },
    async ({ latitude, longitude, date }) => {
      try {
        const pair = await fetchForecast({ latitude, longitude, date, fetcher: deps.fetcher });

        const response: ForecastResponse = {
          location: pair.location,
          date,
          sources: pair.sources,
          weather: pair.weather,
          marine: pair.marine,
          missing: [
            ...collectMissing(pair.weather, 'weather', WEATHER_FACTORS),
            ...collectMissing(pair.marine, 'marine', MARINE_FACTORS),
          ],
          limitations: [...LIMITATIONS],
        };
        return ok(response);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}

export function registerRateTool(server: McpServer, deps: ToolDeps = {}): void {
  server.registerTool(
    'rate_activity_conditions',
    {
      title: 'Rate activity conditions',
      description:
        'Deterministic suitability rating for one beach, one date, and one activity. ' +
        'Returns a verdict, a 0-100 score normalized across the range attainable ' +
        'here, the per-Factor explanation, and any Veto that overrode the score. ' +
        'A missing required Factor yields insufficient_data rather than a guess.',
      inputSchema: schemas.evaluationShape,
    },
    async ({ latitude, longitude, date, activity, skillLevel, window }) => {
      try {
        const resolvedSkill = resolveSkillLevel(activity, skillLevel);
        const win = resolveWindow(window);

        const pair = await fetchForecast({ latitude, longitude, date, fetcher: deps.fetcher });
        const missing = [
          ...collectMissing(pair.weather, 'weather', WEATHER_FACTORS),
          ...collectMissing(pair.marine, 'marine', MARINE_FACTORS),
        ];

        const merged = mergeHours(pair.weather.hours, pair.marine.hours);
        const inWindow = hoursInRange(merged, win.start, win.end);

        const result = evaluateWindow({
          activity,
          skillLevel: resolvedSkill,
          hours: inWindow,
          location: pair.location,
          requestedWindow: window,
          missing,
        });

        // A skill level is meaningless for beach_day — report it rather than
        // dropping it, so the caller can see their input was not applied.
        if (activity === 'beach_day' && skillLevel !== undefined) {
          result.unusedSkillLevel = skillLevel;
        }

        return ok(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}

export function registerWindowTool(server: McpServer, deps: ToolDeps = {}): void {
  server.registerTool(
    'find_best_activity_window',
    {
      title: 'Find best activity window',
      description:
        'Slides a fixed 3-hour block across the requested window at hourly stride ' +
        'and names the most suitable stretch, scoring each block by the mean of ' +
        'its hours with the same rules as rate_activity_conditions. A candidate ' +
        'counts only when all three consecutive hours carry every required ' +
        'Factor; a gap disqualifies rather than bridges, and disqualified hours ' +
        'are reported under skippedHours instead of being ranked. Returns every ' +
        'evaluated candidate sorted by score, the hours that could not be ' +
        'evaluated and why, and best: null with a reason when no 3-hour stretch ' +
        'qualifies.',
      inputSchema: schemas.evaluationShape,
    },
    async ({ latitude, longitude, date, activity, skillLevel, window }) => {
      try {
        // Validate before fetching: a bad input is not worth an upstream call.
        const resolvedSkill = resolveSkillLevel(activity, skillLevel);
        resolveWindow(window);

        const pair = await fetchForecast({ latitude, longitude, date, fetcher: deps.fetcher });
        const merged = mergeHours(pair.weather.hours, pair.marine.hours);

        return ok(
          findBestWindow({
            activity,
            skillLevel: resolvedSkill,
            date,
            hours: merged,
            location: pair.location,
            requestedWindow: window,
          }),
        );
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
