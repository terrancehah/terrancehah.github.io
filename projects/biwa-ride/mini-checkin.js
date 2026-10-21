/* mini-checkin.js — the mini bar's check-in button feedback lifecycle.
 *
 * The compact "Check in" action owns a staged state machine. A tap begins
 * the saving phase (disabled, aria-busy — the visible text stays
 * "Check in", only the accessible label reports the in-flight write).
 * When the async progress write resolves, a DURABLE ack runs the staged
 * confirmation:
 *
 *   "Check in" lifts away (140ms)  →  the green tick draws itself
 *   (320ms dashoffset sweep)  →  hold (650ms)  →  "Check in" fades back
 *   (220ms)  →  release — the bar may repaint its next target.
 *
 * Any failure resets silently with no tick, and every scheduled step is
 * guarded by the episode token so a cancel/day switch can never flash the
 * wrong stop's confirmation. Under prefers-reduced-motion the same beats
 * collapse to a static green tick held for HOLD_MS.
 *
 * create({button, translate, onRelease, prefersReducedMotion,
 *         setTimeout, clearTimeout})
 *   button      — the check-in <button>; owns .biwa-mini-complete-label
 *                 and .biwa-mini-complete-tick > .biwa-mini-checkmark
 *   translate   — the app's t(), keeps the labels localized
 *   onRelease   — fires once when an episode fully closes so the caller
 *                 can re-render and paint the bar's new target
 *   prefersReducedMotion — boolean or () => boolean seam for tests;
 *                 defaults to the live matchMedia query
 *   timers      — injectable so tests drive the phases deterministically
 */
(function (global) {
	"use strict";

	// The staged confirmation timings after a durable ack — text-exit →
	// drawn tick → hold → restore ≈ 1330ms before the bar may repaint.
	var TIMINGS = {
		TEXT_EXIT_MS: 140,
		DRAW_MS: 320,
		HOLD_MS: 650,
		RESTORE_MS: 220,
	};
	var tokenSeq = 0;

	function create(options) {
		var button = options.button;
		var labelEl = button.querySelector(".biwa-mini-complete-label");
		var tickEl = button.querySelector(".biwa-mini-complete-tick");
		var translate =
			options.translate ||
			function (s) {
				return s;
			};
		var onRelease = options.onRelease || function () {};
		var motionPref = options.prefersReducedMotion;
		var setT = options.setTimeout
			? function (fn, ms) {
					return options.setTimeout(fn, ms);
				}
			: function (fn, ms) {
					return global.setTimeout(fn, ms);
				};
		var clearT = options.clearTimeout
			? function (id) {
					return options.clearTimeout(id);
				}
			: function (id) {
					return global.clearTimeout(id);
				};
		var timers = [];
		var active = null; // {token, phase, name} — null when idle

		function reducedMotion() {
			if (typeof motionPref === "function") return !!motionPref();
			if (typeof motionPref === "boolean") return motionPref;
			return !!(
				global.matchMedia &&
				global.matchMedia("(prefers-reduced-motion: reduce)").matches
			);
		}

		// Every scheduled step re-checks its episode token — a callback
		// from a cancelled or superseded episode must never paint.
		function schedule(fn, ms, token) {
			var id = setT(function () {
				timers = timers.filter(function (x) {
					return x !== id;
				});
				if (active && active.token === token) fn();
			}, ms);
			timers.push(id);
			return id;
		}
		function clearTimers() {
			for (var i = 0; i < timers.length; i++) clearT(timers[i]);
			timers = [];
		}

		// Structural exclusivity — the two faces share the button but are
		// never in the layout together: the tick is `hidden` in every face
		// except the acknowledged one, the label `hidden` inside it.
		function hideTick() {
			if (tickEl) tickEl.setAttribute("hidden", "");
		}
		function showTick() {
			if (tickEl) tickEl.removeAttribute("hidden");
		}
		function hideLabel() {
			if (labelEl) labelEl.setAttribute("hidden", "");
		}
		function showLabel() {
			if (labelEl) labelEl.removeAttribute("hidden");
		}
		// One bounded layout read so the pre-phase computed style is
		// flushed and the next class change actually transitions.
		function flush(el) {
			if (el && typeof el.getBoundingClientRect === "function") {
				el.getBoundingClientRect();
			}
		}

		// Idle face — enabled, "Check in" text only, no phase classes.
		// Every close path ends here; the caller's re-render paints the
		// new target's labels.
		function paintIdle() {
			button.disabled = false;
			button.removeAttribute("aria-busy");
			button.removeAttribute("aria-label");
			button.classList.remove("is-saving");
			button.classList.remove("is-text-exiting");
			button.classList.remove("is-checked");
			button.classList.remove("is-restoring");
			hideTick();
			showLabel();
			if (labelEl) labelEl.textContent = translate("Check in");
		}

		// The acknowledged face — tick ONLY: the label leaves the layout
		// before the tick enters it, and one bounded read pins the
		// un-drawn stroke so the .is-checked dashoffset sweep animates.
		function paintChecked() {
			hideLabel();
			showTick();
			flush(tickEl);
			button.classList.remove("is-saving");
			button.classList.remove("is-text-exiting");
			button.classList.add("is-checked");
			button.removeAttribute("aria-busy");
			if (active.name) {
				button.setAttribute(
					"aria-label",
					translate("Checked in at {name}", { name: active.name }),
				);
			}
		}

		// Close the episode. notify=true means the caller should re-render
		// (success release and failure reset both repaint); cancellation
		// resets the face only — the caller paints its new context itself.
		function release(notify) {
			clearTimers();
			active = null;
			paintIdle();
			if (notify) onRelease();
		}

		return {
			// Start the saving phase — BEFORE the optimistic progress emit,
			// so no render can repaint the bar out from under the feedback.
			// The visible text stays "Check in" (the staged return needs it
			// back anyway); only the accessible label reports the write.
			// Returns a unique token to settle with, or null when an
			// episode is already running (a double tap is a no-op).
			begin: function (context) {
				if (active) return null;
				var token = ++tokenSeq;
				active = {
					token: token,
					phase: "saving",
					name: context && context.name ? context.name : null,
				};
				button.disabled = true;
				button.setAttribute("aria-busy", "true");
				button.setAttribute(
					"aria-label",
					active.name
						? translate("Checking in at {name}", {
								name: active.name,
							})
						: translate("Saving…"),
				);
				button.classList.add("is-saving");
				// Saving keeps the text-only face — the tick stays hidden
				// until (and unless) a durable ack stages it.
				hideTick();
				showLabel();
				if (labelEl) labelEl.textContent = translate("Check in");
				return token;
			},

			// The progress write resolved: 'saved' is always durable, and
			// 'local' only when the caller proved the durable mirror
			// (storage available AND the draft persisted); anything else —
			// error, unavailable, conflict, undurable local — resets with
			// no tick. A stale token (cancelled or superseded) is ignored,
			// and a second settle on the same episode is a no-op — only the
			// 'saving' phase may stage a confirmation.
			settle: function (token, result, durableLocal) {
				if (!active || token !== active.token) return;
				if (active.phase !== "saving") return;
				var durable =
					result === "saved" ||
					(result === "local" && durableLocal === true);
				if (!durable) {
					release(true);
					return;
				}
				// The ack arrived — the write is no longer in flight even
				// though the button stays locked through the whole staging.
				button.removeAttribute("aria-busy");
				if (reducedMotion()) {
					// Static path: the tick appears, holds the same beat,
					// then the idle face returns — no staged animation.
					active.phase = "checked";
					paintChecked();
					schedule(
						function () {
							release(true);
						},
						TIMINGS.HOLD_MS,
						token,
					);
					return;
				}
				// Staged path: "Check in" exits, the tick draws and holds,
				// then the label fades back before release repaints.
				active.phase = "text-exit";
				button.classList.remove("is-saving");
				button.classList.add("is-text-exiting");
				schedule(
					function () {
						active.phase = "checked";
						paintChecked();
						schedule(
							function () {
								active.phase = "restoring";
								// Text-only return: the tick leaves the
								// layout before the label re-enters it
								// (invisible under is-checked), then the
								// phase swap fades it in.
								hideTick();
								showLabel();
								flush(labelEl);
								button.classList.remove("is-checked");
								button.classList.add("is-restoring");
								// The face is returning to "Check in" — the
								// accessible label restores with it.
								if (active.name) {
									button.setAttribute(
										"aria-label",
										translate("Check in at {name}", {
											name: active.name,
										}),
									);
								} else {
									button.removeAttribute("aria-label");
								}
								schedule(
									function () {
										release(true);
									},
									TIMINGS.RESTORE_MS,
									token,
								);
							},
							TIMINGS.DRAW_MS + TIMINGS.HOLD_MS,
							token,
						);
					},
					TIMINGS.TEXT_EXIT_MS,
					token,
				);
			},

			// Retire the episode silently — day switches and superseding
			// renders use it so a late settle hits a dead token and never
			// flashes the new day's target.
			cancel: function () {
				if (!active) return;
				release(false);
			},

			isActive: function () {
				return !!active;
			},

			TIMINGS: TIMINGS,
		};
	}

	var api = { create: create, TIMINGS: TIMINGS };
	if (typeof module !== "undefined" && module.exports) module.exports = api;
	global.BiwaMiniCheckin = api;
})(typeof window !== "undefined" ? window : globalThis);
