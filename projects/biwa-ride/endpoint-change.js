/* endpoint-change.js — pure planner for start/overnight boundary edits.
 *
 * planEndpointChange() turns one UI decision (set, replace or clear a day's
 * start/end) into the complete set of day fields to write, the implicit
 * visit ids that must be retired, and whether the edit is destructive
 * enough to need a confirmation. No DOM, no store, no network — the same
 * plan drives the controller's save and the unit tests.
 *
 * Day boundaries are shared: a day's end IS the next day's start (and a
 * day's start the previous day's end), so one edit always writes both
 * sides of the overnight boundary when the neighbour exists.
 */
(function (global) {
	"use strict";

	var EndpointChange = {};

	// Endpoint identity is the physical place: a placeId, or a pinned
	// coordinate pair. Renaming a pin's label is NOT an identity change —
	// the same physical point keeps its arrival ticks.
	function identityOf(endpoint) {
		if (!endpoint) return null;
		if (endpoint.placeId) return "place:" + endpoint.placeId;
		if (
			endpoint.pin &&
			typeof endpoint.pin.lat === "number" &&
			typeof endpoint.pin.lng === "number"
		) {
			return "pin:" + endpoint.pin.lat + "," + endpoint.pin.lng;
		}
		return null;
	}

	// planEndpointChange(trip, dayId, which, endpoint) →
	//   {
	//     updates: [{dayId, which, endpoint, occurrenceId,
	//                identityChanged, checked}],
	//     clearVisitIds: [occurrenceId, ...],
	//     needsConfirmation: boolean
	//   }
	// or null when the day/which is unknown. `endpoint` is the new value
	// ({placeId} | {pin:{label,lat,lng}} | null to clear).
	EndpointChange.planEndpointChange = function (trip, dayId, which, endpoint) {
		var days = (trip && trip.days) || [];
		var index = -1;
		days.forEach(function (d, i) {
			if (d.dayId === dayId) index = i;
		});
		if (index < 0 || (which !== "start" && which !== "end")) return null;

		// The edit target plus the boundary's other side when a neighbouring
		// day exists — 'end' shares with the next day's start, 'start' with
		// the previous day's end.
		var neighbor = which === "end" ? index + 1 : index - 1;
		var targets = [{ dayIndex: index, which: which }];
		if (days[neighbor]) {
			targets.push({
				dayIndex: neighbor,
				which: which === "end" ? "start" : "end",
			});
		}

		var visit = (trip && trip.visitStatus) || {};
		var nextIdentity = identityOf(endpoint);
		var updates = targets.map(function (t) {
			var day = days[t.dayIndex];
			var current = day[t.which];
			return {
				dayId: day.dayId,
				which: t.which,
				endpoint: endpoint,
				occurrenceId: day.dayId + "-" + t.which,
				identityChanged: identityOf(current) !== nextIdentity,
				checked: visit[day.dayId + "-" + t.which] === true,
			};
		});

		// A changed or cleared destination retires its implicit visit key —
		// leaving it would either write a flag the server validator rejects
		// (no matching occurrence once the endpoint is null) or resurrect a
		// stale arrival tick under a different destination.
		var clearVisitIds = updates
			.filter(function (u) {
				return u.identityChanged;
			})
			.map(function (u) {
				return u.occurrenceId;
			});

		var current = days[index][which];
		var needsConfirmation =
			// Clearing a non-empty endpoint is always destructive.
			(endpoint === null && current != null) ||
			// Replacing a CHECKED boundary resets arrival ticks — confirm.
			updates.some(function (u) {
				return u.identityChanged && u.checked;
			});

		return {
			updates: updates,
			clearVisitIds: clearVisitIds,
			needsConfirmation: needsConfirmation,
		};
	};

	if (typeof module !== "undefined" && module.exports) {
		module.exports = EndpointChange;
	}
	global.BiwaEndpointChange = EndpointChange;
})(typeof window !== "undefined" ? window : globalThis);
