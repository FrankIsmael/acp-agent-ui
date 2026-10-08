import assert from "node:assert/strict";
import { test } from "node:test";
import { mapDataFromToolContent, mergeMapData } from "../app/lib/maps.ts";

// Formas tal cual las manda goose en `tool_call_update` (medido con la caja real).
const text = value => ({ type: "content", content: { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) } });
const placeUrl = "https://www.google.com/maps/place//data=!4m2!3m1!1s0x85d1ffc330f79401:0xefbb9a265f35be14";
const cafe = {
  id: "ChIJ1", place: "places/ChIJ1", location: { latitude: 19.35, longitude: -99.16 },
  googleMapsLinks: { placeUrl }, attribution: { title: "Café Negro - Google Maps", url: placeUrl },
};

test("places come out with name, coordinates and their Google Maps link", () => {
  const data = mapDataFromToolContent([text({ places: [cafe], summary: "…" })]);
  assert.deepEqual(data, { places: [{ id: "ChIJ1", name: "Café Negro", lat: 19.35, lng: -99.16, url: placeUrl }], routes: [] });
});

test("routes keep distance, duration in seconds and their link", () => {
  const url = "https://www.google.com/maps/dir/Caf%C3%A9%20Negro/Cafe%20El%20Jarocho";
  const data = mapDataFromToolContent([text({ routes: [{ distanceMeters: 379, duration: "320s", attribution: { title: "Café Negro to Cafe El Jarocho - Google Maps", url } }] })]);
  assert.deepEqual(data?.routes, [{ title: "Café Negro to Cafe El Jarocho", meters: 379, seconds: 320, url }]);
});

test("anything else is ignored: other tools, plain text, broken JSON, weather", () => {
  assert.equal(mapDataFromToolContent(undefined), null);
  assert.equal(mapDataFromToolContent([text("Tool: mcp__google-maps__search_places")]), null);
  assert.equal(mapDataFromToolContent([text("{not json")]), null);
  assert.equal(mapDataFromToolContent([text({ temperature: { degrees: 16 }, attribution: { url: "https://www.google.com/search?q=x" } })]), null);
  assert.equal(mapDataFromToolContent([{ type: "content", content: { type: "image", data: "…" } }]), null);
});

test("places without coordinates or with non-Google links are dropped", () => {
  const evil = { ...cafe, id: "x", googleMapsLinks: { placeUrl: "javascript:alert(1)" }, attribution: { title: "X", url: "https://evil.example/maps" } };
  const nowhere = { ...cafe, id: "y", location: {} };
  assert.equal(mapDataFromToolContent([text({ places: [evil, nowhere] })]), null);
});

test("merging several tool calls of one turn does not repeat places", () => {
  const first = mapDataFromToolContent([text({ places: [cafe] })]);
  const second = mapDataFromToolContent([text({ places: [cafe, { ...cafe, id: "ChIJ2" }] })]);
  assert.deepEqual(mergeMapData(first, second).places.map(p => p.id), ["ChIJ1", "ChIJ2"]);
  assert.deepEqual(mergeMapData(undefined, second).places.length, 2);
});

test("route endpoints come from the directions link, matched to places of the turn when possible", async () => {
  const { routeEndpoints, waypoint, travelMode, sameRoute } = await import("../app/lib/maps.ts");
  const route = { title: "Café Negro to Cafe El Jarocho", meters: 379, seconds: 320, url: "https://www.google.com/maps/dir/Caf%C3%A9%20Negro/Cafe%20El%20Jarocho" };
  assert.deepEqual(routeEndpoints(route), ["Café Negro", "Cafe El Jarocho"]);
  assert.equal(routeEndpoints({ ...route, url: "https://www.google.com/maps/place/x" }), null);
  const places = [{ id: "ChIJ1", name: "Café El Jarocho", lat: 0, lng: 0, url: "" }];
  assert.deepEqual(waypoint("Cafe El Jarocho", places), { placeId: "ChIJ1" });
  assert.deepEqual(waypoint("Zócalo, CDMX", places), { address: "Zócalo, CDMX" });
  assert.equal(travelMode(route), "WALK");
  assert.equal(travelMode({ ...route, meters: 14290, seconds: 1836 }), "DRIVE");
  assert.ok(sameRoute(400, 379) && !sameRoute(14290, 379) && !sameRoute(1, 0));
});

test("encoded polylines decode to coordinates", async () => {
  const { decodePolyline } = await import("../app/lib/maps.ts");
  // Ejemplo de la documentación de Google.
  assert.deepEqual(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@"), [
    { lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 },
  ]);
  assert.deepEqual(decodePolyline(""), []);
});
