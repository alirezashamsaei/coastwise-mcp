# CoastWise MCP

CoastWise answers one question over [MCP](https://modelcontextprotocol.io): *does this beach suit a beach day or a surf session, today or in the next six days?* It evaluates forecast data with **deterministic, documented rules** — the same inputs always produce the same output, and every number in the response can be reproduced from the tables below.

> ### Read this before you trust a score
>
> **The score is a suitability heuristic, not a safety guarantee.** CoastWise weighs forecast numbers against tuning knobs that a human chose. It knows nothing about tides, rip currents, beach flags, lifeguard warnings, or the actual state of the sea at your feet. **Never treat a `favorable` verdict as permission to enter the water.**

- **No LLM inference inside the server.** The model never scores anything; the rules do.
- **Forecast data:** [Open-Meteo.com](https://open-meteo.com/) — weather and marine APIs, no API key required for non-commercial use.
- **Attribution:** [Weather data by Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0).

---

## Quick start

Requires **Node.js 18 or newer** (developed and CI-tested on 18, 20 and 22) and network access to `api.open-meteo.com` and `marine-api.open-meteo.com`.

```bash
git clone https://github.com/alirezashamsaei/coastwise-mcp.git
cd coastwise-mcp
npm ci
npm run build
npm test
```

| Command | What it does | Expected result |
|---|---|---|
| `npm ci` | installs dependencies from `package-lock.json` | exits 0 |
| `npm run build` | compiles TypeScript to `dist/` | exits 0, no output |
| `npm test` | runs the vitest suite | `Test Files 7 passed (7)`, `Tests 141 passed (141)` |
| `npm start` | runs the server on stdio | logs `coastwise-mcp running on stdio` to **stderr**, then waits for JSON-RPC on stdin |
| `npm run inspect` | builds, then launches MCP Inspector | prints a URL on port **6274** |

---

## Demo: MCP Inspector walkthrough

```bash
npm run inspect
```

The Inspector prints:

```text
MCP Inspector Web is up and running at:
   http://127.0.0.1:6274?MCP_INSPECTOR_API_TOKEN=<token>
```

Port **6274** is the Inspector's current default (Sandbox: `6275`, verified against Inspector 2.12.0). The token changes on every run, so **open the exact URL your terminal printed** rather than typing the address by hand. If a browser does not open, copy that URL yourself.

Then:

1. Choose the **stdio** transport and point it at the build output: command `node`, argument `dist/index.js`, working directory left as the project root — then connect. The tool list shows `smoke_check`, `get_beach_forecast`, `rate_activity_conditions`, `find_best_activity_window`.
2. Open the **Tools** tab, pick **`rate_activity_conditions`**, and paste:

```json
{
  "latitude": 36.53,
  "longitude": -6.29,
  "date": "2026-10-27",
  "activity": "surfing",
  "skillLevel": "intermediate"
}
```

3. Press **Run tool**.

**Prefer the terminal?** The same Inspector, in CLI mode, runs the whole flow non-interactively — this is what produced the output quoted below:

```bash
npx --yes @modelcontextprotocol/inspector --cli node dist/index.js \
  --method tools/call --tool-name find_best_activity_window \
  --tool-arg latitude=36.53 --tool-arg longitude=-6.29 \
  --tool-arg date=2026-10-27 --tool-arg activity=beach_day
```

Swap `--method tools/list` in for the tool inventory, or `--tool-name rate_activity_conditions` plus `--tool-arg skillLevel=intermediate` for the Suitability score.

`36.53, -6.29` is El Palmar, San Fernando (Cádiz, Spain). `date` must fall inside **today … today+6** — a date outside that range is an input error, not a verdict. Use tomorrow's date if the quoted one has aged out:

```bash
date -v+1d +%F        # macOS
date -d tomorrow +%F  # Linux
(Get-Date).AddDays(1).ToString('yyyy-MM-dd')   # PowerShell
```

### Expected output (captured 2026-10-26 for 2026-10-27)

Forecast values shift as the upstream model updates, so **your numbers will differ**; the shape and the ordering rules are what to check.

Response excerpt — `factors` shows 3 of its rows and `limitations` is truncated:

```json
{
  "verdict": "mixed",
  "score": {
    "value": 58,
    "raw": 6,
    "attainableRange": { "min": -38, "max": 38 },
    "thresholds": { "favorable": 70, "mixed": 40 }
  },
  "veto": null,
  "factors": [
    { "factor": "temperature_2m", "label": "Air temperature", "unit": "°C",
      "value": 19.615384615384617, "band": "18–22 °C", "score": 0,
      "weight": 2, "contribution": 0, "required": true, "status": "scored" },
    { "factor": "wind_speed_10m", "label": "Wind speed", "unit": "km/h",
      "value": 6.446153846153846, "band": "< 12 km/h", "score": 2,
      "weight": 3, "contribution": 6, "required": true, "status": "scored" },
    { "factor": "wave_height", "label": "Wave height", "unit": "m",
      "value": 0.2630769230769231, "band": "< 0.3 m", "score": -2,
      "weight": 4, "contribution": -8, "required": true, "status": "scored" }
  ],
  "improving": ["wind_speed_10m", "wave_period", "precipitation", "wind_gusts_10m",
                "sea_surface_temperature", "weather_code"],
  "reducing": ["wave_height", "swell_wave_height"],
  "missing": [],
  "window": { "start": "07:00", "end": "19:00", "defaulted": true,
              "timezone": "Europe/Madrid" },
  "location": { "latitude": 36.5245, "longitude": -6.2036605,
                "timezone": "Europe/Madrid", "utcOffsetSeconds": 3600 },
  "limitations": [ "…", "…" ]
}
```

Two things to notice:

- **`location` is the forecast grid cell**, not your coordinate — Open-Meteo snaps to its own grid (and the marine grid snaps to `0.0833°` cells, which can be several km away).
- **You can predict `58` from the tables below:** waves at `0.26 m` fall in `< 0.3 m` → `−2` × weight `4` = **−8**; wind `6.4 km/h` in `< 12 km/h` → `+2` × `3` = **+6**; temperature in `18–22 °C` → `0`. Sum the Contributions to `raw = 6`, then `round((6 − (−38)) / (38 − (−38)) × 100) = round(57.89) = 58`, which sits between 40 and 70 → `mixed`.

Now the same call to **`find_best_activity_window`** with `"activity": "beach_day"` (excerpt — 3 of the 11 candidates shown):

```json
{
  "searched": { "start": "07:00", "end": "19:00", "timezone": "Europe/Madrid" },
  "windowHours": 3,
  "strideHours": 1,
  "best": { "start": "2026-10-27T14:00", "end": "2026-10-27T16:00",
            "score": 92, "verdict": "favorable" },
  "reason": null,
  "candidates": [
    { "start": "2026-10-27T14:00", "end": "2026-10-27T16:00", "score": 92, "verdict": "favorable" },
    { "start": "2026-10-27T15:00", "end": "2026-10-27T17:00", "score": 91, "verdict": "favorable" },
    { "start": "2026-10-27T13:00", "end": "2026-10-27T15:00", "score": 87, "verdict": "favorable" }
  ],
  "evaluatedHours": 13,
  "skippedHours": [],
  "limitations": [ "…", "…" ]
}
```

Eleven candidates were evaluated (`07:00` … `17:00` starts, hourly stride, 3 hours each), listed **score descending**, earliest first on ties — and `best` is always simply the top entry. Had a required Factor been absent from a middle hour, the three blocks spanning that hour would **not** appear here at all, and the hour itself would land in `skippedHours` with the reason: a gap disqualifies, it never bridges. When nothing qualifies, `best` is `null` with a human-readable `reason`.

---

## The three tools

All three share the same location/date core, each **fetches its own forecast** through one shared module ([ADR-0002](docs/adr/0002-tools-fetch-their-own-forecast.md)). There is no cache and no cross-tool state. (`smoke_check` is a fourth, trivial health check that echoes text — it is for confirming the transport works.)

### Shared input

| Field | Type | Rules |
|---|---|---|
| `latitude` | number | −90 … 90 |
| `longitude` | number | −180 … 180 |
| `date` | `YYYY-MM-DD` | the beach's local calendar day; **today … today+6** |
| `activity` | `beach_day` \| `surfing` | selects the rule set |
| `skillLevel` | `beginner` \| `intermediate` \| `advanced` | **required iff** `activity === "surfing"`; reported back but ignored for `beach_day` |
| `window` | `{ start, end }` as `HH:MM` | same-day, `start < end`; omitted → **07:00–19:00** |

Bad input (out-of-range coordinate, malformed date, date beyond the horizon, `surfing` without `skillLevel`) returns an MCP **error result** — `isError: true` with a message. It is never dressed up as a verdict.

### 1. `get_beach_forecast`

Raw values for one date, with units, coverage and provenance. **No verdict, no score** — this is the "show me the numbers and what's missing" surface, and it must work even when a verdict cannot.

**In:** `{ latitude, longitude, date }`

**Out:**

```ts
{
  location: { latitude, longitude, timezone, utcOffsetSeconds },
  date: string,
  sources: Array<{ api, url, attribution, issuedAt }>,   // both endpoints, CC BY 4.0
  weather: HourlyBlock,
  marine:  HourlyBlock,
  missing: Array<{ factor, scope: 'weather'|'marine', reason }>,
  limitations: string[],
}

HourlyBlock = {
  available: boolean,        // false when every value in the block is null
  units: Record<string, string>,
  hours: Array<{ time: string, values: Record<string, number | null> }>,
}
```

Only the **24 hours of the requested date** are returned. Beyond ~15 km from open water the marine API answers HTTP 200 with a full-length array of `null`s — that is reported as `marine.available = false`, not as an error.

### 2. `rate_activity_conditions`

The verdict for one place, one date, one activity over one window of hours.

**In:** shared input (including `activity`, optional `skillLevel`, optional `window`).

**Out:**

```ts
{
  verdict: 'favorable' | 'mixed' | 'unfavorable' | 'insufficient_data',

  score: null | {
    value,                 // 0–100, rounded
    raw,                   // signed point total
    attainableRange: { min, max },
    thresholds: { favorable: 70, mixed: 40 },
  },

  veto: null | {
    id,                    // 'thunderstorm' | 'frozen_precipitation' | 'wave_above_skill_ceiling'
    factor, value, unit, reason,
    overriddenScore,       // the score the rules produced before the override
  },

  factors: Array<{ factor, label, unit, value, band, score, weight,
                   contribution, required,
                   status: 'scored' | 'optional_missing' | 'context_only' }>,

  improving: string[],     // contributions > 0, largest first
  reducing:  string[],     // contributions < 0, largest first
  missing:   Array<{ factor, reason }>,
  window: { start, end, timezone, defaulted },
  location: { latitude, longitude, timezone },
  unusedSkillLevel?,       // present when skillLevel was sent with beach_day
  limitations: string[],
}
```

`insufficient_data` → `score: null`, `veto: null`, `missing` populated. A Veto never hides the arithmetic: `veto.overriddenScore` shows what the score would otherwise have been.

### 3. `find_best_activity_window`

Slides a fixed **3-hour block** across the requested window at **hourly stride**, scores each block by the mean of its hours, and names the most suitable stretch — or says plainly that none exists.

**In:** shared input; `window` is the *search bounds*.

**Out:**

```ts
{
  searched: { start, end, timezone },
  windowHours: 3,
  strideHours: 1,
  best: null | { start, end, score, verdict },
  reason: string | null,        // set iff best === null, never an empty object
  candidates: Array<{ start, end, score, verdict }>,  // qualifying blocks only, score desc
  evaluatedHours: number,
  skippedHours: Array<{ time, reason }>,
  limitations: string[],
}
```

A candidate qualifies only when **all three consecutive hours** carry every required Factor; ties resolve to the earliest. Each block is scored with exactly the code path `rate_activity_conditions` uses, so the two tools agree verdict-for-verdict — including on veto days, because this tool runs after the veto rules.

---

## How a score is computed

Four steps, in order. Nothing here is learned, randomised, or fetched beyond the forecast.

### Stage 1 — contribution

```text
band         = the band in the Factor's table whose range contains the value
score        = band.score            // −2 … +2
contribution = score × weight        // weight from the table below
```

Bands are **inclusive-low, exclusive-high**: a value sitting exactly on a boundary takes the upper band.

**Considered** = every required Factor, plus any optional Factor that has a value. An optional Factor with no value is skipped entirely — it neither adds points nor widens the attainable range. A value that no band covers is reported as `context_only`: no score, no contribution, and no guessed substitute.

### Stage 2 — normalize

```text
raw        = Σ contribution
attainable = { min: Σ(−2 × weight), max: Σ(+2 × weight) }   // over considered Factors only
value      = round( (raw − min) / (max − min) × 100 )
```

Normalizing over the range attainable *for this exact Factor set* is why a day scored with 4 Factors and a day scored with 8 Factors land on the same 0–100 scale.

### Stage 3 — verdict

| Condition | Verdict |
|---|---|
| a required Factor is missing, or nothing was scored | `insufficient_data` |
| a Veto fires (below) | `unfavorable` |
| `value ≥ 70` | `favorable` |
| `value ≥ 40` | `mixed` |
| otherwise | `unfavorable` |

**Never:** substitute an assumed value for missing data; score missing data as `0`; fire a Veto on evidence we do not have.

### Stage 4 — window aggregation

Both evaluators score a *window* of hours, not an instant. The hours collapse into one value per Factor first:

| Factor kind | Rule | Why |
|---|---|---|
| continuous (`temperature_2m`, `wave_height`, …) | **mean** across the window | the window is an average of conditions |
| `weather_code` | **mode**, first-seen wins ties | WMO codes are categorical; averaging `0` and `3` invents `1.5`, a code nobody reported |
| any Factor absent from **any** hour | window is `insufficient_data` | partial coverage is not coverage |

A Veto is evaluated against **every hour** in the window, not against the aggregate: one thunderstorm in the window disqualifies it, even when the modal code is clear sky.

---

## The rules, in full

> **These numbers are documented tuning knobs, not findings.** They are reproduced here verbatim so you can predict a score without reading the code. Boundaries are inclusive-low, exclusive-high.

### Weights

| Factor | `beach_day` | `surfing` | Required |
|---|---|---|---|
| `temperature_2m` | 4 | 2 | both |
| `weather_code` | 4 | 1 | scored for both; **required for `beach_day` only** |
| `precipitation` | 3 | 1 | both |
| `wind_speed_10m` | 3 | 3 | both |
| `wave_height` | 1 | 4 | **surfing** |
| `wave_period` | — | 3 | **surfing** |
| `uv_index` | 2 | — | optional |
| `wind_gusts_10m` | 1 | 1 | optional |
| `sea_surface_temperature` | 1 | 1 | optional (needs marine) |
| `swell_wave_height` | — | 2 | optional |
| `swell_wave_period` | — | 1 | optional |

Required sets (ADR-0004):

| Activity | Required Factors |
|---|---|
| `beach_day` | `temperature_2m`, `weather_code`, `precipitation`, `wind_speed_10m` |
| `surfing` | `wave_height`, `wave_period`, `wind_speed_10m`, `temperature_2m`, `precipitation` |

`cloud_cover` and `visibility` are **reported, not scored** — `weather_code` already encodes sky condition, and scoring both would double-count. `wave_direction` is not scored: shore orientation is unknowable from a coordinate.

### `temperature_2m` — °C

| Range | Score |
|---|---|
| `< 14` | −2 |
| `14–18` | −1 |
| `18–22` | 0 |
| `22–26` | +1 |
| `26–32` | +2 |
| `32–35` | +1 |
| `≥ 35` | 0 |

40 °C scores **0**, not negative: the curve flattens rather than falls. If you want extreme heat penalized, change this row and the tests that assert it.

### `weather_code` — WMO

| Code | Score |
|---|---|
| `0` clear, `1` mainly clear | +2 |
| `2` partly cloudy | +1 |
| `3` overcast | 0 |
| `45` fog, `48` depositing rime fog | −1 |
| `51–57` drizzle, `61–65` rain, `80–82` rain showers | 0 |
| `66, 67, 71–77, 85, 86` frozen precipitation | −2 **and VETO** |
| `95, 96, 99` thunderstorm | −2 **and VETO** |

Liquid-precipitation codes score `0` deliberately: `precipitation` carries that signal, and scoring both would double-count. An unrecognised WMO code has no band at all — it is reported as `context_only`, never guessed.

### `precipitation` — mm/h

| Range | Score |
|---|---|
| `= 0` | +2 |
| `> 0 – 0.5` | +1 |
| `0.5 – 2` | 0 |
| `2 – 10` | −1 |
| `> 10` | −2 |

The `= 0` row is a zero-width point band; every other band is inclusive-low, exclusive-high, so `0.5 mm/h` scores `0`.

### `wind_speed_10m` — km/h

| Range | Score |
|---|---|
| `< 12` | +2 |
| `12–20` | +1 |
| `20–28` | 0 |
| `28–40` | −1 |
| `> 40` | −2 |

### `uv_index`

| Range | Score |
|---|---|
| `0–2` | 0 |
| `3–5` | +1 |
| `6–7` | +2 |
| `8–10` | +1 |
| `> 10` | 0 |

High UV is not a beach positive — burn risk, so the curve rises then falls.

### `wind_gusts_10m` — km/h

| Range | Score |
|---|---|
| `< 20` | +2 |
| `20–30` | +1 |
| `30–40` | 0 |
| `40–55` | −1 |
| `> 55` | −2 |

### `wave_height` — m

**`beach_day`** (smaller is calmer):

| Range | Score |
|---|---|
| `< 0.3` | +2 |
| `0.3–0.7` | +1 |
| `0.7–1.2` | 0 |
| `1.2–2.0` | −1 |
| `> 2.0` | −2 |

**`surfing`** — a curve with a sweet spot per Skill level, because flat water and closing-out surf are both bad. Each table is total and open-ended at the top, so no value can escape the bands.

| Range | beginner | intermediate | advanced |
|---|---|---|---|
| **ceiling** (Veto above) | **1.5 m** | **2.5 m** | **4.0 m** |
| `< 0.3` | −2 | −2 | −2 |
| `0.3–0.4` | +1 | −2 | −2 |
| `0.4–0.5` | +1 | +1 | −2 |
| `0.5–1.0` | +2 | +1 | 0 |
| `1.0–1.3` | 0 | +1 | 0 |
| `1.3–1.8` | −1 | +2 | +1 |
| `1.8–2.0` | −2 | +2 | +1 |
| `2.0–2.2` | −2 | 0 | +2 |
| `2.2–2.5` | −2 | −1 | +2 |
| `2.5–3.2` | −2 | −2 | +2 |
| `3.2–4.0` | −2 | −2 | 0 |
| `> 4.0` | −2 | −2 | −2 |

Read as three separate tables at implementation time; this grid is documentation shorthand. Past a ceiling the curve has already fallen to its floor, so the band and the Veto agree about what the day is worth.

### `wave_period` / `swell_wave_period` — s

| Range | Score |
|---|---|
| `< 5` | −2 |
| `5–7` | −1 |
| `7–9` | 0 |
| `9–12` | +1 |
| `> 12` | +2 |

### `swell_wave_height` — m

| Range | Score |
|---|---|
| `< 0.3` | −1 |
| `0.3–1.5` | +2 |
| `1.5–2.5` | +1 |
| `2.5–3.5` | 0 |
| `> 3.5` | −1 |

### `sea_surface_temperature` — °C

| Range | Score |
|---|---|
| `< 14` | −1 |
| `14–18` | 0 |
| `18–26` | +2 |
| `26–29` | +1 |
| `≥ 29` | 0 |

### Vetoes

Three. Each forces `unfavorable` regardless of the score, and carries a human-readable `reason` plus the `overriddenScore` it beat.

| id | Fires when | Applies to |
|---|---|---|
| `thunderstorm` | `weather_code ∈ {95, 96, 99}` | both |
| `frozen_precipitation` | `weather_code ∈ {66, 67, 71, 73, 75, 77, 85, 86}` | both |
| `wave_above_skill_ceiling` | `wave_height` above the ceiling in the table above | `surfing` only |

Wind gusts are **deliberately not** a Veto — high gusts already score poorly, and a Veto that fires on a merely unpleasant day makes the tool look alarmist. No Veto ever fires on missing evidence.

---

## Limitations

Every tool response carries all seven in a `limitations` array, so a client cannot miss them:

1. The score is a **suitability heuristic, not a safety guarantee.**
2. **No tide data** — Open-Meteo has no tide API; `sea_level_height_msl` is mean-datum and "not suitable for coastal navigation."
3. **No rip currents, beach flags, surf ratings, or lifeguard warnings** exist in any Open-Meteo product.
4. **Wave direction is not scored** — shore orientation is unknowable from a coordinate.
5. **Offshore vs onshore wind is not distinguished** — same reason.
6. **Marine coverage is fragile within ~15 km of open water**; beyond that, `surfing` returns `insufficient_data`.
7. **Marine horizon ≈ 7 days**, shorter than weather's.

Explicitly out of scope: nearby-business search, route planning, a frontend, a database, remote/HTTP transport, cloud hosting.

---

## Data source and attribution

| Purpose | Endpoint |
|---|---|
| Weather | `https://api.open-meteo.com/v1/forecast` |
| Marine | `https://marine-api.open-meteo.com/v1/marine` |

Note the marine API lives on **its own host** — `api.open-meteo.com/v1/marine` is a 404.

Requests pass `timezone=auto` (so every timestamp is beach-local, no offset) and cap `forecast_days` at 7 so the weather and marine horizons stay aligned. `cell_selection` is **never** passed — see [ADR-0005](docs/adr/0005-never-pass-cell-selection.md).

**Attribution is mandatory under CC BY 4.0.** Please credit:

> [Weather data by Open-Meteo.com](https://open-meteo.com/)

Free tier: 10,000 calls/day, 5,000/hour, 600/minute, no API key for non-commercial use.

---

## Architecture invariants

These hold across the whole codebase; a change that breaks one is a bug.

- **Deterministic rules.** Same inputs, same output. No clock, no randomness, no LLM inference inside the server.
- **One module does HTTP** (`src/forecast.ts`), through an injectable fetcher. **No test touches the network** — every suite drives a fake fetcher, so CI runs offline and cannot flake on upstream.
- **Every tool fetches its own forecast** ([ADR-0002](docs/adr/0002-tools-fetch-their-own-forecast.md)): no cache, no cross-tool state.
- **Upstream failure ≠ missing data.** An HTTP error is an MCP `isError` result; a 200 full of `null`s is a normal response that yields `insufficient_data` with `missing[]`.
- **Missing data is reported, never substituted, never scored as `0`, and never Vetoed on.**
- **No `console.log`** — it would corrupt the stdio JSON-RPC stream. `console.error` only.

---

## Decision records

Why the design is shaped this way:

| ADR | Decision |
|---|---|
| [0001](docs/adr/0001-additive-score-with-hard-vetoes.md) | Additive score with hard vetoes |
| [0002](docs/adr/0002-tools-fetch-their-own-forecast.md) | Each tool fetches its own forecast |
| [0003](docs/adr/0003-mcp-sdk-v1-over-v2.md) | MCP SDK v1 over v2 |
| [0004](docs/adr/0004-required-factor-sets.md) | Per-activity required-factor sets |
| [0005](docs/adr/0005-never-pass-cell-selection.md) | Never pass `cell_selection` |

The full specification lives in [`docs/spec.md`](docs/spec.md); the shared vocabulary in [`CONTEXT.md`](CONTEXT.md).

---

## Project layout

```
src/
  index.ts      server wiring, stdio transport, tool registrations
  schemas.ts    zod input schemas
  forecast.ts   the shared Open-Meteo fetcher (the only module that does HTTP)
  bands.ts      the band tables above, as data
  scoring.ts    band lookup, contribution, normalization, verdict
  vetoes.ts     the three veto rules
  evaluate.ts   window aggregation + veto application
  window.ts     the 3-hour sliding search
  tools.ts      tool handlers
  types.ts      output types
  constants.ts  endpoints, attribution, limitations, thresholds
test/           vitest; no suite touches the network
docs/adr/       decision records
```

## License

MIT — see [LICENSE](LICENSE).
