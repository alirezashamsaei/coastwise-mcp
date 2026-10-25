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
import * as schemas from './schemas.js';
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
  if (error instanceof InputError) return fail(`Invalid input: ${error.message}`);
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
