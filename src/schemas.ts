/**
 * Tool input schemas.
 *
 * `registerTool` takes a raw zod shape rather than a `z.object()`, and the
 * shapes are exported here so validation rules live in one place instead of
 * being restated inside each handler.
 */

import { z } from 'zod';
import { MAX_FORECAST_DAYS } from './constants.js';

export const latitude = z
  .number()
  .min(-90)
  .max(90)
  .describe('Beach latitude in decimal degrees (WGS84).');

export const longitude = z
  .number()
  .min(-180)
  .max(180)
  .describe('Beach longitude in decimal degrees (WGS84).');

export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .describe(
    `Day to evaluate, in the beach's local calendar. Today through today+${MAX_FORECAST_DAYS - 1}.`,
  );

export const activity = z.enum(['beach_day', 'surfing']).describe('What the person plans to do.');

export const skillLevel = z
  .enum(['beginner', 'intermediate', 'advanced'])
  .describe('Surfer experience. Required when activity is "surfing"; ignored for beach_day.');

export const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM');

export const window = z
  .object({ start: timeOfDay, end: timeOfDay })
  .describe(
    "Local time window to evaluate, e.g. {\"start\":\"09:00\",\"end\":\"13:00\"}. Omitted → 07:00–19:00.",
  );

/** Location + date, shared by all three tools. */
export const locationShape = { latitude, longitude, date };

/** Location + date + activity, shared by the two evaluators. */
export const evaluationShape = { latitude, longitude, date, activity, skillLevel, window };
