// Pure planner tests for endpoint-change.js: the plan decides which day
// fields move together, which implicit visit ids retire, and when the edit
// is destructive enough to confirm — the controller just executes it.
"use strict";
const test = require("node:test");
const assert = require("node:assert");

const EndpointChange = require("../../projects/biwa-ride/endpoint-change.js");

// Minimal trip shape — two days sharing the Comfort boundary, then a third.
function makeTrip(visitStatus) {
	return {
		days: [
			{
				dayId: "day-1",
				start: { placeId: "stay-hana" },
				end: { placeId: "stay-comfort" },
			},
			{
				dayId: "day-2",
				start: { placeId: "stay-comfort" },
				end: { placeId: "stay-rinkoso" },
			},
			{
				dayId: "day-3",
				start: { placeId: "stay-rinkoso" },
				end: { placeId: "rally-rental" },
			},
		],
		visitStatus: visitStatus || {},
	};
}

test("a checked overnight boundary clear retires BOTH visit keys and confirms", () => {
	const plan = EndpointChange.planEndpointChange(
		makeTrip({ "day-1-end": true, "day-2-start": true }),
		"day-1",
		"end",
		null,
	);
	assert.equal(plan.needsConfirmation, true);
	assert.deepEqual(plan.clearVisitIds.sort(), ["day-1-end", "day-2-start"]);
	// Both sides of the shared boundary move together.
	assert.deepEqual(
		plan.updates.map((u) => u.dayId + ":" + u.which),
		["day-1:end", "day-2:start"],
	);
	assert.ok(plan.updates.every((u) => u.endpoint === null));
});

test("clearing an unchecked endpoint still confirms (destructive) but keeps flags", () => {
	const plan = EndpointChange.planEndpointChange(
		makeTrip({}),
		"day-1",
		"end",
		null,
	);
	assert.equal(
		plan.needsConfirmation,
		true,
		"clearing is always destructive",
	);
	assert.deepEqual(plan.clearVisitIds, ["day-1-end", "day-2-start"]);
	assert.ok(
		plan.updates.every((u) => u.checked === false && u.identityChanged),
	);
});

test("replacing a checked lodging confirms and resets the boundary ticks", () => {
	const plan = EndpointChange.planEndpointChange(
		makeTrip({ "day-1-end": true, "day-2-start": true }),
		"day-1",
		"end",
		{ placeId: "stay-rinkoso" },
	);
	assert.equal(plan.needsConfirmation, true);
	assert.deepEqual(plan.clearVisitIds.sort(), ["day-1-end", "day-2-start"]);
});

test("replacing an unchecked endpoint is a plain edit — no prompt", () => {
	const plan = EndpointChange.planEndpointChange(
		makeTrip({}),
		"day-1",
		"end",
		{ placeId: "stay-rinkoso" },
	);
	assert.equal(plan.needsConfirmation, false);
	assert.deepEqual(plan.clearVisitIds.sort(), ["day-1-end", "day-2-start"]);
});

test("same-identity writes and pin label renames are not identity changes", () => {
	const samePlace = EndpointChange.planEndpointChange(
		makeTrip({ "day-1-end": true }),
		"day-1",
		"end",
		{ placeId: "stay-comfort" },
	);
	assert.equal(samePlace.needsConfirmation, false);
	assert.deepEqual(samePlace.clearVisitIds, []);

	// A pin rename keeps the SAME pin identity on both sides of the boundary.
	const trip = makeTrip({ "day-1-end": true });
	trip.days[0].end = { pin: { label: "Old label", lat: 35.0, lng: 136.0 } };
	trip.days[1].start = { pin: { label: "Old label", lat: 35.0, lng: 136.0 } };
	const rename = EndpointChange.planEndpointChange(trip, "day-1", "end", {
		pin: { label: "New label", lat: 35.0, lng: 136.0 },
	});
	assert.equal(
		rename.needsConfirmation,
		false,
		"label-only rename keeps the tick",
	);
	assert.deepEqual(rename.clearVisitIds, []);
});

test("first-day start and last-day end touch no missing neighbour", () => {
	const first = EndpointChange.planEndpointChange(
		makeTrip({ "day-1-start": true }),
		"day-1",
		"start",
		null,
	);
	assert.deepEqual(
		first.updates.map((u) => u.occurrenceId),
		["day-1-start"],
		"no day-0-end ghost id",
	);
	assert.equal(first.needsConfirmation, true);

	const last = EndpointChange.planEndpointChange(
		makeTrip({ "day-3-end": true }),
		"day-3",
		"end",
		null,
	);
	assert.deepEqual(
		last.updates.map((u) => u.occurrenceId),
		["day-3-end"],
		"no day-4-start ghost id",
	);
	assert.equal(last.needsConfirmation, true);
});

test("a middle start confirms when EITHER side of the boundary is checked", () => {
	const plan = EndpointChange.planEndpointChange(
		makeTrip({ "day-1-end": true }),
		"day-2",
		"start",
		{ placeId: "stay-hana" },
	);
	assert.deepEqual(
		plan.updates.map((u) => u.dayId + ":" + u.which),
		["day-2:start", "day-1:end"],
	);
	assert.equal(plan.needsConfirmation, true, "checked neighbour counts");
});

test("unknown day or field yields no plan", () => {
	assert.equal(
		EndpointChange.planEndpointChange(makeTrip(), "day-9", "end", null),
		null,
	);
	assert.equal(
		EndpointChange.planEndpointChange(makeTrip(), "day-1", "middle", null),
		null,
	);
});
