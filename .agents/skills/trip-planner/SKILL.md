---
name: trip-planner
description: Plan trips, day itineraries and errands with Google Maps data — places with ratings and review summaries, hourly weather forecast, and walking/driving times. Use when the user asks to plan a trip, a day out, where to go or eat, or when to do something (gym, run, errands) so it avoids rain or bad weather.
---

# Trip & day planner (Google Maps Grounding Lite)

Tools come from the `google-maps` MCP extension. If they are not available, say the extension
is not enabled in this conversation instead of inventing places, ratings or forecasts.

| Tool | Use it for |
|---|---|
| `search_places` | Finding places. Put the city/area in `textQuery`. Set `includeExtendedDetails: true` when ratings, reviews, ambience or menus matter. Set `languageCode` to the user's language (e.g. `es`). |
| `lookup_weather` | Current conditions with only `location`; a forecast with `date` `{year, month, day}` and `hour` (0–23, local). Forecast reaches ~10 days ahead. |
| `compute_routes` | Distance and duration between two places, `travelMode` `DRIVE` or `WALK` only. No public transit, no live traffic, no turn-by-turn. |
| `resolve_names` / `resolve_maps_urls` | Turning names or Google Maps links the user pastes into place IDs. |

## How to plan

1. **Pin down the essentials** before searching: where, which day(s), time window, how they move
   (walk / car), budget and interests. Ask once, briefly, only for what is missing and matters.
   Assume today's date and the user's city from context when obvious.
2. **Check the weather first**, per time block: call `lookup_weather` for each hour that has an
   outdoor activity (not one call per hour of the whole day — sample the blocks you plan to use).
3. **Decide indoor vs outdoor by forecast.** Treat rain probability ≥ 40 % or thunderstorm
   probability ≥ 20 % as "wet": move outdoor activities (parks, walking tours, outdoor gym, runs)
   to a dry block, or swap them for an indoor alternative (museum, market, indoor gym, café).
   Say explicitly why you moved something ("lluvia 70 % a las 18:00 → gimnasio a las 16:00").
4. **Pick places** with `search_places`. Prefer high rating with a meaningful number of reviews
   (4.6★ with 300 reviews beats 5.0★ with 4). Check opening hours against the slot.
5. **Order stops to minimise travel**: group by area, then use `compute_routes` between
   consecutive stops. If a walk is over ~30 min, suggest driving/taxi; for transit say you can't
   compute it and give the walking/driving time instead.
6. **Leave slack**: 15–30 min buffer between stops, meals at normal hours.

## Answer format

- Reply in the user's language.
- A short timeline: `HH:MM – Activity · Place (rating★, reviews) · weather · travel to next`.
- After every place you mention, link it: `[Name](placeUrl)` using `googleMapsLinks.placeUrl`
  from the tool result. Weather and routes: link their `attribution.url`. Google's terms
  require the source right next to the content it supports — never drop the links.
- End with a one-line "Plan B" for the most weather-exposed block.
- Only state ratings, hours, distances and forecasts that came from a tool result in this
  conversation. If a tool failed, say so.

## Quick single questions

For "should I go to the gym now or later?"-type questions, skip the full itinerary: check the
next hours of forecast, answer with the best time window and one sentence of reasoning.
