/* device-pairing.js — 'Pair devices' dialog wiring, self-contained.
 *
 * Extracted from biwa-ride.js so the application controller only ever sees
 * BiwaDevicePairing.init({store, elements, translate, reload, notify}).
 * Personal trips mean two of the owner's devices only share a trip by
 * claiming the same identity: 'Send' mints a code on this device; 'receive'
 * claims one shown elsewhere and reloads under the adopted id so every
 * module reboots cleanly.
 *
 * Pairing is a network-only act that ends by wiping local state, so it is
 * refused — before any fetch — whenever the store reports a block reason
 * (offline, unsaved work, still loading, unsafe storage). Blocked attempts
 * explain themselves through the inline status line AND the shared toast
 * (via notify); they never read as 'invalid code'.
 */
(function (global) {
	"use strict";

	// The elements object last wired — init with the same set is a no-op so
	// a repeated boot can never double-bind the dialog controls.
	var boundElements = null;

	// Store block reason -> the sentence the user should read. Keys are the
	// TripStore.getPairingBlockReason() vocabulary; 'network' covers a real
	// transport failure seen after a request was legitimately attempted.
	var BLOCK_MESSAGES = {
		offline:
			"No connection. Unable to pair devices. Your unsaved changes stay on this phone.",
		network:
			"No connection. Unable to pair devices. Your unsaved changes stay on this phone.",
		unsaved_changes:
			"Your changes are not saved online yet. Wait for them to save before pairing.",
		not_ready: "Wait for the trip to finish loading before pairing.",
		storage_unavailable:
			"Unable to pair because this browser cannot safely store the device identity.",
		rate_limited: "Too many pairing attempts. Try again shortly.",
	};

	// Server verdicts that genuinely mean the code itself failed — anything
	// else is a transport/availability story and gets the generic failure
	// line, never 'invalid code'.
	var CODE_ERRORS = { code_expired: true, bad_code: true };
	var GENERIC_FAILURE = "Unable to pair right now. Try again.";

	// options: {store, elements, translate, reload, notify}
	//   elements: {open, dialog, show, code, codeNote, input, claim,
	//              status, close} — every entry optional; a partial DOM
	//   simply wires what exists.
	//   translate: the app's t() — display strings stay in biwa-i18n.
	//   reload:    how to reboot under the adopted identity (location.reload
	//              in the page, a spy in tests).
	//   notify:    optional shared-toast callback for blocked/failed
	//              attempts — called once per user action, never on dialog
	//              open alone.
	// Returns a truthy handle, or null when there is nothing to drive.
	function init(options) {
		var store = options && options.store;
		var elements = options && options.elements;
		var translate =
			options && options.translate
				? options.translate
				: function (key) {
						return key;
					};
		var reload =
			options && options.reload ? options.reload : function () {};
		var notify =
			options && options.notify ? options.notify : function () {};
		if (!store || !elements) return null;
		if (boundElements === elements) return { wired: true };
		boundElements = elements;

		// Write the inline status line; the aria-live role comes from the
		// markup. Returns the composed message for callers that also toast it.
		function setStatus(message) {
			if (elements.status) elements.status.textContent = message || "";
			return message;
		}

		// A blocked attempt announces once on the status line and once through
		// the shared toast — same words in both so the message is never split.
		function announceBlocked(reason) {
			var message = BLOCK_MESSAGES[reason] || BLOCK_MESSAGES.offline;
			setStatus(translate(message));
			notify(translate(message));
		}

		// A failed (but unblocked) attempt — the wire answered but could not
		// be used. Toasts as well: the user clicked and the answer must land.
		function announceFailed(message) {
			setStatus(translate(message));
			notify(translate(message));
		}

		// Guard shared by both actions: the store knows why pairing is unsafe
		// (offline / unsaved / still loading / storage denied) — check it
		// BEFORE disabling controls or touching the network.
		function pairingBlocked() {
			if (typeof store.getPairingBlockReason !== "function") return null;
			return store.getPairingBlockReason();
		}

		if (elements.open && elements.dialog) {
			elements.open.addEventListener("click", function () {
				setStatus("");
				// Present a known block reason inline on open — no toast until an
				// actual button attempt, so opening the dialog never nags.
				var reason = pairingBlocked();
				if (reason) setStatus(translate(BLOCK_MESSAGES[reason]));
				elements.dialog.showModal();
			});
		}
		if (elements.close && elements.dialog) {
			elements.close.addEventListener("click", function () {
				elements.dialog.close();
			});
		}
		if (elements.show) {
			elements.show.addEventListener("click", function () {
				var reason = pairingBlocked();
				if (reason) {
					announceBlocked(reason);
					return;
				}
				var btn = elements.show;
				btn.disabled = true;
				setStatus(translate("Requesting code…"));
				store.createPairCode().then(function (body) {
					btn.disabled = false;
					// A blocked or transport-level failure is never a code problem —
					// surface the honest reason (and toast it) instead.
					if (body && body.error && BLOCK_MESSAGES[body.error]) {
						announceBlocked(body.error);
						return;
					}
					if (!body || !body.ok || !body.code) {
						setStatus(
							translate("Could not create a code — try again."),
						);
						return;
					}
					setStatus("");
					// Characters get individual spans so letter-spacing can be wide
					// without the trailing space inflating the visual center.
					if (elements.code) {
						elements.code.textContent = body.code
							.split("")
							.join(" ");
						elements.code.hidden = false;
					}
					if (elements.codeNote) elements.codeNote.hidden = false;
				});
			});
		}
		if (elements.claim) {
			elements.claim.addEventListener("click", function () {
				// Guard BEFORE the length check — an offline tap with an empty
				// box is a connection story, never an 'invalid code' story.
				var reason = pairingBlocked();
				if (reason) {
					announceBlocked(reason);
					return;
				}
				var code = elements.input
					? (elements.input.value || "").trim().toUpperCase()
					: "";
				if (code.length !== 6) {
					setStatus(
						translate(
							"That code is invalid or expired — check it and try again.",
						),
					);
					return;
				}
				elements.claim.disabled = true;
				setStatus(translate("Claiming…"));
				store.claimPairCode(code).then(function (body) {
					elements.claim.disabled = false;
					if (body && body.error && BLOCK_MESSAGES[body.error]) {
						announceBlocked(body.error);
						return;
					}
					if (body && body.ok && body.ownerId) {
						// The response was in flight while the user may have edited —
						// re-check the guard before adopting so fresh local work is
						// never wiped by a stale claim.
						var postClaimReason = pairingBlocked();
						if (postClaimReason) {
							announceBlocked(postClaimReason);
							return;
						}
						if (store.adoptOwner(body.ownerId)) {
							setStatus(translate("Trip claimed — reloading…"));
							// A reload reboots every module under the adopted identity —
							// cleaner than patching live state mid-flight.
							reload();
							return;
						}
						// adoptOwner refused (storage write failed) — the identity did
						// not switch, so this is a storage story, not a code story.
						announceBlocked("storage_unavailable");
						return;
					}
					// Only a real code verdict may say 'invalid code' —
					// transport blips and unexpected answers get the honest
					// generic line.
					if (body && body.error && CODE_ERRORS[body.error]) {
						setStatus(
							translate(
								"That code is invalid or expired — check it and try again.",
							),
						);
						return;
					}
					announceFailed(GENERIC_FAILURE);
				});
			});
		}
		return { wired: true };
	}

	var api = { init: init, BLOCK_MESSAGES: BLOCK_MESSAGES };
	if (typeof module !== "undefined" && module.exports) module.exports = api;
	global.BiwaDevicePairing = api;
})(typeof window !== "undefined" ? window : globalThis);
