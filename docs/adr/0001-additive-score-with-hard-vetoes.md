# Additive score with hard vetoes, normalized across the attainable range

CoastWise needs one number that a person can act on, and an explanation they can audit. We combine **weighted additive Contributions** (each Factor scored −2…+2 by a Band table, multiplied by an Activity weight) with a short list of **hard Vetoes** that force `unfavorable` regardless of the score, then normalize the raw total to 0–100 across the range actually attainable for the Factor set under evaluation.

## Considered Options

- **Pure additive, no vetoes.** One scoring path, simplest to test — rejected because a beginner facing 3.0 m waves could still average out to `mixed` if the weather were lovely. The score would be technically explainable and practically wrong.
- **Vetoes only.** Rejected as opaque: it would hide *how close* a day was and produce no gradient between `mixed` and `favorable`.
- **Multiplicative / gates-only.** Rejected outright — brittle and impossible to explain in a sentence.

## Consequences

- The Veto must **report** the score it overrode, otherwise the override looks arbitrary. `veto.overriddenScore` exists for this.
- Normalizing over the *attainable* range (not a fixed 0–100 sum) keeps days evaluated with 4 Factors comparable to days evaluated with 8. A day that scores 100 is "best possible here", not "perfect weather".
- Both mechanisms are reachable in tests independently: Bands through `scoring`, Vetoes through `vetoes`.
