# Required-Factor sets gate the verdict

Each Activity declares a fixed set of Factors without which the evaluation returns `insufficient_data` rather than a verdict — `beach_day` requires air temperature, weather code, precipitation and wind; `surfing` additionally requires wave height and wave period. Optional Factors are skipped when absent, never defaulted.

## Considered Options

- **Coverage ratio (e.g. evaluate when ≥70% of Factors are present).** Rejected: the threshold is arbitrary and indefensible in review — "why 70%?"
- **Per-factor abstention (always evaluate with whatever exists).** Rejected: `insufficient_data` would become nearly unreachable, and a location with only air temperature would return `favorable`. That is exactly the silent substitution the brief forbids.
- **Required-Factor set** — chosen: one declarative table per Activity, trivial to test, and statable in a sentence.

## Consequences

- **If marine has no coverage at a location, every `surfing` evaluation is `insufficient_data`.** That is correct, and it makes marine coverage the single biggest product risk — surfaced deliberately rather than papered over.
- `beach_day` never requires marine, so it keeps working at inland-adjacent or marine-less coordinates.
- **A Veto never fires on missing evidence.** Absence is reported in `missing[]`, never scored as 0, never inferred.
