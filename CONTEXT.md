# CoastWise

CoastWise evaluates beach and surf conditions from forecast data using deterministic, documented rules, so a person can decide whether to go. No LLM inference happens inside the server.

## Language

**Activity**:
The thing a person intends to do at the beach. One of `beach_day` or `surfing`; it selects which rule set applies.
_Avoid_: use case, mode, intent

**Skill level**:
How experienced a surfer is: `beginner`, `intermediate`, or `advanced`. Required only for the `surfing` Activity.
_Avoid_: experience, expertise, level

**Factor**:
A single forecast value the rules score — wave height, wind speed, UV index, and so on.
_Avoid_: metric, indicator, signal, variable

**Band**:
A contiguous range of a Factor's raw values that the rules map to a fixed number of points.
_Avoid_: threshold, bucket, range

**Contribution**:
The points a Factor adds to or subtracts from the Suitability score, determined by the Band it falls in.
_Avoid_: weight, adjustment, modifier

**Suitability score**:
The sum of all Contributions for a Factor set, for a specific Activity at a specific place and time.
_Avoid_: rating, quality score, confidence

**Veto**:
A condition that forces the Verdict to `unfavorable` regardless of the Suitability score.
_Avoid_: blocker, fail, hard stop, safety check

**Verdict**:
The conclusion of an evaluation: `favorable`, `mixed`, `unfavorable`, or `insufficient_data`.
_Avoid_: recommendation, result, answer, judgment

**Best window**:
The stretch of hours inside a requested period whose Suitability score is the highest among available stretches.
_Avoid_: optimal time, ideal slot, peak
