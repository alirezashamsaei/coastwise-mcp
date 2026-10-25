# Never pass `cell_selection` to the Open-Meteo APIs

Both Open-Meteo endpoints accept a `cell_selection` parameter (`land` | `sea` | `nearest`). CoastWise deliberately omits it and relies on each endpoint's default — `land` for weather, `sea` for marine.

## Why this is not the obvious choice

`cell_selection=nearest` *looks* like the correct thing to do for a beach: pick the grid cell nearest the coordinate the user gave. It is the wrong thing to do here.

Open-Meteo's marine grid quantizes to 0.0833° (~9 km) and its default `cell_selection=sea` **snaps an on-land point to the nearest sea cell**, so a beach-town coordinate returns real wave data — verified working ~20 km inland. Passing `land` or `nearest` on that same coordinate makes it resolve to a *land* cell, where **every marine value comes back `null`**.

## Consequences

- A future reader will see us omitting an obviously-useful parameter and try to "improve" it. This ADR is the reason not to.
- Beyond roughly 15 km from open water there is no sea cell in range: the API returns **HTTP 200 with a full-length array of `null`s and no error key**. We detect all-null ourselves; we never treat it as an error.
- This is a constraint of an external API, not a preference — it cannot be refactored away.
