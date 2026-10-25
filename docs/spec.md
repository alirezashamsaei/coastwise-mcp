# CoastWise MCP — Spec

Status: settled. Vocabulary lives in [`../CONTEXT.md`](../CONTEXT.md); why-we-decided lives in [`adr/`](./adr/).

CoastWise decides whether forecast conditions suit a beach day or a surf session. It runs **deterministic, documented rules** — no LLM inference inside the server, no network access outside Open-Meteo.

---

## 1. Scope

**In:** three stdio tools, TypeScript, local machine, MCP Inspector demo.

**Out (explicit):** nearby-business search, route planning, frontend, database, remote/HTTP transport, cloud hosting, tides, rip currents, beach flags, surf ratings, wave direction. *Open-Meteo has none of these — see §8.*

---

## 2. Tools

All three take the same location/date core. Each **fetches its own data** through one shared module (ADR-0002); there is no cache and no cross-tool state.

### 2.1 Shared input

```ts
const locationInput = {
  latitude:  z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** YYYY-MM-DD in the beach's local calendar day. Today .. today+6. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
};
```

A `date` outside today..today+6 is an **input error**, not `insufficient_data` — Open-Meteo's real horizon is 7 days.

```ts
const activityInput = {
  activity: z.enum(['beach_day', 'surfing']),
  /** Required iff activity === 'surfing'. */
  skillLevel: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
  /** Beach-local HH:MM–HH:MM. Omitted → 07:00–19:00. */
  window: z.object({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end:   z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  }).optional(),
};
```

`skillLevel` missing for `surfing` → input error. `skillLevel` present for `beach_day` → ignored (reported back so the caller sees it wasn't used).

### 2.2 `get_beach_forecast`

Raw values for one date, with units, coverage, and provenance. No verdict.

```ts
// input
{ latitude, longitude, date }
```

```ts
// output
{
  location: { latitude, longitude, timezone: string, utcOffsetSeconds: number },
  date: string,
  sources: Array<{ api: string, url: string, attribution: string, issuedAt: string }>,
  weather:  HourlyBlock,   // see below
  marine:   HourlyBlock,
  missing:  Array<{ factor: string, scope: 'weather'|'marine', reason: string }>,
  limitations: string[],
}
```

```ts
HourlyBlock = {
  available: boolean,        // false when every value across the block is null
  units: Record<string, string>,
  hours: Array<{
    time: string,            // "2026-10-26T09:00" — beach-local, no offset
    values: Record<string, number | null>,
  }>,
}
```

Only the **24 hours of the requested date** are returned, not the whole forecast array.

**Why this tool exists:** it is the "show me the raw numbers and what's missing" surface. It must work even when the verdict cannot (marine out of coverage, etc.).

### 2.3 `rate_activity_conditions`

```ts
// input
{ latitude, longitude, date, activity, skillLevel?, window? }
```

```ts
// output
{
  verdict: 'favorable' | 'mixed' | 'unfavorable' | 'insufficient_data',

  score: null | {
    value: number,                 // 0–100, rounded
    raw: number,                   // signed point total
    attainableRange: { min: number, max: number },
    thresholds: { favorable: 70, mixed: 40 },
  },

  veto: null | {
    id: string,                    // 'thunderstorm' | 'frozen_precipitation' | 'wave_above_skill_ceiling'
    factor: string,
    value: number,
    unit: string,
    reason: string,                // human sentence
    overriddenScore: number | null, // the score that would otherwise have applied
  },

  factors: Array<{
    factor: string,                // canonical name, e.g. 'wave_height'
    label: string,                 // 'Wave height'
    unit: string,
    value: number | null,
    band: string | null,           // '0.5–1.0 m'
    score: number | null,          // −2..+2
    weight: number,
    contribution: number | null,   // score × weight
    required: boolean,
    status: 'scored' | 'optional_missing' | 'context_only',
  }>,

  improving: string[],             // factors with contribution > 0, largest first
  reducing:  string[],             // factors with contribution < 0, largest first
  missing:   Array<{ factor: string, reason: string }>,

  window: { start: string, end: string, timezone: string, defaulted: boolean },
  location: { latitude, longitude, timezone },
  limitations: string[],
}
```

`insufficient_data` → `score: null`, `veto: null`, every `factors[]` entry with `status: 'optional_missing'` or a required entry with `value: null`, plus populated `missing`.

### 2.4 `find_best_activity_window`

```ts
// input
{ latitude, longitude, date, activity, skillLevel?, window? }   // window = search bounds
```

```ts
// output
{
  searched: { start, end, timezone },
  windowHours: 3,
  strideHours: 1,
  best: null | { start, end, score, verdict },
  reason: string | null,          // set iff best === null
  candidates: Array<{ start, end, score, verdict }>,  // all evaluated, sorted score desc
  evaluatedHours: number,
  skippedHours: Array<{ time: string, reason: string }>,
  limitations: string[],
}
```

A candidate exists only if **3 consecutive hours** each have every required Factor present. Otherwise `best: null` with `reason`.

---

## 3. Scoring model

ADR-0001. Deterministic, two stages.

### 3.1 Stage 1 — contribution

For each considered Factor:

```
band  = first band in the Factor's table whose range contains the value
score = band.score                       // −2 … +2, from §4
contribution = score × weight            // weight from §4, per activity
```

**Considered** = every required Factor, plus any optional Factor that has a value. An optional Factor with `null` is skipped entirely — it neither adds nor widens the range.

### 3.2 Stage 2 — normalize

```
raw        = Σ contribution
attainable = { min: Σ(−2 × weight), max: Σ(+2 × weight) }
value      = round( (raw − min) / (max − min) × 100 )
```

Normalizing over the **attainable range for this exact Factor set** means a day scored with 4 Factors and a day scored with 8 Factors land on the same scale.

### 3.3 Verdict

| condition | verdict |
|---|---|
| a required Factor is missing, or no Factor has a value | `insufficient_data` |
| a Veto fires (§5) | `unfavorable` |
| `value ≥ 70` | `favorable` |
| `value ≥ 40` | `mixed` |
| otherwise | `unfavorable` |

A Veto **reports the score anyway**, with `veto.overriddenScore`, so the override is visible rather than mysterious.

**Never:** substitute an assumed value for missing data; score missing data as `0`; fire a Veto on evidence we do not have.

### 3.4 Window aggregation

Both evaluators score a *window* of hours, not a single instant. Before Stage 1 runs, the window's hours collapse into one value per Factor:

| Factor kind | Rule | Why |
|---|---|---|
| continuous (`temperature_2m`, `wave_height`, …) | **mean** across the window | the window is an average of conditions |
| `weather_code` | **mode** (first-seen on ties) | WMO codes are categorical; averaging `0` and `3` invents `1.5`, a code nobody reported |
| any Factor absent from **any** hour | window is `insufficient_data` | partial coverage is not coverage |

A Veto is evaluated against **every hour** in the window, not against the aggregate: one thunderstorm in the window disqualifies the window, even when the modal code is clear sky.

---

## 4. Factor tables

`bandScore` is −2…+2. Boundaries are inclusive-low, exclusive-high. **These numbers are documented tuning knobs**, not findings — the README reproduces these tables verbatim.

### 4.1 Weights

| Factor | `beach_day` | `surfing` | Required |
|---|---|---|---|
| `temperature_2m` | 4 | 2 | both |
| `weather_code` | 4 | 1 | both |
| `precipitation` | 3 | 1 | both |
| `wind_speed_10m` | 3 | 3 | both |
| `wave_height` | 1 | 4 | **surfing** |
| `wave_period` | — | 3 | **surfing** |
| `uv_index` | 2 | — | optional |
| `wind_gusts_10m` | 1 | 1 | optional |
| `sea_surface_temperature` | 1 | 1 | optional (needs marine) |
| `swell_wave_height` | — | 2 | optional |
| `swell_wave_period` | — | 1 | optional |

`cloud_cover` and `visibility` are **reported, not scored** — `weather_code` already encodes sky condition, and scoring both would double-count. *(Refines the Q8 list; flagged for review.)*

`wave_direction` is not scored: shore orientation is unknowable from a coordinate.

### 4.2 `temperature_2m` — °C

| Range | Score |
|---|---|
| `< 14` | −2 |
| `14–18` | −1 |
| `18–22` | 0 |
| `22–26` | +1 |
| `26–32` | +2 |
| `32–35` | +1 |
| `≥ 35` | 0 |

*Note:* 40 °C scores **0**, not negative. The curve flattens rather than falls — a scorching day is neutral by these rules, not penalized. If you want extreme heat penalized, change this row and the tests that assert it.

### 4.3 `weather_code` — WMO

| Codes | Score |
|---|---|
| `0, 1` clear / mainly clear | +2 |
| `2` partly cloudy | +1 |
| `3` overcast | 0 |
| `45, 48` fog | −1 |
| `51–57, 61–65, 80–82` liquid precipitation | 0 |
| `66, 67, 71–77, 85, 86` frozen precipitation | **VETO** |
| `95, 96, 99` thunderstorm | **VETO** |

Liquid-precipitation codes score `0` deliberately: `precipitation` carries that signal, and scoring both would double-count.

### 4.4 `precipitation` — mm/h

| Range | Score |
|---|---|
| `= 0` | +2 |
| `(0, 0.5]` | +1 |
| `(0.5, 2]` | 0 |
| `(2, 10]` | −1 |
| `> 10` | −2 |

### 4.5 `wind_speed_10m` — km/h

| Range | Score |
|---|---|
| `< 12` | +2 |
| `12–20` | +1 |
| `20–28` | 0 |
| `28–40` | −1 |
| `> 40` | −2 |

### 4.6 `uv_index`

| Range | Score |
|---|---|
| `0–2` | 0 |
| `3–5` | +1 |
| `6–7` | +2 |
| `8–10` | +1 |
| `> 10` | 0 |

High UV is not a beach positive — burn risk, so the curve peaks and falls.

### 4.7 `wind_gusts_10m` — km/h

| Range | Score |
|---|---|
| `< 20` | +2 |
| `20–30` | +1 |
| `30–40` | 0 |
| `40–55` | −1 |
| `> 55` | −2 |

### 4.8 `wave_height` — m

**`beach_day`** (smaller is calmer):

| Range | Score |
|---|---|
| `< 0.3` | +2 |
| `0.3–0.7` | +1 |
| `0.7–1.2` | 0 |
| `1.2–2.0` | −1 |
| `> 2.0` | −2 |

**`surfing`** — a *peak* curve per Skill level, because flat water and closing-out surf are both bad:

| Range | beginner | intermediate | advanced |
|---|---|---|---|
| ceiling (Veto above) | **1.5 m** | **2.5 m** | **4.0 m** |
| `< 0.3` | −2 | −2 | −2 |
| `0.3–0.4` | +1 | −2 | — |
| `0.4–0.5` | +1 | +1 | −2 |
| `0.5–1.0` | +2 | +1 | 0 |
| `1.0–1.3` | 0 | +1 | 0 |
| `1.3–1.8` | −1 | +2 | +1 |
| `1.8–2.0` | — | +2 | +1 |
| `2.0–2.2` | — | 0 | +2 |
| `2.2–2.5` | — | −1 | +2 |
| `2.5–3.2` | — | — | +2 |
| `3.2–4.0` | — | — | 0 |

Read as three separate tables at implementation time; the merged grid is documentation shorthand. Implement as `waveHeightBands[skillLevel]`.

**The tables are total.** Two corrections to the grid above, both deliberate:

1. **`advanced` gets a `0.3–0.4 m` row at −2.** The grid left it as an em-dash, which would have made it the one unbandable value in the table — and both neighbouring bands are −2, so the gap was a transcription slip.
2. **Every table is open-ended at the top** (`> 1.8` beginner, `> 2.5` intermediate, `> 4.0` advanced, all at −2).

Both matter because `evaluate` reports a present-but-unbandable value as `context_only`: it contributes nothing while still satisfying the required-Factor gate. A table with a hole would let a wildly unsuitable day score normally. The curve is already at its floor past the ceiling, so the band and the Veto agree about what the day is worth.

`weather_code` is the one Factor where a `null` Band is correct — an unrecognised WMO code has no row and no score, and it is reported as `context_only` rather than guessed.

### 4.9 `wave_period` / `swell_wave_period` — s

| Range | Score |
|---|---|
| `< 5` | −2 |
| `5–7` | −1 |
| `7–9` | 0 |
| `9–12` | +1 |
| `> 12` | +2 |

### 4.10 `swell_wave_height` — m

| Range | Score |
|---|---|
| `< 0.3` | −1 |
| `0.3–1.5` | +2 |
| `1.5–2.5` | +1 |
| `2.5–3.5` | 0 |
| `> 3.5` | −1 |

### 4.11 `sea_surface_temperature` — °C

| Range | Score |
|---|---|
| `< 14` | −1 |
| `14–18` | 0 |
| `18–26` | +2 |
| `26–29` | +1 |
| `≥ 29` | 0 |

---

## 5. Vetoes

Three. Each forces `unfavorable` and carries a human-readable `reason`.

| id | Condition | Applies to |
|---|---|---|
| `thunderstorm` | `weather_code ∈ {95, 96, 99}` | both |
| `frozen_precipitation` | `weather_code ∈ {66, 67, 71, 73, 75, 77, 85, 86}` | both |
| `wave_above_skill_ceiling` | `wave_height` above the ceiling in §4.8 | `surfing` only |

Wind gusts are **deliberately not** a Veto — high gusts already score poorly through §4.7, and a Veto that fires on a merely unpleasant day makes the tool look alarmist.

---

## 6. Missing data

ADR-0004. Per-Activity **Required-Factor set**:

| Activity | Required |
|---|---|
| `beach_day` | `temperature_2m`, `weather_code`, `precipitation`, `wind_speed_10m` |
| `surfing` | `wave_height`, `wave_period`, `wind_speed_10m`, `temperature_2m`, `precipitation` |

Any required Factor missing in **any hour of the requested window** → `insufficient_data` for that evaluation. Optional Factors missing are reported under `missing` and skipped.

Consequences:

- If marine has no coverage at a location, **every `surfing` evaluation is `insufficient_data`.** `beach_day` is unaffected — it never requires marine.
- **No Veto fires on missing evidence.** Absence is reported, never scored, never inferred.

---

## 7. Data sources

### 7.1 Endpoints

| Purpose | URL |
|---|---|
| Weather | `https://api.open-meteo.com/v1/forecast` |
| Marine | `https://marine-api.open-meteo.com/v1/marine` |

**`api.open-meteo.com/v1/marine` is a 404.** The marine host differs from the weather host.

### 7.2 Request parameters

```
latitude, longitude
hourly       = <factors needed for this activity>
timezone     = auto          // returns beach-local ISO strings, no offset
forecast_days= (days until target + 1), capped at 7
```

**Never pass `cell_selection`** (ADR-0005).

Weather factors:
`temperature_2m, weather_code, precipitation, wind_speed_10m, wind_gusts_10m, uv_index, cloud_cover, visibility`

Marine factors:
`wave_height, wave_period, wind_wave_height, swell_wave_height, swell_wave_period, sea_surface_temperature`

### 7.3 Coverage realities

- Marine grid snaps to **0.0833°** cells; the returned coordinates are the cell centre and can differ from the request by several km.
- Marine's default `cell_selection=sea` returns the nearest **sea** cell for an on-land point — verified to ~20 km inland. Passing `land` or `nearest` on the same point returns **all nulls**.
- Beyond ~15 km from any sea cell, marine returns **HTTP 200 with a full-length array of `null`s and no error key.** All-null detection is our job.
- Marine real horizon ≈ **7 days**. Weather offers 16 — we cap at 7 so the two stay aligned.
- Missing values are JSON `null`, never omitted; arrays are always full length.

### 7.4 Access

- No API key for non-commercial use.
- Free tier: 10,000 calls/day, 5,000/hour, 600/minute.
- **Attribution is mandatory — CC BY 4.0.** The README links `Weather data by Open-Meteo.com`; every tool output carries the same attribution string.

---

## 8. Limitations (surfaced in every output)

Carried as a `limitations: string[]` so a client can never miss them:

1. The score is a **suitability heuristic, not a safety guarantee.**
2. **No tide data** — Open-Meteo has no tide API; `sea_level_height_msl` is mean-datum and "not suitable for coastal navigation."
3. **No rip currents, beach flags, surf ratings, or lifeguard warnings** exist in any Open-Meteo product.
4. **Wave direction is not scored** — shore orientation is unknowable from a coordinate.
5. **Offshore vs onshore wind is not distinguished** — same reason.
6. **Marine coverage is fragile within ~15 km of open water**; beyond that, `surfing` returns `insufficient_data`.
7. **Marine horizon ≈ 7 days**, shorter than weather's.

---

## 9. Errors

| Situation | Signal |
|---|---|
| Bad input (out-of-range lat/lon, malformed date, date >6 days out, `surfing` without `skillLevel`) | MCP `isError: true` + message. **Not** a verdict. |
| Open-Meteo HTTP failure (4xx/5xx, network, timeout) | MCP `isError: true` + status/reason. **Not** a verdict. |
| HTTP 200 with `null` values | Normal path → `insufficient_data` with `missing[]`. |
| All-null marine block | `marine.available = false`, reported; drives `insufficient_data` for `surfing` only. |

Two different things get two different signals: **an upstream failure is an error; absent data is `insufficient_data`.**

### 9.1 Spec errata

Ambiguities found while implementing, and how they were resolved:

| # | Conflict | Resolution |
|---|---|---|
| 1 | §4.4 precipitation `(0, 0.5]` closes high; §4 header mandates exclusive-high bands | **Header wins.** `0.5 mm/h` scores `0` (in `0.5–2`), not `+1`. The `= 0` row is a zero-width point band (`min === max`), a small extension of the Band model. |
| 2 | §4.1 marks `weather_code` required for both Activities; §6's `surfing` row omits it | **§6 wins.** Surfing scores `weather_code` (weight 1) but does not require it. |
| 3 | §4.3 weather-code rows say `VETO` with no number | Transcribed as `−2` (table floor) so a stormy day still normalizes; the real Veto lives in `vetoes.ts`. |
| 4 | §2.3 describes "a required entry with `value: null`" as distinct from `status: 'optional_missing'` | `FactorDetail.status` is a three-value union with no fourth option: required-missing rows use `optional_missing` plus `required: true`. |
| 5 | §4.8 grid holes | See §4.8 note above — tables made total. |
| 6 | Normalization degenerate case (`min === max`, no considered Factors) | Unreachable: `evaluate` gates that case to `insufficient_data` before a score can be produced. |
| 7 | §4.2 curve at `≥ 35 °C` scores `0`, not negative | Kept as written; flagged in §4.2. |

---

## 10. Project shape

```jsonc
// package.json
{
  "name": "coastwise-mcp",
  "type": "module",
  "scripts": {
    "build":   "tsc",
    "test":    "vitest run",
    "test:watch": "vitest",
    "start":   "node dist/index.js",
    "inspect": "npm run build && npx @modelcontextprotocol/inspector node dist/index.js"
  }
}
```

```
src/
  index.ts            // server wiring, stdio transport, 3 tool registrations
  schemas.ts          // zod input schemas
  forecast.ts         // shared Open-Meteo fetcher (the only module that does HTTP)
  scoring.ts          // band lookup, contribution, normalization, verdict
  bands.ts            // §4 tables as data
  vetoes.ts           // §5 rules
  window.ts           // 3-hour sliding search
  types.ts            // output types
test/
  scoring.test.ts     bands, weights, normalization, verdict thresholds
  vetoes.test.ts      each veto, plus "missing data never vetoes"
  rate.test.ts        rate_activity_conditions end to end: happy path, input
                      validation, vetoes, required-factor gating →
                      insufficient_data, window aggregation
  window.test.ts      stride count, gaps that do not bridge, no-qualifying-
                      window, tie-break, off-hour bounds, agreement with rate
  forecast.test.ts    mocked fetch: params, 4xx, nulls, all-null marine
  tools.test.ts       end-to-end through the MCP handlers with a fake fetcher
  smoke.test.ts       server boot: tool listing, echo, validation errors
```

- **`@modelcontextprotocol/sdk` ^1.32.2** + `zod` ^4 (ADR-0003), `registerTool` API (`.tool()` is deprecated).
- **vitest**; every HTTP call goes through an injectable fetcher. **No test touches the network.**
- **Node ≥22.12** engines; dev environment is Node 24; CI matrix `[22, 24]`. The floor comes from vitest 5 (rolldown needs `^22.12.0 || ^24.0.0 || >=26.0.0`) — Node 18 and 20 are EOL and cannot run the suite.
- No `console.log` — it corrupts the stdio JSON-RPC stream. `console.error` only.

---

## 11. Tickets

Independently testable, in order. Each is a GitHub issue.

1. **Scaffold** — package.json, tsconfig, vitest config, CI workflow, empty `src/index.ts` that starts on stdio and lists zero tools. *Test: `npm run build` and `npm test` both pass.*
2. **Fetch layer** — `forecast.ts` with injected fetcher; weather + marine param building, `timezone=auto`, `forecast_days` cap, all-null detection, HTTP-error mapping. *Test: `forecast.test.ts`.*
3. **Bands + scoring** — `bands.ts`, `scoring.ts`: band lookup, contribution, normalization, verdict thresholds. *Test: `scoring.test.ts`.*
4. **Vetoes** — `vetoes.ts`: three rules, plus proof that missing data never vetoes. *Test: `vetoes.test.ts`.*
5. **Required-Factor gating** — per-activity sets → `insufficient_data`; optional factors skipped, not defaulted. *Test: `rate.test.ts` (`rate_activity_conditions — missing data`).*
6. **`get_beach_forecast`** — handler + schema + output assembly (units, missing, limitations, attribution). *Test: part of `tools.test.ts`.*
7. **`rate_activity_conditions`** — handler wiring scoring + vetoes + gating into the output shape. *Test: `tools.test.ts`.*
8. **`find_best_activity_window`** — `window.ts` sliding search + handler. *Test: `window.test.ts`.*
9. **README + Inspector demo** — install/build/test/demo instructions, rule tables, limitations, attribution, verified `npx` walkthrough. *Test: manual Inspector run.*
