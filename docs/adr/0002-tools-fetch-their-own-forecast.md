# Each tool fetches its own forecast data

All three tools accept `{latitude, longitude, date, ...}` and pull the data they need through one shared fetch module. `get_beach_forecast` returns raw values; `rate_activity_conditions` and `find_best_activity_window` do **not** accept the output of `get_beach_forecast` as input, and there is no in-process cache.

## Considered Options

- **Composable (pass the forecast payload between tools).** Would avoid a second HTTP call — rejected because MCP arguments travel as JSON by value, so the caller would round-trip a 24-hour array between calls. That is clunky in MCP Inspector and makes each tool useless on its own.
- **Self-fetching with a memo cache.** Rejected as unearned complexity: three sub-second, free calls to Open-Meteo is not a bottleneck, and mutable server state quietly works against the "deterministic" promise if a stale entry ever wins.

## Consequences

- Every tool is independently callable and independently testable — inject a fake fetcher, assert on output.
- One HTTP concern lives in `forecast.ts` and nowhere else.
- A forecast → rate → window sequence costs 3 API calls instead of 1. At Open-Meteo's free-tier limits (600/min) this is irrelevant.
