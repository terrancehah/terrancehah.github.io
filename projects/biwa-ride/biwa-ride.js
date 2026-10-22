/* biwa-ride.js — view and event orchestration for the ride companion.
 *
 * Three views: Timeline (the calendar-like day track), Map (all three days
 * routed through Google Routes, markers for every catalogue place) and
 * Nearby (GPS once + straight-line distance). Shared state mutations all go
 * through BiwaTripStore's compare-and-set. Rules in brief: one arrival tick
 * marks the row's visit flag plus every programme family the place belongs
 * to; endpoints are pinned first/last in each day's track; card taps open
 * the destination sheet while the checkbox/handle never do; provider
 * geometry renders only on a real Google Map with attribution; and Google
 * content is transient — never persisted into the trip snapshot.
 */
(function () {
	"use strict";

	var Rules = window.BiwaRules;
	var MapLinks = window.BiwaMapLinks;
	var Preview = window.BiwaRoutePreview;
	var Geo = window.BiwaGeoDistance;
	var I18n = window.BiwaI18n;
	var store = new window.BiwaTripStore();

	// Display-layer helpers with inert fallbacks — the app still renders
	// English when biwa-i18n.js failed to load.
	var t = function (key, vars) {
		var text = I18n ? I18n.t(key, vars) : key;
		if (!I18n && vars) {
			text = text.replace(/\{(\w+)\}/g, function (m, n) {
				return vars[n] !== undefined ? vars[n] : m;
			});
		}
		return text;
	};
	var placeName = function (p) {
		return I18n ? I18n.placeName(p) : p ? p.label : "";
	};
	var dayLabel = function (d) {
		return I18n ? I18n.dayLabel(d) : d ? d.label : "";
	};
	var dayTitle = function (d) {
		return I18n ? I18n.dayTitle(d) : d ? d.title : "";
	};
	// Chips per badge string — 'Official · South' yields programme + shore
	// parts; the no-i18n fallback keeps the combined label on one chip.
	var badgeParts = function (b) {
		return I18n && I18n.badgeParts
			? I18n.badgeParts(b)
			: [{ text: b, programme: b === "Rally" ? "rally" : "official" }];
	};
	var areaText = function (a) {
		return I18n ? I18n.areaLabel(a) : a ? a.label : "";
	};

	var OFFICIAL_CHECKIN_URL = "https://m.biwako1.jp/flow";
	var RALLY_CHECKIN_URL = "https://platinumaps.jp/d/cyclingrally2026";
	var GOOGLE_TERMS_URL = "https://maps.google.com/help/terms_maps/";
	var ROUTE_DEBOUNCE_MS = 800;
	// Dev escape hatch: '?noroute' in the page URL suppresses every Routes
	// request. Road previews can never be cached anywhere (Google terms), so
	// they are the one guaranteed billed call per refresh while iterating
	// locally — '?noroute' makes a reload cost zero provider calls. Days
	// report 'idle', which already renders the honest 'road preview not
	// requested' state.
	var DEV_NO_ROUTES = /[?&]noroute\b/.test(location.search);
	var TOUCH_DRAG_HOLD_MS = 300; // press-and-hold before a touch drag begins
	var TOUCH_DRAG_TOLERANCE_PX = 8; // movement allowed during the hold
	var CLICK_SUPPRESS_MS = 350; // the tap that ends a drag must not open the sheet
	var MAX_DAY_POINTS = 27; // start + end + ≤25 stops (Google Routes cap)

	var els = {};
	var selectedDayId = null; // local per phone — deliberately not shared
	var miniCheckin = null; // the mini bar's check-in feedback lifecycle
	var offlineHandle = null; // the offline-cache module handle (refresh on language switch)
	var mapsNs = undefined; // undefined=not attempted, null=failed, obj=ready
	var mapsKeyAttempted = null; // browser key the last loadMaps call used (or null)
	var mapPage = null; // RoutePreview.createMapPage handle
	var mapInitialised = false;
	var geoPoint = null; // one-shot geolocation, never persisted
	var dialogTrigger = null; // element focus returns to on dialog close
	var sheetTrigger = null; // element focus returns to on sheet close
	var dragState = null; // active pointer/html5 drag bookkeeping
	var suppressClickUntil = 0; // a finished drag must not open the sheet

	// Per-day provider state. Signatures cover the day's routable points only,
	// so checkbox ticks never invalidate a paid route response.
	var dayRoutes = {}; // dayId -> {signature, requestId, status, path, distanceMeters, elevation, error, timer}

	// Transient Google resolutions for null-coordinate places (lodgings,
	// address-only stops). Session memory only — never written to the trip.
	var transientLocations = {}; // placeId -> {lat, lng}
	var placeDetailsCache = {}; // placeId -> normalized details | 'unavailable'

	// Marker type toggles — official checkpoints split per shore area so the
	// map can isolate one coast at a time. Day chips control polylines.
	var mapFilters = {
		"official-south": true,
		"official-east": true,
		"official-north": true,
		"official-west": true,
		rally: true,
		accommodation: true,
		extra: true,
	};
	var dayLineVisible = { "day-1": true, "day-2": true, "day-3": true };

	// --- tiny DOM helper -------------------------------------------------------
	function el(tag, attrs, children) {
		var node = document.createElement(tag);
		if (attrs)
			Object.keys(attrs).forEach(function (k) {
				if (k === "text") node.textContent = attrs[k];
				else if (k === "html") node.innerHTML = attrs[k];
				else if (k === "dataset") Object.assign(node.dataset, attrs[k]);
				else node.setAttribute(k, attrs[k]);
			});
		(children || []).forEach(function (c) {
			node.appendChild(c);
		});
		return node;
	}

	function $(id) {
		return document.getElementById(id);
	}

	// Single source for the reduced-motion check — animations, the leaf
	// burst and the sheet transitions all honour it.
	function prefersReducedMotion() {
		return !!(
			window.matchMedia &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches
		);
	}

	// True while the sheet is in its desktop right-panel layout — the sheet
	// entrance direction depends on which geometry is live.
	function sheetIsDesktop() {
		return !!(
			window.matchMedia && window.matchMedia("(min-width: 56rem)").matches
		);
	}

	// Simple inline SVG icons (no emoji — they render inconsistently and are
	// not translatable style tokens). Names reflect purpose.
	var ICONS = {
		// Flat filled icons — no strokes anywhere. The warning triangle keeps
		// its exclamation by punching the mark out of the solid fill with
		// fill-rule="evenodd", so the hole shows whatever surface is beneath.
		warn: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 3 22 20H2zM11.1 9.6h1.8v4.6h-1.8zM11.1 15.6h1.8v1.8h-1.8z" fill="currentColor" fill-rule="evenodd"/></svg>',
		grip: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="9" cy="6" r="1.6" fill="currentColor"/><circle cx="15" cy="6" r="1.6" fill="currentColor"/><circle cx="9" cy="12" r="1.6" fill="currentColor"/><circle cx="15" cy="12" r="1.6" fill="currentColor"/><circle cx="9" cy="18" r="1.6" fill="currentColor"/><circle cx="15" cy="18" r="1.6" fill="currentColor"/></svg>',
		chev: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9.5 5.5 16 12l-6.5 6.5-2-2L12 12 7.5 7.5z" fill="currentColor"/></svg>',
		stay: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 11 12 4l8 7v8h-5v-5h-6v5H4z" fill="currentColor"/></svg>',
		star: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.5l-5.8 3 1.1-6.5-4.7-4.6 6.5-.9z" fill="currentColor"/></svg>',
	};

	// --- boot -------------------------------------------------------------------
	document.addEventListener("DOMContentLoaded", function () {
		[
			"biwa-masthead-scene",
			"biwa-lang-switch",
			"biwa-progress-strip",
			"biwa-day-selector",
			"biwa-day-title",
			"biwa-next-host",
			"biwa-next-stop",
			"biwa-next-stop-label",
			"biwa-next-stop-name",
			"biwa-next-stop-directions",
			"biwa-next-actions",
			"biwa-next-complete",
			"biwa-next-credit",
			"biwa-next-checkins",
			"biwa-mini-bar",
			"biwa-mini-open",
			"biwa-mini-photo",
			"biwa-mini-name",
			"biwa-mini-tags",
			"biwa-mini-directions",
			"biwa-mini-complete",
			"biwa-mini-complete-label",
			"biwa-leaves",
			"biwa-track",
			"biwa-add-stop",
			"biwa-add-place",
			"biwa-map-canvas",
			"biwa-map-legend",
			"biwa-map-attribution",
			"biwa-day-routes",
			"biwa-nearby-geolocate",
			"biwa-nearby-geo-status",
			"biwa-nearby-anchor-note",
			"biwa-nearby-grid",
			"biwa-parking-card",
			"biwa-parking-list",
			"biwa-sheet",
			"biwa-sheet-body",
			"biwa-sheet-close",
			"biwa-sheet-backdrop",
			"biwa-sheet-actions",
			"biwa-toast",
			"biwa-toast-text",
			"biwa-stop-dialog",
			"biwa-stop-dialog-title",
			"biwa-stop-dialog-body",
			"biwa-stop-dialog-save",
			"biwa-stop-dialog-cancel",
			"biwa-endpoint-dialog",
			"biwa-endpoint-dialog-title",
			"biwa-endpoint-dialog-body",
			"biwa-endpoint-dialog-save",
			"biwa-endpoint-dialog-cancel",
			"biwa-conflict-dialog",
			"biwa-conflict-keep",
			"biwa-conflict-reload",
			"biwa-pair-open",
			"biwa-pair-dialog",
			"biwa-pair-show",
			"biwa-pair-code",
			"biwa-pair-code-note",
			"biwa-pair-input",
			"biwa-pair-claim",
			"biwa-pair-status",
			"biwa-pair-close",
		].forEach(function (id) {
			els[id] = $(id);
		});

		// Saved language (or browser locale) applies to the static chrome
		// before any render so no English flashes on load.
		if (I18n) I18n.setLang(I18n.lang());
		wireNavigation();
		wireStaticControls();
		wireDialogLifecycle();
		wireSheetLifecycle();
		installTrackDrag();
		installCardPress();
		// Offline cache — registers the scoped service worker silently and
		// toasts only on genuine connection transitions (offline, interrupted,
		// restored); a healthy online app stays quiet. No-ops gracefully when
		// service workers or the module are unavailable.
		if (window.BiwaOfflineCache) {
			offlineHandle = window.BiwaOfflineCache.init({
				store: store,
				notify: function (message) {
					showToast(message, 4000);
				},
				translate: t,
			});
		}
		// Welcome-back scroll reads its entry stamp and arms its listeners
		// now; the actual scroll gates on the first render below.
		welcomeBack.init();
		store.onChange(render);
		store.init().then(function () {
			selectedDayId =
				sessionStorage.getItem("biwa-day") ||
				(store.trip && store.trip.days[0] && store.trip.days[0].dayId);
			applyHashView();
			// Boot is settled only after the saved day + hash view apply —
			// earlier emits must not scroll toward the wrong day's row.
			welcomeBack.markBootReady();
			render(store);
		});
	});

	// --- navigation --------------------------------------------------------------
	function wireNavigation() {
		document.querySelectorAll(".biwa-nav-button").forEach(function (btn) {
			btn.addEventListener("click", function () {
				location.hash = "/" + btn.dataset.view;
			});
		});
		window.addEventListener("hashchange", applyHashView);
	}

	function applyHashView() {
		// Retired hashes land on the timeline: stamps folded into it, the ride
		// list IS the timeline.
		var hash = location.hash;
		if (/#\/(ride|stamps)/.test(hash)) {
			hash = "#/timeline";
			history.replaceState(
				null,
				"",
				location.pathname + location.search + hash,
			);
		}
		var match = /#\/(timeline|map|nearby)/.exec(hash);
		var view = match ? match[1] : "timeline";
		document.querySelectorAll(".biwa-view").forEach(function (v) {
			v.classList.toggle("is-active", v.id === "view-" + view);
		});
		document.querySelectorAll(".biwa-nav-button").forEach(function (b) {
			b.setAttribute(
				"aria-current",
				b.dataset.view === view ? "page" : "false",
			);
		});
		if (view === "map") initMapPage();
	}

	function wireStaticControls() {
		els["biwa-add-stop"].addEventListener("click", openAddStopDialog);
		els["biwa-add-place"].addEventListener("click", function () {
			openPlaceDialog(null);
		});
		els["biwa-stop-dialog-cancel"].addEventListener("click", function () {
			els["biwa-stop-dialog"].close();
		});
		els["biwa-endpoint-dialog-cancel"].addEventListener(
			"click",
			function () {
				els["biwa-endpoint-dialog"].close();
			},
		);
		els["biwa-conflict-reload"].addEventListener("click", function () {
			els["biwa-conflict-dialog"].close();
			store.resolveConflictReload();
		});
		els["biwa-conflict-keep"].addEventListener("click", function () {
			els["biwa-conflict-keep"].disabled = true;
			els["biwa-conflict-dialog"].close();
			store.resolveConflictReapply();
		});

		// Device pairing — personal trips mean two of the owner's devices only
		// share a trip by claiming the same identity. The dialog wiring lives
		// in device-pairing.js; the controller hands it the store, its
		// elements, the translator and the reboot (a reload restarts every
		// module under the adopted identity).
		if (window.BiwaDevicePairing) {
			window.BiwaDevicePairing.init({
				store: store,
				elements: {
					open: els["biwa-pair-open"],
					dialog: els["biwa-pair-dialog"],
					show: els["biwa-pair-show"],
					code: els["biwa-pair-code"],
					codeNote: els["biwa-pair-code-note"],
					input: els["biwa-pair-input"],
					claim: els["biwa-pair-claim"],
					status: els["biwa-pair-status"],
					close: els["biwa-pair-close"],
				},
				translate: t,
				reload: function () {
					location.reload();
				},
				// Blocked/failed pairing attempts ride the shared toast —
				// the notice tone keeps the success checkmark out of it.
				notify: function (message) {
					showToast(message, 4000, "notice");
				},
			});
		}
		els["biwa-nearby-geolocate"].addEventListener(
			"click",
			updateMyLocation,
		);
		// Language switch: pick a segment to set the language, then repaint
		// every dynamic view through the normal render path (static markup
		// re-applies inside setLang itself).
		els["biwa-lang-switch"].addEventListener("click", function (ev) {
			var btn = ev.target.closest(".biwa-lang-option");
			if (!I18n || !btn) return;
			I18n.setLang(btn.getAttribute("data-lang"));
			render(store);
			// Re-evaluate the connectivity episode after the switch — a pending
			// transition toast, if any, uses the new language when it fires.
			if (offlineHandle) offlineHandle.refresh();
		});

		// Masthead scene — the decorative header art owns its own observers,
		// tree layout and motion gating in masthead-scene.js; the controller
		// only hands it the scene element. init() is idempotent.
		if (window.BiwaMastheadScene) {
			window.BiwaMastheadScene.init(els["biwa-masthead-scene"]);
		}

		// Up-next card: the whole card opens the CURRENT next point's sheet,
		// except its interactive children (name button, directions link,
		// completion button, credit link) which keep their own actions.
		els["biwa-next-stop"].addEventListener("click", function (ev) {
			if (ev.target.closest("button, a, input, select, textarea")) return;
			openNextStopSheet();
		});
		els["biwa-next-stop-name"].addEventListener("click", openNextStopSheet);
		els["biwa-next-complete"].addEventListener("click", completeNextStop);
		// The mini bar reuses the exact same actions — its body opens the
		// sheet, its tick completes the same live-resolved next stop.
		els["biwa-mini-open"].addEventListener("click", openNextStopSheet);
		els["biwa-mini-complete"].addEventListener("click", completeNextStop);
		// aria-disabled alone can't stop Enter activating a link — the
		// check-in episode also cancels the click outright while it runs.
		els["biwa-mini-directions"].addEventListener("click", function (ev) {
			if (miniCheckin && miniCheckin.isActive()) ev.preventDefault();
		});
		// The mini check-in button owns a saving → green-tick phase machine —
		// every released episode re-renders through the normal path so the
		// bar paints whatever stop is next then.
		if (window.BiwaMiniCheckin) {
			miniCheckin = window.BiwaMiniCheckin.create({
				button: els["biwa-mini-complete"],
				translate: t,
				onRelease: function () {
					unlockMini();
					render(store);
				},
			});
		}
		// A failed thumbnail collapses back to the tinted slot — the bar
		// keeps its height and never flashes a broken image.
		els["biwa-mini-photo"].addEventListener("error", function () {
			els["biwa-mini-photo"].hidden = true;
		});
	}

	// Tick the CURRENT next stop — resolved live at click time so a poll
	// that advanced the trip since the last paint still lands correctly.
	// Shared by the Up Next card and the mini bar.
	// While the check-in feedback owns the mini bar, its other controls
	// must not navigate to the (possibly just completed) stop.
	function lockMini() {
		els["biwa-mini-bar"].classList.add("is-checking-in");
		els["biwa-mini-open"].disabled = true;
		els["biwa-mini-directions"].setAttribute("aria-disabled", "true");
	}
	function unlockMini() {
		els["biwa-mini-bar"].classList.remove("is-checking-in");
		els["biwa-mini-open"].disabled = false;
		els["biwa-mini-directions"].removeAttribute("aria-disabled");
	}

	function completeNextStop(ev) {
		if (store._saving) return;
		var day = currentDay(store.trip);
		var next = day && Rules.nextUnvisitedStop(store.trip, day);
		if (!next) return;
		var occurrenceId = next.occurrenceId;
		var placeId = next.placeId;
		// The mini button gets its own saving→green-tick feedback: begin runs
		// BEFORE the optimistic progress emit so no repaint can move the bar
		// out from under it, and a second tap while active is ignored.
		var fromMini = !!(ev && ev.currentTarget === els["biwa-mini-complete"]);
		var miniToken = null;
		if (fromMini && miniCheckin) {
			if (miniCheckin.isActive()) return;
			miniToken = miniCheckin.begin({
				name: next.place ? placeName(next.place) : next.label,
			});
			lockMini();
		}
		// Progress write — the local mirror updates instantly; the result
		// resolves once the personal doc write lands (or 'local' when the
		// backend is down).
		var resultP = store.applyLocalProgress(function (draft) {
			var p = placeId
				? (store.trip.places || []).filter(function (x) {
						return x.placeId === placeId;
					})[0] || next.place
				: null;
			Rules.applyArrival(draft, occurrenceId, p, true);
		});
		// The pill confirms only a durable tick — a failed local write
		// stays silent rather than flashing success.
		resultP.then(function (result) {
			checkinSaved(result, next.place ? placeName(next.place) : null);
			if (miniToken !== null) {
				// 'local' only counts when the local mirror is provably durable —
				// an undurable buffer gets no green tick.
				miniCheckin.settle(
					miniToken,
					result,
					store.storageAvailable === true &&
						store.draftPersisted === true,
				);
			}
		});
		// Same celebration gate as the row/sheet ticks: once, only while the
		// timeline view (which owns the leaf layer) is active.
		if (
			document
				.getElementById("view-timeline")
				.classList.contains("is-active")
		) {
			burstLeaves();
		}
	}

	// Open the sheet for whatever is next right now. Pin endpoints have no
	// place record — the same display-only stand-in the track rows use.
	function openNextStopSheet() {
		var day = currentDay(store.trip);
		var next = day && Rules.nextUnvisitedStop(store.trip, day);
		if (!next) return;
		var place = next.place || {
			placeId: null,
			label: next.label,
			programmes: [],
			category: "pin",
			lat: next.lat,
			lng: next.lng,
		};
		openSheet({
			place: place,
			occurrenceId: next.occurrenceId,
			day: day,
			kind: next.kind,
		});
	}

	// Dialogs clear the editor flag on ANY close path (buttons, Escape) and
	// return focus to the control that opened them — keyboard users must never
	// lose their place to a re-render or a stray dismissal.
	function wireDialogLifecycle() {
		[
			"biwa-stop-dialog",
			"biwa-endpoint-dialog",
			"biwa-conflict-dialog",
		].forEach(function (id) {
			var dialog = els[id];
			dialog.addEventListener("close", function () {
				store.setEditorActive(false);
				if (dialogTrigger && document.contains(dialogTrigger)) {
					dialogTrigger.focus();
					dialogTrigger = null;
				}
			});
			dialog.addEventListener("cancel", function () {
				dialog.close();
			});
		});
	}

	// --- focus/disclosure preservation ---------------------------------------------
	// Re-rendering lists on every save/poll would steal keyboard focus and
	// collapse open details. Capture a stable key for the focused control and
	// the set of open <details> before rebuilding; restore afterwards.
	function captureUiState() {
		var active = document.activeElement;
		return {
			focusKey: active && active.dataset ? active.dataset.focusKey : null,
			openDetails: Array.prototype.map.call(
				document.querySelectorAll("details[data-dkey][open]"),
				function (d) {
					return d.dataset.dkey;
				},
			),
		};
	}

	function restoreUiState(snapshot) {
		if (!snapshot) return;
		snapshot.openDetails.forEach(function (key) {
			var d = document.querySelector('details[data-dkey="' + key + '"]');
			if (d) d.open = true;
		});
		if (snapshot.focusKey) {
			var target = document.querySelector(
				'[data-focus-key="' + snapshot.focusKey + '"]',
			);
			if (target) target.focus();
		}
	}

	// --- render root -------------------------------------------------------------
	function render(s) {
		if (!s.trip) return;
		var ui = captureUiState();
		renderProgressStrip(s.trip);
		renderDayTabs(s.trip);
		renderTimeline(s.trip);
		renderNearby(s.trip);
		// The map page guards its own init cost: calling it on every render is
		// cheap while dormant, and lets a browser key that arrived after a
		// keyless first visit retry the loader once.
		if (
			document.getElementById("view-map").classList.contains("is-active")
		) {
			initMapPage();
		}
		if (isSheetOpen()) {
			renderSheetBody();
			// Capabilities may have landed after the sheet opened — re-ask (a
			// no-op while this place's fetch is already cached or in-flight).
			if (sheetContext && sheetContext.place)
				maybeFetchDetails(sheetContext.place);
		}
		restoreUiState(ui);
		maybeShowConflict(s);
		// Welcome-back scroll requests its one frame here, at the very end —
		// rows, view and conflict state are all final for this render.
		welcomeBack.maybe();
	}

	// No connection indicator or banners by design — a healthy shared app
	// stays quiet. Unsent edits keep their internal pendingDraft recovery in
	// the store; the ONLY surfaced state is the explicit conflict dialog.

	function maybeShowConflict(s) {
		if (s.conflict && !els["biwa-conflict-dialog"].open) {
			dialogTrigger = document.activeElement;
			els["biwa-conflict-keep"].disabled = false;
			els["biwa-conflict-dialog"].showModal();
			store.setEditorActive(true);
		}
	}

	// --- welcome-back scroll ------------------------------------------------------
	// A coarse "came back after being away" affordance: on a cold open, or on
	// a return after >=5 minutes away, the first timeline render scrolls the
	// live target row's card to just under the top margin. It fires at most
	// once per eligible entry — polls, photo paints, check-ins and day
	// switches never re-arm it — and any user input before the frame runs
	// cancels it outright.
	// WELCOME_SCROLL_BEGIN — extracted verbatim by
	// tests/biwa-ride/welcome-scroll.test.js; keep this IIFE self-contained:
	// it may only reach the module deps named inside (els, store,
	// isSheetOpen, prefersReducedMotion, miniCheckin, touchDrag).
	var welcomeBack = (function () {
		var KEY = "biwa:v2:last-active-at";
		var AWAY_MS = 5 * 60 * 1000;
		var WRITE_THROTTLE_MS = 10 * 1000;
		var TOP_MARGIN = 16;
		var bootReady = false; // first render has applied hash view + day
		var pending = false; // an eligible entry waiting for its frame
		var scheduled = false; // at most one requestAnimationFrame in flight
		var awayAt = null; // in-memory departure stamp (visibility/pagehide)
		var lastWrite = 0; // interaction-write throttle marker

		function now() {
			return Date.now();
		}
		function readStamp() {
			try {
				var v = Number(localStorage.getItem(KEY));
				return Number.isFinite(v) && v > 0 ? v : null;
			} catch (e) {
				return null; // storage blocked — in-memory tracking still works
			}
		}
		function writeStamp() {
			var t = now();
			lastWrite = t;
			try {
				localStorage.setItem(KEY, String(t));
			} catch (e) {}
		}
		function throttledWrite() {
			if (now() - lastWrite > WRITE_THROTTLE_MS) writeStamp();
		}
		function isShown(el) {
			return !!(
				el &&
				!el.hidden &&
				window.getComputedStyle(el).display !== "none"
			);
		}
		// The lowest floating control bounds the "fully visible" test — a
		// card tucked under the mini bar or bottom nav counts as NOT
		// visible. Only a FIXED nav occludes: on desktop it becomes a
		// sticky sidebar and must not clamp the viewport.
		function usableBottom() {
			var mini = els["biwa-mini-bar"];
			if (isShown(mini)) return mini.getBoundingClientRect().top;
			var nav = document.querySelector(".biwa-nav");
			if (
				isShown(nav) &&
				window.getComputedStyle(nav).position === "fixed"
			)
				return nav.getBoundingClientRect().top;
			return window.innerHeight;
		}
		function alreadyVisible(card) {
			var rect = card.getBoundingClientRect();
			var bottom = usableBottom();
			return (
				rect.top >= TOP_MARGIN &&
				rect.top + Math.min(rect.height, bottom - TOP_MARGIN) <= bottom
			);
		}
		// Interactive states win over the scroll: any open dialog or sheet,
		// an editor, an in-flight drag or a running mini check-in consumes
		// the attempt rather than deferring it.
		function blocked() {
			return !!(
				document.querySelector("dialog[open]") ||
				isSheetOpen() ||
				(store && store.editorActive) ||
				touchDrag ||
				document.querySelector("[data-dragging]") ||
				(miniCheckin && miniCheckin.isActive())
			);
		}
		function onTimeline() {
			var v = document.getElementById("view-timeline");
			return !!(v && v.classList.contains("is-active"));
		}
		function maybeScroll() {
			if (!pending || !bootReady || scheduled) return;
			scheduled = true;
			requestAnimationFrame(function () {
				scheduled = false;
				if (!pending) return; // user input cancelled meanwhile
				pending = false; // one attempt per entry — spent either way
				if (
					document.visibilityState === "hidden" ||
					!onTimeline() ||
					blocked()
				)
					return;
				var card = document.querySelector(
					'.biwa-track-row[data-current="true"] .biwa-stop-card',
				);
				if (!card || alreadyVisible(card)) return;
				var rect = card.getBoundingClientRect();
				window.scrollTo({
					top: Math.max(0, window.scrollY + rect.top - TOP_MARGIN),
					behavior: prefersReducedMotion() ? "instant" : "smooth",
				});
			});
		}
		// Departure stamps the clock once — duplicate exits must not move it.
		function depart() {
			if (awayAt !== null) return;
			awayAt = now();
			writeStamp();
		}
		// Resume only from a real recorded absence AND a visible document:
		// a focus/pageshow that lands while still hidden must keep the
		// away stamp for the genuine visible event, or the absence time is
		// lost. A cold pageshow or a duplicate resume is a no-op.
		function resume() {
			if (awayAt === null || document.visibilityState !== "visible")
				return;
			var age = now() - awayAt;
			awayAt = null;
			writeStamp();
			if (age >= AWAY_MS) {
				pending = true;
				maybeScroll();
			}
		}
		function onInput() {
			pending = false; // user-driven — never scroll out from under them
			throttledWrite();
		}
		function init() {
			var stamp = readStamp();
			// Missing/invalid stamp = first visit (eligible); a stamp younger
			// than the away window means a quick reload or a sibling tab —
			// preserve position instead.
			pending = !stamp || now() - stamp >= AWAY_MS;
			writeStamp();
			document.addEventListener("visibilitychange", function () {
				if (document.visibilityState === "hidden") depart();
				else resume();
			});
			window.addEventListener("pagehide", depart);
			window.addEventListener("pageshow", resume);
			window.addEventListener("blur", depart);
			window.addEventListener("focus", resume);
			["pointerdown", "touchstart", "wheel", "keydown"].forEach(
				function (type) {
					window.addEventListener(type, onInput, { passive: true });
				},
			);
		}
		function markBootReady() {
			bootReady = true;
		}
		return {
			init: init,
			markBootReady: markBootReady,
			maybe: maybeScroll,
		};
	})();
	// WELCOME_SCROLL_END

	// --- day selector -------------------------------------------------------------
	function currentDay(trip) {
		var day = (trip.days || []).filter(function (d) {
			return d.dayId === selectedDayId;
		})[0];
		return day || trip.days[0];
	}

	function renderDayTabs(trip) {
		var host = els["biwa-day-selector"];
		host.innerHTML = "";
		(trip.days || []).forEach(function (day) {
			var btn = el("button", {
				class: "biwa-day-tab",
				type: "button",
				"aria-pressed": String(day.dayId === currentDay(trip).dayId),
				"data-focus-key": "day-" + day.dayId,
				text: dayLabel(day),
			});
			btn.addEventListener("click", function () {
				selectedDayId = day.dayId;
				sessionStorage.setItem("biwa-day", day.dayId);
				// A day switch retires any in-flight mini check-in — the stale
				// token keeps its settle ignored, so the new day's bar can never
				// flash the old stop's tick.
				if (miniCheckin && miniCheckin.isActive()) {
					miniCheckin.cancel();
					unlockMini();
				}
				render(store);
			});
			host.appendChild(btn);
		});
		var day = currentDay(trip);
		els["biwa-day-title"].textContent =
			dayLabel(day) + (dayTitle(day) ? " — " + dayTitle(day) : "");
	}

	// --- certificate progress strip ------------------------------------------------
	// Emphasis block: two certificate counts (large numeral, small label,
	// progress bar) on plain paper — the photo backdrop lives on the up-next
	// card instead, so this strip never fetches or holds provider imagery.
	function renderProgressStrip(trip) {
		var host = els["biwa-progress-strip"];
		var rally = Rules.rallyProgress(trip);
		var official = Rules.officialAreaProgress(trip);
		var checklist = Rules.groupChecklist(trip);

		if (!host.querySelector(".biwa-progress-content")) {
			host.appendChild(el("div", { class: "biwa-progress-content" }));
		}
		// Counts repaint every render.
		var content = host.querySelector(".biwa-progress-content");
		content.innerHTML = "";
		[
			{
				label: t("rally stops"),
				done: rally.done,
				total: rally.total,
				complete: rally.complete,
			},
			{
				label: t("official areas"),
				done: official.coveredCount,
				total: official.totalAreas,
				complete: official.complete,
			},
		].forEach(function (item) {
			var pct = item.total
				? Math.round((item.done / item.total) * 100)
				: 0;
			content.appendChild(
				el(
					"span",
					{
						class: "biwa-progress-metric",
						dataset: { done: String(item.complete) },
					},
					[
						el("span", { class: "biwa-progress-summary" }, [
							el("span", {
								class: "biwa-progress-num",
								text: String(item.done),
							}),
							el("span", {
								class: "biwa-progress-label",
								text: t("of {total} {label}", {
									total: item.total,
									label: item.label,
								}),
							}),
						]),
						el("span", { class: "biwa-progress-bar" }, [
							el("span", { style: "width:" + pct + "%" }),
						]),
					],
				),
			);
		});
		// Certificate wording stays honest: the shared checklist completing is
		// not the same as an official certificate being earned.
		if (checklist.complete) {
			content.appendChild(
				el("span", {
					class: "biwa-progress-complete",
					text: t("Both certificate checklists completed"),
				}),
			);
		}
		// Itinerary completion is a separate fact, driven by the arrival ticks
		// on the days themselves — never by the certificate checklist.
		if (tripFinished(trip)) {
			content.appendChild(
				el("span", {
					class: "biwa-progress-complete",
					text: t("All three riding days completed"),
				}),
			);
		}
	}

	// A riding day is finished only when it genuinely has an itinerary —
	// both endpoints set and at least one row — and every row (stops AND
	// endpoints) is manually ticked. Rules.groupChecklist tracks the two
	// certificate programmes and must never stand in for itinerary state.
	function dayFinished(trip, day) {
		if (!day || !day.start || !day.end) return false;
		// Hidden route-waypoint anchors never count as rows to tick.
		var points = Rules.visibleDayPoints(trip, day);
		return (
			points.length > 0 &&
			points.every(function (p) {
				return p.visited;
			})
		);
	}

	// The ride is complete when all three seeded days are finished.
	function tripFinished(trip) {
		var days = (trip && trip.days) || [];
		return (
			days.length === 3 &&
			days.every(function (d) {
				return dayFinished(trip, d);
			})
		);
	}

	// --- timeline view ---------------------------------------------------------------
	function renderTimeline(trip) {
		var day = currentDay(trip);
		if (!day) return;
		renderNextCard(trip, day);
		renderTrack(trip, day);
	}

	// Programme-family card tint, ordered so the louder semantic wins:
	// accommodation first, a place in both programmes reads 'shared', then
	// rally/official, and everything else is a plain extra stop. Painted as
	// data-card-type on cards and the sheet root.
	function placeCardType(place) {
		if (!place) return "extra";
		if (place.category === "accommodation") return "accommodation";
		var fams = Rules.programmeFamilies(place.programmes);
		var rally = fams.indexOf("rally") !== -1;
		var official = fams.indexOf("official") !== -1;
		if (rally && official) return "shared";
		if (rally) return "rally";
		if (official) return "official";
		return "extra";
	}

	// Up-next card: the day's next unvisited stop carries a blurred backdrop
	// of its own Google photo when available (plain warm surface otherwise —
	// a finished day shows no image, not another place's). The photo layer is
	// keyed by placeId and only rebuilt when the chosen place changes, so
	// poll re-renders update the text without reloading the image. Every
	// text slot is permanent and height-reserved in the markup, so async
	// photos, credits and completion copy never shift the card's size.
	var nextChosenId = null; // placeId whose photo the card wants now
	var nextPhotoKey = null; // placeId whose photo layer is painted
	var nextPhotoFailed = null; // placeId whose photo URL failed — no retry loop
	var nextPhotoLoading = false; // a painted img still waiting on load/error

	// Paints the backdrop img + veil behind the content wrapper and binds
	// failure back to the plain card: a dead photo URL removes the whole
	// photo layer (img, veil, the has-photo flag) and is remembered per
	// place so polling does not keep re-requesting it — a different chosen
	// place still gets its own attempt.
	function paintNextPhoto(card, photo) {
		var key = nextChosenId;
		var img = el("img", {
			class: "biwa-next-photo",
			"aria-hidden": "true",
			alt: "",
			src: store.photoUrl(key, photo.index, 800),
		});
		nextPhotoLoading = true;
		img.addEventListener("load", function () {
			if (key !== nextPhotoKey) return;
			nextPhotoLoading = false;
			card.classList.remove("is-loading");
		});
		img.addEventListener("error", function () {
			// A rebuilt layer means this img belongs to a place we already left —
			// leave the new layer's own veil alone.
			if (key !== nextPhotoKey) return;
			nextPhotoLoading = false;
			if (img.parentNode) img.parentNode.removeChild(img);
			var veil = card.querySelector(".biwa-next-veil");
			if (veil) veil.parentNode.removeChild(veil);
			// The credit slot is permanent — a failed photo clears its content,
			// not the node, so the reserved height never collapses.
			var cred = els["biwa-next-credit"];
			if (cred) {
				cred.innerHTML = "";
				cred.removeAttribute("title");
			}
			card.classList.remove("has-photo");
			card.classList.remove("is-loading");
			nextPhotoFailed = key;
		});
		card.insertBefore(img, card.firstChild);
		// Strong opaque fade — ink text must stay AA over the image.
		card.insertBefore(
			el("div", { class: "biwa-next-veil", "aria-hidden": "true" }),
			card.firstChild.nextSibling,
		);
		card.classList.add("has-photo");
		card.classList.add("is-loading");
	}

	function renderNextCard(trip, day) {
		var points = Rules.visibleDayPoints(trip, day);
		var next = Rules.nextUnvisitedStop(trip, day);
		var nextCard = els["biwa-next-stop"];
		var labelEl = els["biwa-next-stop-label"];
		var nameEl = els["biwa-next-stop-name"];
		var dirEl = els["biwa-next-stop-directions"];
		var compEl = els["biwa-next-complete"];
		nextCard.hidden = false;

		// Trip completion overrides the selected day's state; within a day the
		// order is finished → empty → active. Both action buttons hide via
		// visibility — never display — so the reserved row keeps its height,
		// and the name button disables so a completion state opens no sheet.
		var actionsVisible = false;
		if (tripFinished(trip)) {
			labelEl.textContent = t("Ride Complete");
			nameEl.textContent = t(
				"Three days around Lake Biwa — every planned stop completed.",
			);
			dirEl.removeAttribute("href");
			nextCard.dataset.cardType = "completed";
		} else if (dayFinished(trip, day)) {
			labelEl.textContent = t("{day} Complete", { day: dayLabel(day) });
			nameEl.textContent =
				day.dayId === "day-3"
					? t("Day 3 complete. You’re back in Otsu.")
					: t("Every stop visited. Time to rest and recharge.");
			dirEl.removeAttribute("href");
			nextCard.dataset.cardType = "completed";
		} else if (!points.length) {
			labelEl.textContent = t("Your itinerary");
			nameEl.textContent = t("No stops planned for this day yet");
			dirEl.removeAttribute("href");
			nextCard.dataset.cardType = "extra";
		} else if (!next) {
			// Rows exist and are all ticked, but an endpoint is unset — the day
			// is not finished (dayFinished needs both endpoints) yet has no next
			// stop either. Say so instead of falling through to next.label.
			labelEl.textContent = t("Finish your day plan");
			nameEl.textContent = t(
				"Set the missing start or finish point to complete this day.",
			);
			dirEl.removeAttribute("href");
			nextCard.dataset.cardType = "extra";
		} else {
			labelEl.textContent = t("Up Next");
			nameEl.textContent = placeName(next);
			dirEl.href = MapLinks.directionsUrl(next);
			// Paint the canonical action name — the static fallback can't
			// drift (or hold a stale language) across re-renders.
			dirEl.textContent = t("Navigate");
			actionsVisible = true;
			nextCard.dataset.cardType = placeCardType(next.place);
		}
		// Fallback states hide the whole action cluster outright — nothing
		// reserves phantom rows in the compact status card.
		els["biwa-next-actions"].hidden = !actionsVisible;
		els["biwa-next-checkins"].hidden = !actionsVisible;
		compEl.disabled = !actionsVisible;
		nameEl.disabled = !actionsVisible;
		// The action label matches the mini bar's completion wording — one
		// verb for the same write, in either slot.
		compEl.textContent = t("Mark as Completed");
		// Only a live next stop makes the card a sheet-opener — static
		// finished/empty states keep the plain card surface, no interactive
		// shadow.
		nextCard.dataset.interactive = actionsVisible ? "true" : "false";
		// The full text stays reachable on the title attribute.
		nameEl.title = nameEl.textContent;

		// Programme check-in links apply to the live next stop only —
		// finished/empty/missing states hide the row entirely.
		renderNextCheckins(
			els["biwa-next-checkins"],
			actionsVisible && next ? next.place : null,
		);

		// Photo backdrop: the next unvisited stop's own place only — a day with
		// nothing left to visit intentionally gets no image.
		var chosen =
			next && !dayFinished(trip, day) && !tripFinished(trip)
				? next.place
				: null;
		nextChosenId = chosen && chosen.placeId ? chosen.placeId : null;
		// Ask for the chosen place's details once per session (the shared
		// sheet fetch path — capability-gated, never a bulk prefetch).
		if (chosen) maybeFetchDetails(chosen);

		var details = nextChosenId ? placeDetailsCache[nextChosenId] : null;
		var photo =
			nextChosenId !== nextPhotoFailed &&
			details &&
			details !== "loading" &&
			details !== "unavailable" &&
			details.photos &&
			details.photos.length
				? details.photos[0]
				: null;

		// Rebuild the photo layer only when the chosen place actually changed.
		// The photo BACKDROP is retired (timeline visuals stripped to flat
		// surfaces) — paintNextPhoto stays intact but is no longer invoked;
		// the resolved photo still feeds the mini thumbnail and the credit
		// below. A restore needs the two commented paintNextPhoto calls plus
		// a revisit of the dormant .biwa-next-photo/-veil/-skeleton rules —
		// the permanent credit slot they were sized around is gone.
		if (nextPhotoKey !== nextChosenId) {
			nextPhotoKey = nextChosenId;
			nextPhotoLoading = false;
			var stale = nextCard.querySelectorAll(
				".biwa-next-photo, .biwa-next-veil",
			);
			for (var i = 0; i < stale.length; i++) {
				stale[i].parentNode.removeChild(stale[i]);
			}
			nextCard.classList.remove("has-photo");
			// if (photo) paintNextPhoto(nextCard, photo);
		} else if (photo && !nextCard.classList.contains("has-photo")) {
			// Same place — its photo arrived after the first paint.
			// paintNextPhoto(nextCard, photo);
		}
		// is-loading marks either a pending details fetch or a painted image
		// still on its way — the skeleton credit rides on this flag.
		nextCard.classList.toggle(
			"is-loading",
			(nextChosenId && details === "loading") || nextPhotoLoading,
		);

		// Provider attribution stays REQUIRED while a Google photo is on
		// screen — the backdrop is gone but the mini bar still shows the same
		// resolved photo, so the active panel carries the credit. With no
		// photo the slot collapses entirely (no phantom reserved strip).
		var creditEl = els["biwa-next-credit"];
		creditEl.innerHTML = "";
		creditEl.removeAttribute("title");
		creditEl.hidden = !photo;
		if (photo) {
			var names = [];
			(photo.authorAttributions || []).forEach(function (a) {
				if (a.displayName && names.indexOf(a.displayName) === -1)
					names.push(a.displayName);
			});
			var text = t("Photo © {names} via ", {
				names: names.length
					? names.join(", ")
					: t("Google contributors"),
			});
			creditEl.title = text + "Google Maps";
			creditEl.appendChild(document.createTextNode(text));
			creditEl.appendChild(
				el("a", {
					href: details.mapsUrl || "https://www.google.com/maps",
					target: "_blank",
					rel: "noopener noreferrer",
					text: "Google Maps",
				}),
			);
		}

		// Mini bar mirror — the same live next stop, painted from the same
		// resolved values (never re-derived, so card and bar can't disagree).
		// It only exists while a real stop is up next; every finished/empty
		// state hides it rather than showing a dead strip.
		var mini = els["biwa-mini-bar"];
		if (mini) {
			// While the check-in feedback runs the bar is FROZEN: still on
			// screen (even when its stop was the last one), but nothing
			// repaints — the settled tick stays put until release.
			var miniBusy = !!(miniCheckin && miniCheckin.isActive());
			var miniLive = !!(actionsVisible && next) || miniBusy;
			mini.hidden = !miniLive;
			// The live flag lets CSS lift the shell's bottom padding and the
			// toast above the bar only while it is actually on screen.
			document.body.classList.toggle("biwa-mini-live", miniLive);
			if (miniLive && !miniBusy) {
				els["biwa-mini-name"].textContent = placeName(next);
				els["biwa-mini-open"].setAttribute(
					"aria-label",
					t("{name} — details", { name: placeName(next) }),
				);
				els["biwa-mini-directions"].href = dirEl.href;
				var dirLabel = t("Navigate to {name}", {
					name: placeName(next),
				});
				els["biwa-mini-directions"].setAttribute(
					"aria-label",
					dirLabel,
				);
				els["biwa-mini-directions"].title = dirLabel;
				els["biwa-mini-complete"].setAttribute(
					"aria-label",
					t("Mark {name} as completed", { name: placeName(next) }),
				);
				// Idle re-paint keeps the translated label fresh across language
				// switches — while busy the module's label owns the button.
				els["biwa-mini-complete-label"].textContent =
					t("Mark as Completed");
				var miniTags = els["biwa-mini-tags"];
				miniTags.innerHTML = "";
				placeBadgesNodes(next.place).forEach(function (n) {
					miniTags.appendChild(n);
				});
				// Small-square thumbnail — requests the SAME 800px asset the card
				// backdrop already fetched, so the bar adds no second billed photo
				// call (each width is a separate media request upstream; the
				// browser and server caches both key on it).
				var miniImg = els["biwa-mini-photo"];
				if (photo) {
					miniImg.src = store.photoUrl(
						nextChosenId,
						photo.index,
						800,
					);
					miniImg.hidden = false;
				} else {
					miniImg.hidden = true;
					miniImg.removeAttribute("src");
				}
			}
		}
	}

	// Programme check-in links ride the CURRENT next stop only — a stop can
	// belong to the official certificate, the rally, both (e.g. Mizudori) or
	// neither. The row is permanent: an inapplicable state leaves an inert
	// visibility-hidden slot so the card height never moves.
	function renderNextCheckins(host, place) {
		host.innerHTML = "";
		var programmes = (place && place.programmes) || [];
		var official = programmes.some(function (p) {
			return p.indexOf("official-") === 0;
		});
		var rally = programmes.indexOf("rally") !== -1;
		// One label per programme site regardless of membership count — the
		// action is the same hand-off on a shared (dual) stop.
		if (official) {
			host.appendChild(
				el("a", {
					class: "biwa-btn biwa-btn-secondary biwa-next-checkin",
					href: OFFICIAL_CHECKIN_URL,
					target: "_blank",
					rel: "noopener noreferrer",
					text: t("Check In on Official Site"),
				}),
			);
		}
		if (rally) {
			host.appendChild(
				el("a", {
					class: "biwa-btn biwa-btn-secondary biwa-next-checkin",
					href: RALLY_CHECKIN_URL,
					target: "_blank",
					rel: "noopener noreferrer",
					text: t("Check In on Rally Site"),
				}),
			);
		}
		// No programmes → the host stays empty and collapses outright — the
		// panel never reserves phantom rows for links that don't apply.
	}

	// The vertical track: start endpoint, stops in order, end endpoint.
	// Endpoint rows are fixed (never draggable); stop rows carry the handle.
	function renderTrack(trip, day) {
		var list = els["biwa-track"];
		var nextCard = els["biwa-next-stop"];
		var nextHost = els["biwa-next-host"];
		// Reparenting can blur a focused control — remember which stable
		// panel control (Navigate / Mark as Completed / a programme link)
		// owns focus
		// before the move so the rebuild can hand it back. Nothing outside
		// the panel is stable across a re-render, and focus elsewhere must
		// never be stolen.
		var nextCardFocus =
			nextCard && nextCard.contains(document.activeElement)
				? document.activeElement
				: null;
		// The stable next-stop panel may live inside the current row — lift
		// it back into its permanent host BEFORE the rows are torn down, so
		// the innerHTML clear can never discard the node or its listeners.
		if (nextCard && nextHost && !nextHost.contains(nextCard)) {
			nextHost.appendChild(nextCard);
		}
		list.innerHTML = "";
		var places = Rules.placesById(trip);

		// Cards are about to be torn down — drop pending lazy-photo
		// registrations so only the new rows can trigger fetches, and prune
		// detached queue waiters so the map can't grow or paint a torn-down
		// card later.
		if (cardPhotoIO && cardPhotoTargets.size) {
			cardPhotoTargets.forEach(function (job, card) {
				cardPhotoIO.unobserve(card);
			});
			cardPhotoTargets.clear();
		}
		Object.keys(cardPhotoWaiters).forEach(function (placeId) {
			cardPhotoWaiters[placeId] = cardPhotoWaiters[placeId].filter(
				function (job) {
					return document.contains(job.card);
				},
			);
			if (!cardPhotoWaiters[placeId].length)
				delete cardPhotoWaiters[placeId];
		});

		// The timeline consumes the same shared day-route request as the map —
		// signature-deduped and capability-gated, so a keyless deployment never
		// fires a pointless call and ticks never re-request.
		if (store.capabilities && store.capabilities.routes) {
			maybeRequestDayRoute(day);
		}

		// Quiet disclaimer for the off-map metrics — a Google road-distance
		// preview (single visible attribution for the whole list) plus our own
		// rider-speed time estimate, never cycling guidance.
		var note = el("li", { class: "biwa-track-row biwa-track-note" });
		note.appendChild(
			el("div", { class: "biwa-track-marker", "aria-hidden": "true" }),
		);
		var noteText = el("span", { class: "biwa-track-note-text" });
		noteText.appendChild(
			document.createTextNode(t("Road distances are a preview from ")),
		);
		noteText.appendChild(
			el("a", {
				class: "biwa-track-note-attr",
				href: GOOGLE_TERMS_URL,
				target: "_blank",
				rel: "noopener noreferrer",
				text: "Google Maps",
			}),
		);
		noteText.appendChild(
			document.createTextNode(
				t(
					" — not cycling guidance. Times estimate 15 km/h riding, breaks excluded.",
				),
			),
		);
		note.appendChild(noteText);
		list.appendChild(note);

		// Rows in order: start, visible stops, end. A gap line sits between
		// every consecutive pair, keyed by the destination row's occurrence.
		var items = [
			{
				occId: Rules.endpointOccurrenceId(day, "start"),
				node: endpointRow(trip, day, "start", places),
			},
		];

		// Route-waypoint anchors stay in day.stops (routing order depends on
		// them) but never render as check-in rows — numbering runs 1..N over
		// the visible sequence only.
		var stops = (day.stops || []).filter(function (stop) {
			var p = places[stop.placeId];
			return !(p && p.category === "route-waypoint");
		});
		if (!stops.length) {
			var empty = el("li", { class: "biwa-track-row" });
			empty.appendChild(el("div", { class: "biwa-track-marker" }));
			empty.appendChild(
				el("div", {
					class: "biwa-empty",
					text: t("No stops yet — add one below."),
				}),
			);
			items.push({ occId: null, node: empty });
		}
		stops.forEach(function (stop, index) {
			var place = places[stop.placeId] || {
				placeId: stop.placeId,
				label: stop.placeId,
				programmes: [],
			};
			items.push({
				occId: stop.occurrenceId,
				node: stopRow(trip, day, stop, place, index),
			});
		});
		items.push({
			occId: Rules.endpointOccurrenceId(day, "end"),
			node: endpointRow(trip, day, "end", places),
		});

		var routeState = dayRoutes[day.dayId];
		var legMeters = window.BiwaStopDistances
			? BiwaStopDistances.visibleLegDistances(trip, day, routeState)
			: {};
		// Exactly one live target per day — the first unvisited VISIBLE point
		// (endpoint occurrences included). Resolved once per render so every
		// row's data-current flag agrees.
		var nextStop = Rules.nextUnvisitedStop(trip, day);
		var nextOccurrenceId = nextStop ? nextStop.occurrenceId : null;
		items.forEach(function (item, i) {
			if (i > 0 && item.occId) {
				list.appendChild(gapRow(item.occId, routeState, legMeters));
			}
			if (nextOccurrenceId && item.occId === nextOccurrenceId) {
				item.node.dataset.current = "true";
				// The live target IS a normal row — mark it with a small 'Up
				// Next' tag above the place name, then move the stable
				// next-stop node inside its card as the expanded action
				// panel (Navigate / Mark as Completed / programme links /
				// credit).
				var card = item.node.querySelector(".biwa-stop-card");
				if (card && nextCard) {
					var text = card.querySelector(".biwa-card-text");
					if (text) {
						text.insertBefore(
							el("span", {
								class: "biwa-row-next-label",
								text: t("Up Next"),
							}),
							text.firstChild,
						);
					}
					card.appendChild(nextCard);
				}
			}
			list.appendChild(item.node);
		});

		// Hand focus back to the captured panel control — but only while it
		// is still connected, laid out (a fallback state hides the actions)
		// and enabled. preventScroll keeps a poll-triggered rebuild from
		// scrolling the page under the user.
		if (
			nextCardFocus &&
			nextCard.contains(nextCardFocus) &&
			!nextCardFocus.disabled &&
			nextCardFocus.offsetParent !== null &&
			document.activeElement !== nextCardFocus
		) {
			nextCardFocus.focus({ preventScroll: true });
		}
	}

	// The quiet road-leg line between consecutive cards — its distance
	// belongs to the row that follows it (the leg's destination). data-kind
	// is 'gap', never 'stop', so drag/drop index math ignores it. The single
	// Google Maps link lives in the disclaimer note above the list rather
	// than repeating on every gap.
	function gapRow(destOccurrenceId, routeState, legMeters) {
		var row = el("li", {
			class: "biwa-track-row biwa-track-gap",
			dataset: { kind: "gap" },
		});
		row.appendChild(
			el("div", { class: "biwa-track-marker", "aria-hidden": "true" }),
		);
		var text = el("span", { class: "biwa-track-gap-text" });
		text.appendChild(
			el("span", {
				class: "biwa-track-gap-distance",
				dataset: { gapOcc: destOccurrenceId },
				text: gapLabel(destOccurrenceId, routeState, legMeters),
			}),
		);
		text.appendChild(
			el("span", {
				class: "biwa-track-gap-duration",
				dataset: { gapMinutes: destOccurrenceId },
				title: t("Estimated at 15 km/h, excluding breaks."),
				text: gapDurationLabel(destOccurrenceId, legMeters),
			}),
		);
		row.appendChild(text);
		return row;
	}

	function gapLabel(occurrenceId, routeState, legMeters) {
		var meters = legMeters[occurrenceId];
		if (typeof meters === "number") {
			return meters < 100
				? t("{n} m road", { n: Math.round(meters) })
				: t("{n} km road", { n: (meters / 1000).toFixed(1) });
		}
		if (routeState && routeState.status === "pending") {
			return t("Calculating road distance…");
		}
		return t("Road distance unavailable");
	}

	// Rider-facing leg time beside the distance — the frozen 15 km/h helper,
	// an honest estimate, never Google's DRIVE duration. Missing/unavailable
	// distances render blank rather than a fake zero; a real 0 m leg is 0 min.
	function gapDurationLabel(occurrenceId, legMeters) {
		var minutes = window.BiwaStopDistances
			? BiwaStopDistances.estimatedCyclingMinutes(legMeters[occurrenceId])
			: null;
		if (minutes === null || minutes === undefined) return "";
		if (minutes < 60) return t("≈ {n} min cycling", { n: minutes });
		var hours = Math.floor(minutes / 60);
		var rest = minutes % 60;
		return rest
			? t("≈ {h} h {m} min cycling", { h: hours, m: rest })
			: t("≈ {h} h cycling", { h: hours });
	}

	// A route answer rewrites ONLY the gap texts — never re-renders the
	// track, so an in-flight drag or focused control survives the update.
	function refreshTrackGaps() {
		var day = currentDay(store.trip);
		if (!day) return;
		var routeState = dayRoutes[day.dayId];
		var legMeters = window.BiwaStopDistances
			? BiwaStopDistances.visibleLegDistances(store.trip, day, routeState)
			: {};
		els["biwa-track"]
			.querySelectorAll(".biwa-track-gap-distance")
			.forEach(function (node) {
				node.textContent = gapLabel(
					node.dataset.gapOcc,
					routeState,
					legMeters,
				);
			});
		els["biwa-track"]
			.querySelectorAll(".biwa-track-gap-duration")
			.forEach(function (node) {
				node.textContent = gapDurationLabel(
					node.dataset.gapMinutes,
					legMeters,
				);
			});
	}

	function markerDot(text) {
		return el("div", { class: "biwa-track-marker" }, [
			el("span", {
				class: "biwa-track-marker-dot",
				"aria-hidden": "true",
				text: text,
			}),
		]);
	}

	// Endpoint rows read as lodging/terminals: they can be ticked like any row
	// (rental finish included) and open the sheet on tap — but never dragged.
	function endpointRow(trip, day, which, places) {
		var endpoint = day[which];
		var place =
			endpoint && endpoint.placeId ? places[endpoint.placeId] : null;
		var pin = endpoint && endpoint.pin ? endpoint.pin : null;
		var occurrenceId = Rules.endpointOccurrenceId(day, which);
		var row = el("li", {
			class: "biwa-track-row",
			dataset: { kind: which, occ: occurrenceId },
		});
		row.appendChild(markerDot(which === "start" ? t("S") : t("E")));

		var label = place
			? placeName(place)
			: pin
				? pin.label || t("Pinned point")
				: null;
		if (!label) {
			// Missing endpoint: honest state, not a phantom row. The Set action
			// lives inside the card body so the grid columns line up with the
			// populated rows.
			var missing = el("div", {
				class: "biwa-stop-card",
				dataset: { interactive: "true" },
			});
			var missingBody = el("div", { class: "biwa-card-body" }, [
				el("div", { class: "biwa-card-name" }, [
					el("span", {
						class: "biwa-stop-unconfirmed",
						text: t(
							which === "start"
								? "Start point not set"
								: "Overnight point not set",
						),
					}),
				]),
			]);
			var setBtn = el("button", {
				class: "biwa-btn-inline",
				type: "button",
				text: t("Set"),
				"data-focus-key": "endpoint-" + day.dayId + "-" + which,
			});
			setBtn.addEventListener("click", function (ev) {
				ev.stopPropagation();
				openEndpointDialog(day, which);
			});
			missingBody.appendChild(setBtn);
			missing.appendChild(missingBody);
			row.appendChild(missing);
			return row;
		}

		// Pin endpoints carry their coordinates on the pin record; surface them
		// on the display place so sheets/links resolve the point like any other.
		var displayPlace = place || {
			placeId: null,
			label: label,
			programmes: [],
			category: "pin",
			lat: pin ? pin.lat : null,
			lng: pin ? pin.lng : null,
		};
		var visited = Rules.arrivalChecked(trip, occurrenceId, displayPlace);
		row.dataset.visited = String(visited);

		var card = el("div", {
			class: "biwa-stop-card",
			dataset: { cardType: placeCardType(place), interactive: "true" },
		});
		card.appendChild(
			arrivalCheck(trip, occurrenceId, displayPlace, label, visited),
		);

		var body = el("button", {
			class: "biwa-card-body",
			type: "button",
			"aria-label": t("{name} — details", { name: label }),
			"data-focus-key": "card-" + occurrenceId,
		});
		var bodyText = el("div", { class: "biwa-card-text" }, [
			el(
				"div",
				{ class: "biwa-card-name" },
				[document.createTextNode(label + " ")].concat(
					placeBadgesNodes(place),
				),
			),
		]);
		var role =
			which === "start"
				? day.dayId === "day-1"
					? t("Start here")
					: t("Leave after the night")
				: day.dayId === "day-3"
					? t("Finish — return the bikes")
					: t("Overnight stay");
		bodyText.appendChild(
			el("div", { class: "biwa-card-meta" }, [
				document.createTextNode(role),
				place && place.address
					? el("span", {
							class: "biwa-card-address",
							text: " · " + place.address,
						})
					: document.createTextNode(""),
			]),
		);
		body.appendChild(bodyText);
		body.appendChild(chevronHint());
		body.addEventListener("click", function () {
			if (Date.now() < suppressClickUntil) return;
			openSheet({
				place: displayPlace,
				occurrenceId: occurrenceId,
				day: day,
				kind: which,
			});
		});
		card.appendChild(body);
		// Lazy photo backdrop — registers against the row's own card and
		// occurrence; the same shared details fetch also feeds the sheet
		// and the mini thumbnail.
		decorateStopCardPhoto(card, displayPlace, occurrenceId);
		row.appendChild(card);
		return row;
	}

	function placeBadgesNodes(place) {
		var nodes = [];
		if (!place) return nodes;
		var badges = el("span", { class: "biwa-badges" });
		Rules.placeBadges(place).forEach(function (b) {
			// 'Official · South' splits into two chips — programme (官方) plus a
			// shore chip whose data-area takes that shore's map-marker colour.
			badgeParts(b).forEach(function (part) {
				badges.appendChild(
					el("span", {
						class: "biwa-badge",
						text: part.text,
						dataset: part.area
							? { programme: part.programme, area: part.area }
							: { programme: part.programme },
					}),
				);
			});
		});
		// Plain custom extras are attractions, not certificate stops — say so
		// instead of showing no badge at all.
		if (place.category === "custom") {
			badges.appendChild(
				el("span", {
					class: "biwa-badge",
					text: t("Additional attraction"),
				}),
			);
		}
		if (place.nameConfirmed === false) {
			badges.appendChild(
				el("span", {
					class: "biwa-stop-unconfirmed",
					text: " " + t("(name unconfirmed)"),
				}),
			);
		}
		if (badges.children.length) nodes.push(badges);
		return nodes;
	}

	// --- completion leaves -------------------------------------------------------
	// A decorative burst of maple leaves on a manual false→true arrival tick.
	// The layer is fixed, pointer-events:none and lives inside the timeline
	// view — it celebrates over the open sheet too (its z-index sits above)
	// but can never steal a tap. Reduced motion skips the burst entirely;
	// the checkmark alone carries the feedback there.
	// The burst renders the lineless OpenMoji silhouette via CSS masks — one
	// flat asset, a palette of autumn colours painted by each leaf's
	// --leaf-color (CC BY-SA 4.0 — see assets/maple-leaf-flat.svg header and
	// terms.html). Structure per leaf: outer .biwa-leaf falls straight down,
	// a .biwa-leaf-sway wrapper drifts sideways, and .biwa-leaf-art carries
	// the masked shape and the tumble — separate layers so the transforms
	// never conflict, all compositor work (no rAF, no layout).
	var LEAF_COLORS = ["#c97c5d", "#b36a5e", "#c89f9c", "#eed7c5", "#8a4a36"];
	var leafSeq = 0;

	function burstLeaves() {
		if (prefersReducedMotion()) return;
		var layer = els["biwa-leaves"];
		if (!layer) return;
		// A rapid re-tick clears the previous burst and starts a fresh one.
		layer.innerHTML = "";
		var seq = ++leafSeq;
		var spawned = [];
		for (var i = 0; i < 36; i++) {
			var leaf = el("span", { class: "biwa-leaf" });
			var sway = el("span", { class: "biwa-leaf-sway" });
			var art = el("span", { class: "biwa-leaf-art" });
			sway.appendChild(art);
			leaf.appendChild(sway);

			leaf.style.left = 4 + Math.random() * 92 + "%";
			// Fall: 6.5–10s down the viewport, staggered up to 0.8s.
			leaf.style.animationDuration =
				(6.5 + Math.random() * 3.5).toFixed(2) + "s";
			leaf.style.animationDelay = (Math.random() * 0.8).toFixed(2) + "s";
			// Sway: ±2–6vw over a 2–4s cycle, random negative phase so leaves
			// don't march in step.
			sway.style.setProperty(
				"--leaf-sway",
				(2 + Math.random() * 4).toFixed(1) + "vw",
			);
			sway.style.animationDuration =
				(2 + Math.random() * 2).toFixed(2) + "s";
			sway.style.animationDelay = (-Math.random() * 4).toFixed(2) + "s";
			// Art: palette colour, initial facing angle, gentle 3D tilt and a
			// scale — every value rides a custom property, never inline styles
			// the keyframes would fight.
			art.style.setProperty(
				"--leaf-color",
				LEAF_COLORS[Math.floor(Math.random() * LEAF_COLORS.length)],
			);
			art.style.setProperty(
				"--leaf-rotate",
				(Math.random() * 360).toFixed(0) + "deg",
			);
			art.style.setProperty(
				"--leaf-tilt-x",
				(
					(Math.random() < 0.5 ? -1 : 1) *
					(30 + Math.random() * 35)
				).toFixed(0) + "deg",
			);
			// Mostly ±30–65° on Y; ~1 in 5 leaves tumbles past 90° for an
			// occasional flip — the silhouette stays visible either way.
			var flip = Math.random() < 0.2;
			art.style.setProperty(
				"--leaf-tilt-y",
				(
					(Math.random() < 0.5 ? -1 : 1) *
					(flip ? 95 + Math.random() * 65 : 30 + Math.random() * 35)
				).toFixed(0) + "deg",
			);
			art.style.setProperty(
				"--leaf-tilt-z",
				(
					(Math.random() < 0.5 ? -1 : 1) *
					(10 + Math.random() * 35)
				).toFixed(0) + "deg",
			);
			art.style.setProperty(
				"--leaf-scale",
				(0.8 + Math.random() * 0.4).toFixed(2),
			);
			art.style.animationDuration =
				(2.5 + Math.random() * 1.5).toFixed(2) + "s";
			art.style.animationDelay = (-Math.random() * 4).toFixed(2) + "s";

			// Only the OUTER fall ends the leaf — sway/tumble are infinite and
			// their ends would bubble up here, so filter to the leaf itself.
			leaf.addEventListener("animationend", function (ev) {
				if (ev.target !== this) return;
				if (this.parentNode) this.parentNode.removeChild(this);
			});
			layer.appendChild(leaf);
			spawned.push(leaf);
		}
		// Fallback cleanup — animationend can be missed when the tab is hidden
		// or the view swaps mid-fall.
		setTimeout(function () {
			if (seq !== leafSeq) return; // a newer burst owns the layer
			spawned.forEach(function (leaf) {
				if (leaf.parentNode) leaf.parentNode.removeChild(leaf);
			});
		}, 12000);
	}

	// --- check-in toast -----------------------------------------------------------
	// Small pill confirmation shown once a tick has actually landed — the
	// store resolves 'saved' on a committed write and 'local' when running
	// off the seed without a backend; conflicts/failures keep their own UI
	// and never flash success. One shared element means rapid successive
	// ticks simply replace the text and restart the fade instead of
	// stacking pills. It is a live region, so each update announces itself.
	var checkinToastTimer = null;
	// One shared pill for every transient confirmation — check-in ticks and
	// the offline module's connection transitions alike. Successive calls
	// replace the text and restart the fade instead of stacking toasts.
	// kind: '' (default, success tick) or 'notice' — notices carry the same
	// pill but hide the checkmark via data-tone so a failure never wears a
	// success glyph.
	function showToast(message, durationMs, kind) {
		var toast = els["biwa-toast"];
		if (!toast) return;
		els["biwa-toast-text"].textContent = message;
		if (kind) toast.dataset.tone = kind;
		else delete toast.dataset.tone;
		toast.classList.add("is-visible");
		clearTimeout(checkinToastTimer);
		checkinToastTimer = setTimeout(function () {
			toast.classList.remove("is-visible");
			delete toast.dataset.tone;
		}, durationMs || 2600);
	}
	function showCheckinToast(name) {
		showToast(
			name ? t("Completed — {name}", { name: name }) : t("Completed"),
			2600,
		);
	}
	// Toast gate for save() results — the only two states that mean the
	// tick is now durable.
	function checkinSaved(result, name) {
		if (result === "saved" || result === "local") showCheckinToast(name);
	}

	// --- timeline card photos ---------------------------------------------------
	// Lazy first-photo backdrops on every rendered stop/endpoint card, in the
	// same visual language as the up-next card (absolute image, 1px blur,
	// opaque paper veil, quiet author credit). Rows recreate their DOM on
	// every render, so painted photo NODES are kept keyed by occurrence id
	// and reattached to the new card — never a refetch and never a cached
	// card (its handlers would go stale). Detail fetches only fire when a
	// card nears the viewport (IntersectionObserver, 100px margin), queued
	// with at most 2 in flight, and each place's result/failure is
	// remembered for the session so nothing loops.
	var cardPhotoIO = null; // one shared IntersectionObserver
	var cardPhotoTargets = new Map(); // card element -> pending observe job
	var cardPhotoPending = []; // queued jobs awaiting a fetch slot
	var cardPhotoInflight = {}; // placeId -> true while its fetch owns a slot
	var cardPhotoWaiters = {}; // placeId -> [{card, place, occKey}]
	var cardPhotoDom = {}; // occKey -> {placeId, nodes:[img,veil,credit]}
	var cardPhotoFailed = {}; // placeId -> true after a failed DETAILS attempt
	var cardPhotoImageFailed = {}; // placeId -> true after photo BYTES fail
	var CARD_PHOTO_SLOTS = 4;

	function cardPhotoObserver() {
		if (cardPhotoIO || typeof IntersectionObserver === "undefined")
			return cardPhotoIO;
		cardPhotoIO = new IntersectionObserver(
			function (entries) {
				entries.forEach(function (entry) {
					if (!entry.isIntersecting) return;
					cardPhotoIO.unobserve(entry.target);
					var job = cardPhotoTargets.get(entry.target);
					cardPhotoTargets.delete(entry.target);
					if (job) enqueueCardPhoto(job);
				});
			},
			{ rootMargin: "100px" },
		);
		return cardPhotoIO;
	}

	// Register a rendered card for its place's photo. Called for stop and
	// populated endpoint rows; pins and missing endpoints have no placeId
	// and quietly return after stamping data-place-id.
	function decorateStopCardPhoto(card, place, occKey) {
		card.dataset.placeId = place && place.placeId ? place.placeId : "";
		if (!place || !place.placeId) return;
		var prior = cardPhotoDom[occKey];
		if (prior && prior.placeId !== place.placeId) {
			// The place behind this occurrence changed — the old layer belongs
			// to a different photo and is discarded.
			prior.nodes.forEach(function (n) {
				if (n.parentNode) n.parentNode.removeChild(n);
			});
			delete cardPhotoDom[occKey];
			prior = null;
		}
		if (prior) {
			// Same occurrence, same place — move the painted nodes onto the new
			// card so a poll re-render costs zero requests.
			prior.nodes.forEach(function (n) {
				card.appendChild(n);
			});
			card.classList.add("has-photo");
			return;
		}
		if (!(store.capabilities && store.capabilities.places)) return;
		// Photo bytes already failed for this place this session — never
		// repaint it, not even from freshly cached details (that would loop).
		if (cardPhotoImageFailed[place.placeId]) return;
		if (cardPhotoFailed[place.placeId]) {
			// A stale DETAILS failure must not block a free paint — details that
			// arrived through another path (e.g. a sheet retry) cost no request.
			var cached = placeDetailsCache[place.placeId];
			if (cached && cached !== "loading" && cached !== "unavailable") {
				paintCardPhoto(
					{ card: card, place: place, occKey: occKey },
					cached,
				);
			}
			return;
		}
		var observer = cardPhotoObserver();
		if (!observer) return;
		cardPhotoTargets.set(card, {
			card: card,
			place: place,
			occKey: occKey,
		});
		observer.observe(card);
	}

	function enqueueCardPhoto(job) {
		var placeId = job.place.placeId;
		var cached = placeDetailsCache[placeId];
		if (cached === "unavailable" || cardPhotoFailed[placeId]) {
			cardPhotoFailed[placeId] = true;
			return;
		}
		if (cached && cached !== "loading") {
			paintCardPhoto(job, cached);
			return;
		}
		// 'loading' or absent — register as a waiter so the shared fetch paints
		// every card wanting this place, then queue a fetch slot.
		(cardPhotoWaiters[placeId] = cardPhotoWaiters[placeId] || []).push(job);
		if (cached === "loading") return; // shares the in-flight fetch
		cardPhotoPending.push(job);
		pumpCardPhotos();
	}

	function pumpCardPhotos() {
		while (
			Object.keys(cardPhotoInflight).length < CARD_PHOTO_SLOTS &&
			cardPhotoPending.length
		) {
			var job = cardPhotoPending.shift();
			var placeId = job.place.placeId;
			var cached = placeDetailsCache[placeId];
			if (cached === "loading") continue; // a fetch already owns it
			if (cached && cached !== "unavailable") {
				if (document.contains(job.card)) paintCardPhoto(job, cached);
				dropWaiter(placeId, job);
				continue;
			}
			if (cached === "unavailable" || !document.contains(job.card)) {
				if (cached === "unavailable") cardPhotoFailed[placeId] = true;
				dropWaiter(placeId, job);
				continue;
			}
			if (!(store.capabilities && store.capabilities.places)) {
				// Capability could disappear between enqueue and pump — drop the
				// job instead of holding a fetch slot forever.
				dropWaiter(placeId, job);
				continue;
			}
			cardPhotoInflight[placeId] = true;
			maybeFetchDetails(job.place); // deduped + capability-gated; its
			// completion resolves the waiters
		}
	}

	function dropWaiter(placeId, job) {
		var list = cardPhotoWaiters[placeId];
		if (!list) return;
		var i = list.indexOf(job);
		if (i !== -1) list.splice(i, 1);
		if (!list.length) delete cardPhotoWaiters[placeId];
	}

	// Shared fetch completion: paint every card waiting on this place and
	// free its queue slot. Cards torn down mid-flight are dropped by the
	// document.contains check; their occurrence re-registers on the next
	// decorate call.
	function resolveCardPhotoWaiters(placeId) {
		delete cardPhotoInflight[placeId];
		var waiters = cardPhotoWaiters[placeId] || [];
		delete cardPhotoWaiters[placeId];
		var details = placeDetailsCache[placeId];
		var usable =
			details && details !== "loading" && details !== "unavailable"
				? details
				: null;
		if (!usable) cardPhotoFailed[placeId] = true;
		waiters.forEach(function (job) {
			if (usable && document.contains(job.card))
				paintCardPhoto(job, usable);
		});
		pumpCardPhotos();
	}

	// Paint the absolute photo layer + quiet credit onto a card. The credit
	// is a real visible link — Google attribution must stay reachable — and
	// sits outside the card-body button, so the sheet click and the drag
	// veto (a[href] is in the press-origin veto list) treat it correctly.
	function paintCardPhoto(job, details) {
		var card = job.card,
			place = job.place,
			occKey = job.occKey;
		if (card.dataset.placeId !== place.placeId || !document.contains(card))
			return;
		var existing = cardPhotoDom[occKey];
		if (existing && existing.placeId === place.placeId) {
			// Already painted for this occurrence+place — reattach the live
			// layer instead of building a duplicate.
			existing.nodes.forEach(function (n) {
				card.appendChild(n);
			});
			card.classList.add("has-photo");
			return;
		}
		var photo =
			details.photos && details.photos.length ? details.photos[0] : null;
		if (!photo) {
			cardPhotoFailed[place.placeId] = true;
			return;
		}
		var img = el("img", {
			class: "biwa-card-photo",
			"aria-hidden": "true",
			alt: "",
			src: store.photoUrl(place.placeId, photo.index, 800),
		});
		img.addEventListener("error", function () {
			// Byte-level failures get their own flag — an image that can't load
			// is never repainted this session (details may still be fine).
			cardPhotoImageFailed[place.placeId] = true;
			var dom = cardPhotoDom[occKey];
			// Nodes may have been reattached to a NEWER card since this img was
			// created — remove them from wherever they actually live and clear
			// has-photo on the real host, not the stale closed-over card. The
			// registry entry is deleted only while it still holds THIS img, so
			// a late error can never strip a newer photo layer.
			if (dom && dom.placeId === place.placeId && dom.nodes[0] === img) {
				dom.nodes.forEach(function (n) {
					var host = n.parentNode;
					if (host) {
						host.removeChild(n);
						host.classList.remove("has-photo");
					}
				});
				delete cardPhotoDom[occKey];
			} else if (img.parentNode) {
				img.parentNode.removeChild(img);
			}
		});
		var veil = el("div", {
			class: "biwa-card-veil",
			"aria-hidden": "true",
		});
		var names = [];
		(photo.authorAttributions || []).forEach(function (a) {
			if (a.displayName && names.indexOf(a.displayName) === -1)
				names.push(a.displayName);
		});
		var credit = el("a", {
			class: "biwa-card-photo-credit",
			href: details.mapsUrl || "https://www.google.com/maps",
			target: "_blank",
			rel: "noopener noreferrer",
			text: t("Photo © {names}", {
				names: names.length ? names.join(", ") : "Google",
			}),
		});
		cardPhotoDom[occKey] = {
			placeId: place.placeId,
			nodes: [img, veil, credit],
		};
		card.insertBefore(img, card.firstChild);
		card.insertBefore(veil, img.nextSibling);
		card.appendChild(credit);
		card.classList.add("has-photo");
	}

	// The 48px arrival tick shared by every row kind.
	function arrivalCheck(trip, occurrenceId, place, label, visited) {
		var btn = el("button", {
			class: "biwa-arrival-check",
			type: "button",
			"aria-pressed": String(visited),
			"aria-label": t(
				visited ? "Mark not visited: {name}" : "Mark visited: {name}",
				{ name: label },
			),
			"data-focus-key": "visit-" + occurrenceId,
		});
		btn.appendChild(
			el("span", {
				class: "biwa-arrival-box",
				"aria-hidden": "true",
				text: "✓",
			}),
		);
		btn.addEventListener("click", function (ev) {
			ev.stopPropagation();
			if (store._saving) return; // no double-fire while a write is in flight
			var target = !visited;
			// Progress write — local mirror is instant, doc write lands async.
			// Places resolve from the live view, not a draft.
			var resultP = store.applyLocalProgress(function (draft) {
				var p =
					place && place.placeId
						? (store.trip.places || []).filter(function (x) {
								return x.placeId === place.placeId;
							})[0] || place
						: null;
				Rules.applyArrival(draft, occurrenceId, p, target);
			});
			// Toast only once the tick is durable — a failed local write stays
			// silent, and unchecking never confirms.
			if (target)
				resultP.then(function (result) {
					checkinSaved(result, label);
				});
			// Celebrate a fresh manual tick — outside the save mutator so CAS
			// retries/reapplies can never double-fire the burst, and only on a
			// false→true flip (unchecking, polls and re-renders stay quiet).
			if (target) burstLeaves();
		});
		return btn;
	}

	function stopRow(trip, day, stop, place, index) {
		var visited = Rules.arrivalChecked(trip, stop.occurrenceId, place);
		var row = el("li", {
			class: "biwa-track-row",
			dataset: {
				kind: "stop",
				occ: stop.occurrenceId,
				day: day.dayId,
				visited: String(visited),
				index: String(index),
			},
		});
		row.appendChild(markerDot(String(index + 1)));

		// The whole card is the mouse drag surface (Pacey model); the tick and
		// inline controls veto their own drags at dragstart via the press origin.
		var card = el("div", {
			class: "biwa-stop-card",
			draggable: "true",
			dataset: {
				occ: stop.occurrenceId,
				cardType: placeCardType(place),
				interactive: "true",
			},
		});
		// Affordance order: drag grip on the LEFT, tick, body, chevron on the
		// right — grip-left reads as "reorderable", chevron-right as "opens".
		card.appendChild(dragHandle(day, stop, place));
		card.appendChild(
			arrivalCheck(
				trip,
				stop.occurrenceId,
				place,
				placeName(place),
				visited,
			),
		);

		var body = el("button", {
			class: "biwa-card-body",
			type: "button",
			"aria-label": t(
				"{name} — details. Press Alt+Up or Alt+Down to reorder.",
				{ name: placeName(place) },
			),
			"data-focus-key": "card-" + stop.occurrenceId,
		});
		var bodyText = el("div", { class: "biwa-card-text" }, [
			el(
				"div",
				{ class: "biwa-card-name" },
				[document.createTextNode(placeName(place) + " ")].concat(
					placeBadgesNodes(place),
				),
			),
		]);
		var metaParts = [];
		if (place.address) metaParts.push(place.address);
		if (place.notes) metaParts.push(place.notes);
		if (metaParts.length) {
			bodyText.appendChild(
				el("div", { class: "biwa-card-meta" }, [
					el("span", {
						class: "biwa-card-address",
						text: metaParts.join(" · "),
					}),
				]),
			);
		}
		body.appendChild(bodyText);
		// The chevron sits INSIDE the body button — it is part of the tap
		// target, not a decorative dead strip beside it.
		body.appendChild(chevronHint());
		body.addEventListener("click", function () {
			if (Date.now() < suppressClickUntil) return;
			openSheet({
				place: place,
				occurrenceId: stop.occurrenceId,
				day: day,
				kind: "stop",
			});
		});
		// Keyboard reorder alternative: Alt+Up/Down while the card is focused.
		body.addEventListener("keydown", function (ev) {
			if (!ev.altKey) return;
			if (ev.key === "ArrowUp") {
				ev.preventDefault();
				moveStopWithinDay(day, index, index - 1);
			}
			if (ev.key === "ArrowDown") {
				ev.preventDefault();
				moveStopWithinDay(day, index, index + 1);
			}
		});
		card.appendChild(body);
		// Same lazy backdrop as the endpoint rows — the stop's own
		// occurrence key scopes the painted layer.
		decorateStopCardPhoto(card, place, stop.occurrenceId);
		row.appendChild(card);
		return row;
	}

	// A static right-edge chevron marking the card as a sheet opener —
	// decorative (the real affordance is the body button) so it never
	// intercepts taps or reads aloud.
	function chevronHint() {
		var span = el("span", {
			class: "biwa-card-chevron",
			"aria-hidden": "true",
		});
		span.innerHTML = ICONS.chev;
		return span;
	}

	// --- card press feedback -----------------------------------------------------
	// Delegated pointer handlers add a transient .biwa-card-press class —
	// more reliable than :active across Safari's touch model — and it clears
	// on release, cancel, leave and dragstart so a native drag never carries
	// a pressed look. Only presses landing in the card body (the sheet
	// opener) count: the tick, handle and inline controls keep their own
	// affordances.
	function installCardPress() {
		var track = els["biwa-track"];
		var nextCard = els["biwa-next-stop"];

		// One clear-all path serves every surface — a pointerup landing outside
		// the track, a pointercancel, a window blur or the pointer leaving the
		// track all end any press (a stuck class would otherwise survive until
		// the next render).
		function clearCardPress() {
			document.querySelectorAll(".biwa-card-press").forEach(function (n) {
				n.classList.remove("biwa-card-press");
			});
		}

		track.addEventListener("pointerdown", function (ev) {
			var body =
				ev.target.closest && ev.target.closest(".biwa-card-body");
			var card = body && body.closest('[data-interactive="true"]');
			if (card) card.classList.add("biwa-card-press");
		});
		track.addEventListener("pointerleave", clearCardPress);
		track.addEventListener("dragstart", function (ev) {
			var card =
				ev.target.closest && ev.target.closest(".biwa-stop-card");
			if (card) card.classList.remove("biwa-card-press");
		});

		// Same feedback on the up-next card. The name button IS the card's
		// sheet opener so it presses like the card body; every other control
		// (Directions, complete, credit) keeps its own affordance instead.
		nextCard.addEventListener("pointerdown", function (ev) {
			if (nextCard.dataset.interactive !== "true") return;
			var control = ev.target.closest(
				"button, a, input, select, textarea",
			);
			if (control && !control.classList.contains("biwa-next-stop-name"))
				return;
			nextCard.classList.add("biwa-card-press");
		});
		nextCard.addEventListener("pointerleave", clearCardPress);

		document.addEventListener("pointerup", clearCardPress);
		document.addEventListener("pointercancel", clearCardPress);
		window.addEventListener("blur", clearCardPress);
	}

	// --- drag to reorder ---------------------------------------------------------
	// One delegated listener set on the track serves every row, so re-renders
	// can't orphan a mid-gesture handler (Pacey's calendar model). The mouse
	// uses native HTML5 drag on the whole CARD — the tick and inline controls
	// are vetoed at dragstart from the recorded press origin. Touch and pen
	// use a press-and-hold on the handle (the only region with
	// touch-action:none, so page scrolling still wins elsewhere). Both paths
	// aim the same midpoint insertion gap — a reorder, never a swap — and
	// commits resolve the source occurrence against the freshest trip.
	var touchDrag = null; // pending/active pointer-drag bookkeeping
	var dragPointerTarget = null; // element under the last track pointerdown
	var autoscrollRaf = 0; // rAF loop, only while a touch drag is active

	// The handle is the touch drag surface (44px, touch-action:none in CSS) —
	// pointer handling lives in the delegated track listeners. Alt+Up/Down on
	// the focused handle remains the keyboard alternative.
	function dragHandle(day, stop, place) {
		var handle = el("button", {
			class: "biwa-drag-handle",
			type: "button",
			"aria-label": t("Reorder {name} by dragging", {
				name: placeName(place),
			}),
			"data-focus-key": "handle-" + stop.occurrenceId,
		});
		handle.innerHTML = ICONS.grip;
		handle.addEventListener("keydown", function (ev) {
			if (ev.key === "ArrowUp" && ev.altKey) {
				ev.preventDefault();
				moveStopWithinDay(
					day,
					indexOfOccurrence(day, stop.occurrenceId),
					indexOfOccurrence(day, stop.occurrenceId) - 1,
				);
			}
			if (ev.key === "ArrowDown" && ev.altKey) {
				ev.preventDefault();
				moveStopWithinDay(
					day,
					indexOfOccurrence(day, stop.occurrenceId),
					indexOfOccurrence(day, stop.occurrenceId) + 1,
				);
			}
		});
		return handle;
	}

	// Position inside the VISIBLE stop sequence — every reorder index
	// (drag gap, Alt+arrows, commit lookup) counts rendered rows only, so
	// hidden route-waypoint anchors never offset the math.
	function indexOfOccurrence(day, occurrenceId) {
		return visibleStops(day).findIndex(function (s) {
			return s.occurrenceId === occurrenceId;
		});
	}

	// The day's non-waypoint stops in stored order — same objects, so a
	// reorder of this array permutes references that get written back into
	// the anchored slots by moveStopWithinDay.
	function visibleStops(day) {
		var places = Rules.placesById(store.trip);
		return (day.stops || []).filter(function (s) {
			var p = places[s.placeId];
			return !(p && p.category === "route-waypoint");
		});
	}

	// Gap index (0..stops.length) under a clientY — the slot a dropped row
	// would take, counting stop rows only (endpoints never move).
	function dropIndexAt(clientY) {
		var rows = els["biwa-track"].querySelectorAll(
			'.biwa-track-row[data-kind="stop"]',
		);
		var target = rows.length;
		rows.forEach(function (row, i) {
			var rect = row.getBoundingClientRect();
			if (clientY < rect.top + rect.height / 2 && target === rows.length)
				target = i;
		});
		return target;
	}

	function showDropIndicator(gapIndex) {
		clearDragIndicators(true);
		var rows = els["biwa-track"].querySelectorAll(
			'.biwa-track-row[data-kind="stop"]',
		);
		if (gapIndex < rows.length) {
			rows[gapIndex].dataset.dropBefore = "true";
		} else if (rows.length) {
			rows[rows.length - 1].dataset.dropAfter = "true";
		}
	}

	function clearDragIndicators(keepSource) {
		els["biwa-track"]
			.querySelectorAll("[data-drop-before],[data-drop-after]")
			.forEach(function (r) {
				delete r.dataset.dropBefore;
				delete r.dataset.dropAfter;
			});
		if (!keepSource) {
			els["biwa-track"]
				.querySelectorAll("[data-dragging]")
				.forEach(function (c) {
					delete c.dataset.dragging;
				});
		}
	}

	// Edge-of-viewport autoscroll runs as a rAF loop while the drag is active,
	// so scrolling stays continuous when the finger holds near an edge; the
	// insertion gap is re-aimed after every scroll since rows moved under a
	// stationary finger.
	function startAutoscrollLoop() {
		if (autoscrollRaf) return;
		var step = function () {
			autoscrollRaf = 0;
			if (!touchDrag || !touchDrag.active) return;
			var EDGE = 64,
				STEP = 14;
			var y = touchDrag.lastY;
			if (y < EDGE) window.scrollBy(0, -STEP);
			else if (y > window.innerHeight - EDGE) window.scrollBy(0, STEP);
			if (y < EDGE || y > window.innerHeight - EDGE) {
				touchDrag.gapIndex = dropIndexAt(y);
				showDropIndicator(touchDrag.gapIndex);
			}
			autoscrollRaf = requestAnimationFrame(step);
		};
		autoscrollRaf = requestAnimationFrame(step);
	}

	function stopAutoscrollLoop() {
		if (autoscrollRaf) {
			cancelAnimationFrame(autoscrollRaf);
			autoscrollRaf = 0;
		}
	}

	// Resolve the source row against the freshest shared snapshot — a poll may
	// have advanced the trip while the drag was in flight. Called only after
	// drag cleanup so the save's re-render can't race the gesture.
	function commitReorderToGap(dayId, occurrenceId, gapIndex) {
		if (gapIndex === null || gapIndex === undefined) return;
		var day = ((store.trip && store.trip.days) || []).filter(function (d) {
			return d.dayId === dayId;
		})[0];
		if (!day) return;
		var fromIndex = indexOfOccurrence(day, occurrenceId);
		if (fromIndex < 0) return;
		if (gapIndex === fromIndex || gapIndex === fromIndex + 1) return;
		var toIndex = gapIndex > fromIndex ? gapIndex - 1 : gapIndex;
		moveStopWithinDay(day, fromIndex, toIndex);
	}

	function endTouchDrag(commit) {
		if (!touchDrag) return;
		var state = touchDrag;
		touchDrag = null;
		if (state.timer) window.clearTimeout(state.timer);
		stopAutoscrollLoop();
		// Release the captured pointer explicitly — state is already null, so
		// the lostpointercapture cleanup that follows stays an idempotent no-op.
		try {
			state.handle.releasePointerCapture(state.pointerId);
		} catch (err) {
			/* ignore */
		}
		delete state.card.dataset.dragging;
		state.card.setAttribute("draggable", "true");
		clearDragIndicators();
		// Always restored — the flag went up at pointerdown, before the hold.
		store.setEditorActive(false);
		if (!state.active) return;
		// The tap that ends a drag must never open the sheet.
		suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
		if (commit)
			commitReorderToGap(state.dayId, state.occurrenceId, state.gapIndex);
	}

	// Installed once at boot — all drag listeners are delegated to the track.
	function installTrackDrag() {
		var track = els["biwa-track"];

		track.addEventListener("pointerdown", function (ev) {
			// Record the press origin so dragstart can veto the tick/controls.
			dragPointerTarget = ev.target;
			if (ev.pointerType === "mouse") return; // mouse keeps the HTML5 path
			if (touchDrag) return; // one gesture: extra fingers ignored
			var handle =
				ev.target.closest && ev.target.closest(".biwa-drag-handle");
			if (!handle) return;
			var card = handle.closest(".biwa-stop-card");
			var row = card && card.closest('.biwa-track-row[data-kind="stop"]');
			if (!row) return;
			// Touch owns this gesture now — a native drag must not also start.
			card.setAttribute("draggable", "false");
			// Keep receiving moves even when the finger slides off the handle.
			try {
				handle.setPointerCapture(ev.pointerId);
			} catch (err) {
				/* ignore */
			}
			touchDrag = {
				pointerId: ev.pointerId,
				startX: ev.clientX,
				startY: ev.clientY,
				lastY: ev.clientY,
				card: card,
				handle: handle,
				dayId: row.dataset.day,
				occurrenceId: row.dataset.occ,
				timer: null,
				active: false,
				gapIndex: null,
			};
			// A pending hold must not have its row re-rendered away by a poll.
			store.setEditorActive(true);
			touchDrag.timer = window.setTimeout(function () {
				if (!touchDrag) return;
				touchDrag.active = true;
				touchDrag.timer = null;
				touchDrag.card.dataset.dragging = "true";
				// Clear any text selection the long-press already started.
				var sel = window.getSelection && window.getSelection();
				if (sel) sel.removeAllRanges();
				// A short buzz confirms the drag engaged, where supported.
				if (navigator.vibrate) {
					try {
						navigator.vibrate(10);
					} catch (err) {
						/* ignore */
					}
				}
				startAutoscrollLoop();
			}, TOUCH_DRAG_HOLD_MS);
		});

		track.addEventListener("pointermove", function (ev) {
			if (!touchDrag || ev.pointerId !== touchDrag.pointerId) return;
			if (!touchDrag.active) {
				// Moved before the hold completed — the rider meant to scroll.
				if (
					Math.abs(ev.clientX - touchDrag.startX) >
						TOUCH_DRAG_TOLERANCE_PX ||
					Math.abs(ev.clientY - touchDrag.startY) >
						TOUCH_DRAG_TOLERANCE_PX
				) {
					endTouchDrag(false);
				}
				return;
			}
			ev.preventDefault();
			touchDrag.lastY = ev.clientY;
			touchDrag.gapIndex = dropIndexAt(ev.clientY);
			showDropIndicator(touchDrag.gapIndex);
		});

		track.addEventListener("pointerup", function (ev) {
			if (!touchDrag || ev.pointerId !== touchDrag.pointerId) return;
			// Judge the drop where the finger actually lifted — a flick can end
			// past the row the last move's gap was aimed at.
			var host = document.elementFromPoint(ev.clientX, ev.clientY);
			var overTrack = !!(
				host &&
				host.closest &&
				host.closest("#biwa-track")
			);
			if (touchDrag.active) touchDrag.gapIndex = dropIndexAt(ev.clientY);
			endTouchDrag(!!(touchDrag.active && overTrack));
		});
		track.addEventListener("pointercancel", function (ev) {
			if (touchDrag && ev.pointerId === touchDrag.pointerId)
				endTouchDrag(false);
		});
		track.addEventListener("lostpointercapture", function (ev) {
			if (touchDrag && ev.pointerId === touchDrag.pointerId)
				endTouchDrag(false);
		});

		// Escape and window blur cancel an in-flight drag without committing —
		// touch and native paths alike. The browser fires dragend on Escape
		// too; that cleanup is guarded by dragState and stays idempotent.
		function cancelNativeDrag() {
			clearDragIndicators();
			dragState = null;
			suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
			store.setEditorActive(false);
		}
		document.addEventListener("keydown", function (ev) {
			if (ev.key !== "Escape") return;
			if (touchDrag) {
				endTouchDrag(false);
				return;
			}
			if (dragState) cancelNativeDrag();
		});
		window.addEventListener("blur", function () {
			if (touchDrag) endTouchDrag(false);
			if (dragState) cancelNativeDrag();
		});

		// A long-press on the handle would otherwise raise the context menu.
		track.addEventListener("contextmenu", function (ev) {
			if (ev.target.closest && ev.target.closest(".biwa-drag-handle"))
				ev.preventDefault();
		});

		// --- native HTML5 drag (mouse) on the whole card ---
		track.addEventListener("dragstart", function (ev) {
			var card =
				ev.target.closest && ev.target.closest(".biwa-stop-card");
			var row = card && card.closest('.biwa-track-row[data-kind="stop"]');
			if (!row) {
				ev.preventDefault();
				return;
			}
			// Ticks, links and form controls inside the card are click surfaces,
			// not drag origins — veto a drag that began on one.
			if (
				dragPointerTarget &&
				dragPointerTarget.closest &&
				dragPointerTarget.closest(
					".biwa-arrival-check, a[href], select, input, textarea",
				)
			) {
				ev.preventDefault();
				return;
			}
			dragState = {
				dayId: row.dataset.day,
				occurrenceId: row.dataset.occ,
			};
			card.dataset.dragging = "true";
			ev.dataTransfer.effectAllowed = "move";
			try {
				ev.dataTransfer.setData("text/plain", dragState.occurrenceId);
			} catch (err) {
				/* ignore */
			}
			store.setEditorActive(true);
		});

		track.addEventListener("dragover", function (ev) {
			if (!dragState) return;
			ev.preventDefault(); // required for drop to fire on the track
			ev.dataTransfer.dropEffect = "move";
			showDropIndicator(dropIndexAt(ev.clientY));
		});

		track.addEventListener("dragleave", function (ev) {
			if (!dragState) return;
			// Leaving the track hides the insertion line; the source stays marked.
			if (!track.contains(ev.relatedTarget)) clearDragIndicators(true);
		});

		track.addEventListener("drop", function (ev) {
			if (!dragState) return;
			ev.preventDefault();
			var state = dragState;
			dragState = null;
			clearDragIndicators();
			store.setEditorActive(false);
			suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
			commitReorderToGap(
				state.dayId,
				state.occurrenceId,
				dropIndexAt(ev.clientY),
			);
		});

		// dragend fires after drop too — cleanup is idempotent. Drops outside
		// the track simply never fire drop, so they can never commit.
		track.addEventListener("dragend", function () {
			if (!dragState) return;
			clearDragIndicators();
			dragState = null;
			suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
			store.setEditorActive(false);
		});
	}

	// Reorders run on the visible sequence only: the reordered stops are
	// written back into the ORIGINAL non-waypoint slots, so hidden
	// route-waypoint anchors keep their stored index — and the provider
	// route keeps hugging the road they were placed to preserve.
	function moveStopWithinDay(day, fromIndex, toIndex) {
		store.save(function (draft) {
			var d = draft.days.filter(function (x) {
				return x.dayId === day.dayId;
			})[0];
			if (!d) return;
			var places = Rules.placesById(draft);
			var isWaypoint = function (s) {
				var p = places[s.placeId];
				return !!(p && p.category === "route-waypoint");
			};
			var visible = (d.stops || []).filter(function (s) {
				return !isWaypoint(s);
			});
			Rules.moveStopWithinDay({ stops: visible }, fromIndex, toIndex);
			var next = 0;
			d.stops = (d.stops || []).map(function (s) {
				if (isWaypoint(s)) return s;
				return visible[next++];
			});
		});
	}

	// (Cross-day moves live in Rules.moveStopBetweenDays for reuse; the sheet
	// no longer exposes a move control — drag and Alt+arrows handle reordering.)

	// --- destination sheet -----------------------------------------------------------
	var sheetContext = null; // {place, occurrenceId, day, kind}

	function isSheetOpen() {
		return !els["biwa-sheet"].hidden;
	}

	var sheetPrevOverflow = ""; // page scroll style saved while the sheet locks it
	var sheetClosing = false; // an exit animation is in flight
	var sheetAnimSeq = 0; // generation guard for open/close transitions
	var sheetAnims = []; // live WAAPI animations, cancelled on reopen

	function cancelSheetAnimations() {
		sheetAnims.forEach(function (a) {
			try {
				a.cancel();
			} catch (e) {}
		});
		sheetAnims = [];
	}

	function openSheet(context) {
		var reopening = isSheetOpen();
		sheetAnimSeq++;
		// Drop any stale entrance/exit animations unconditionally — a leftover
		// fill:forwards would otherwise pin the sheet at opacity:0 on reopen.
		cancelSheetAnimations();
		// A close that was mid-flight is now moot: its finish callback is
		// retired by the generation bump above.
		sheetClosing = false;
		sheetContext = context;
		if (!reopening) {
			// First open owns the return-focus target and the scroll lock — a
			// place switch inside an open sheet must not overwrite either.
			sheetTrigger = document.activeElement;
			// Lock the page behind the sheet — the original inline style is
			// restored verbatim on the final close so an app-level overflow
			// setting survives.
			sheetPrevOverflow = document.body.style.overflow;
			document.body.style.overflow = "hidden";
		}
		els["biwa-sheet-backdrop"].hidden = false;
		els["biwa-sheet"].hidden = false;
		els["biwa-sheet"].dataset.cardType = placeCardType(context.place);
		store.setEditorActive(true);
		// A failed fetch earns one retry per sheet open — never polled. It is
		// cleared BEFORE the body renders so the slot reads "Loading details…",
		// not a stale "unavailable", while the real request is in flight.
		if (
			context.place &&
			context.place.placeId &&
			placeDetailsCache[context.place.placeId] === "unavailable"
		) {
			delete placeDetailsCache[context.place.placeId];
		}
		renderSheetBody();
		els["biwa-sheet-close"].focus();
		// Transient details only load while the sheet is open for this place.
		maybeFetchDetails(context.place);
		// Entrance motion only on a genuine closed→open transition — a place
		// switch inside an open sheet (and any details refill re-render) must
		// not replay it. Reduced motion keeps the immediate lifecycle.
		if (
			!reopening &&
			!prefersReducedMotion() &&
			els["biwa-sheet"].animate
		) {
			sheetAnims = [
				els["biwa-sheet"].animate(
					[
						{
							transform: sheetIsDesktop()
								? "translateX(24px)"
								: "translateY(24px)",
							opacity: 0,
						},
						{ transform: "none", opacity: 1 },
					],
					{ duration: 280, easing: "cubic-bezier(0.25, 1, 0.5, 1)" },
				),
				els["biwa-sheet-backdrop"].animate(
					[{ opacity: 0 }, { opacity: 1 }],
					{ duration: 280, easing: "ease-out" },
				),
			];
		}
	}

	// Single close path: the sheet is fully dismissed exactly once — scroll
	// unlock, editor flag, and the return focus all live here.
	function finalizeSheetClose() {
		sheetContext = null;
		els["biwa-sheet"].hidden = true;
		els["biwa-sheet-backdrop"].hidden = true;
		els["biwa-sheet-actions"].innerHTML = "";
		document.body.style.overflow = sheetPrevOverflow;
		store.setEditorActive(false);
		if (sheetTrigger && document.contains(sheetTrigger)) {
			sheetTrigger.focus();
		}
		sheetTrigger = null;
		// After hiding: cancel the exit animations so their fill:forwards does
		// not pin the sheet at opacity:0 on the next open, clear the flag, and
		// bump the generation so any close callbacks still queued are retired.
		sheetClosing = false;
		cancelSheetAnimations();
		sheetAnimSeq++;
	}

	function closeSheet() {
		if (!isSheetOpen() || sheetClosing) return;
		// Reduced motion (or a browser without WAAPI) closes immediately.
		if (prefersReducedMotion() || !els["biwa-sheet"].animate) {
			finalizeSheetClose();
			return;
		}
		sheetClosing = true;
		var seq = ++sheetAnimSeq;
		// Cancel any entrance still playing — the exit takes over from the
		// element's natural state.
		cancelSheetAnimations();
		// hidden stays unset until the exit finishes, so isSheetOpen() — and
		// with it the focus trap, Escape/backdrop handlers and the scroll lock —
		// stays live through the whole animation.
		sheetAnims = [
			els["biwa-sheet"].animate(
				[
					{ transform: "none", opacity: 1 },
					{
						transform: sheetIsDesktop()
							? "translateX(24px)"
							: "translateY(24px)",
						opacity: 0,
					},
				],
				{ duration: 200, easing: "ease-in", fill: "forwards" },
			),
			els["biwa-sheet-backdrop"].animate(
				[{ opacity: 1 }, { opacity: 0 }],
				{ duration: 200, easing: "ease-in", fill: "forwards" },
			),
		];
		sheetAnims[0].addEventListener("finish", function () {
			// A reopen bumped the generation — this stale close must not hide a
			// fresh sheet or unlock the body under it.
			if (seq !== sheetAnimSeq) return;
			finalizeSheetClose();
		});
		// Fallback for a finish event that never fires.
		setTimeout(function () {
			if (seq === sheetAnimSeq && sheetClosing) finalizeSheetClose();
		}, 300);
	}

	function wireSheetLifecycle() {
		els["biwa-sheet-close"].addEventListener("click", closeSheet);
		els["biwa-sheet-backdrop"].addEventListener("click", closeSheet);
		document.addEventListener("keydown", function (ev) {
			if (
				ev.key === "Escape" &&
				isSheetOpen() &&
				!els["biwa-stop-dialog"].open &&
				!els["biwa-endpoint-dialog"].open &&
				!els["biwa-conflict-dialog"].open
			) {
				closeSheet();
			}
			// Focus trap: keep Tab cycling inside the sheet while it is modal.
			if (ev.key === "Tab" && isSheetOpen()) {
				var focusables = els["biwa-sheet"].querySelectorAll(
					'button, a[href], select, input, textarea, [tabindex]:not([tabindex="-1"])',
				);
				if (!focusables.length) return;
				var first = focusables[0],
					last = focusables[focusables.length - 1];
				if (ev.shiftKey && document.activeElement === first) {
					ev.preventDefault();
					last.focus();
				} else if (!ev.shiftKey && document.activeElement === last) {
					ev.preventDefault();
					first.focus();
				}
			}
		});
	}

	function renderSheetBody() {
		var ctx = sheetContext;
		if (!ctx) return;
		// Re-resolve the day on every paint — index lookups must run against the
		// live trip, not the snapshot the sheet opened with.
		if (ctx.day && store.trip) {
			ctx.day =
				(store.trip.days || []).filter(function (d) {
					return d.dayId === ctx.day.dayId;
				})[0] || ctx.day;
		}
		var place = ctx.place || {};
		var body = els["biwa-sheet-body"];
		body.innerHTML = "";
		body.appendChild(
			el("h2", { id: "biwa-sheet-title" }, [
				document.createTextNode(
					place.label ? placeName(place) : t("Pinned point"),
				),
			]),
		);

		var badges = el("div", { class: "biwa-badges" });
		Rules.placeBadges(place).forEach(function (b) {
			// Same two-chip split as the row badges — data-area drives the map
			// marker colour per shore; data-checked still overrides to green on
			// both chips of the split pair.
			badgeParts(b).forEach(function (part) {
				badges.appendChild(
					el("span", {
						class: "biwa-badge",
						text: part.text,
						dataset: {
							programme: part.programme,
							area: part.area || "",
							checked: String(
								Rules.placeProgrammeChecked(
									store.trip,
									place,
								) &&
									Rules.programmeFamilies(
										place.programmes,
									).indexOf(part.programme) !== -1,
							),
						},
					}),
				);
			});
		});
		if (place.category === "accommodation")
			badges.appendChild(
				el("span", { class: "biwa-badge", text: t("Stay") }),
			);
		if (place.category === "parking")
			badges.appendChild(
				el("span", {
					class: "biwa-badge",
					text: t("Bike-friendly parking — group curated"),
				}),
			);
		// Custom extras are honest about what they are — a side trip, never a
		// certificate checkpoint.
		if (place.category === "custom")
			badges.appendChild(
				el("span", {
					class: "biwa-badge",
					text: t("Additional attraction"),
				}),
			);
		if (place.nameConfirmed === false)
			badges.appendChild(
				el("span", {
					class: "biwa-stop-unconfirmed",
					text: t("name unconfirmed"),
				}),
			);
		if (badges.children.length) body.appendChild(badges);

		// For a catalogue/map context (no occurrence) note where the place is
		// already scheduled — informational, not an edit control.
		if (ctx.kind === "catalogue" || ctx.kind === "map") {
			var onPlan = Rules.occurrencesOf(store.trip, place.placeId).map(
				function (o) {
					var d = (store.trip.days || []).filter(function (x) {
						return x.dayId === o.dayId;
					})[0];
					return d ? dayLabel(d) : o.dayId;
				},
			);
			if (onPlan.length) {
				body.appendChild(
					el("p", {
						class: "biwa-field-hint",
						text: t("On the plan: {list}", {
							list: onPlan.join(
								I18n && I18n.lang() === "zh" ? "、" : ", ",
							),
						}),
					}),
				);
			}
		}

		// Details slot — photos/address/hours/contacts fetched once per session
		// on sheet open (never bulk, never persisted). See fillSheetDetails.
		body.appendChild(el("div", { id: "biwa-sheet-details" }));
		fillSheetDetails(place);

		if (place.notes)
			body.appendChild(
				el("p", { class: "biwa-sheet-section", text: place.notes }),
			);

		// The sticky footer actions live outside the scroll body; re-rendered
		// here so the completed stamp state stays current.
		renderSheetActions(ctx);
	}

	// Footer action set — deliberately small and always in the same order:
	// Navigate (primary, full width, a free Maps URL — never a provider
	// call), then Check In on Official Site for official checkpoints and the
	// manual Completed toggle. No removal or programme explainer UI lives here.
	function renderSheetActions(ctx) {
		var host = els["biwa-sheet-actions"];
		host.innerHTML = "";
		var place = ctx.place || {};

		host.appendChild(
			el("a", {
				class: "biwa-btn biwa-btn-primary biwa-sheet-action-wide",
				href: MapLinks.directionsUrl(place),
				target: "_blank",
				rel: "noopener noreferrer",
				text: t("Navigate"),
			}),
		);

		var row = el("div", { class: "biwa-sheet-action-row" });
		var programmes = place.programmes || [];
		var isOfficial = programmes.some(function (m) {
			return typeof m === "string" && m.indexOf("official-") === 0;
		});
		var isRally = programmes.indexOf("rally") !== -1;
		// Check-in hands off to each programme's own organiser flow. A shared
		// checkpoint (Mizudori) shows both — one fixed label per site,
		// identical to the next-panel links.
		if (isOfficial) {
			row.appendChild(
				el("a", {
					class: "biwa-btn biwa-btn-secondary",
					href: OFFICIAL_CHECKIN_URL,
					target: "_blank",
					rel: "noopener noreferrer",
					text: t("Check In on Official Site"),
				}),
			);
		}
		if (isRally) {
			row.appendChild(
				el("a", {
					class: "biwa-btn biwa-btn-secondary",
					href: RALLY_CHECKIN_URL,
					target: "_blank",
					rel: "noopener noreferrer",
					// A rally-only stop's link goes to the RALLY site — matching the
					// next-card copy (was 'Check In on Official Site', which lied).
					text: t("Check In on Rally Site"),
				}),
			);
		}

		// The same one-tick arrival action as the track rows — manual only; GPS
		// never ticks anything for the rider.
		var occ = ctx.occurrenceId;
		var checked = occ
			? Rules.arrivalChecked(store.trip, occ, place)
			: Rules.placeProgrammeChecked(store.trip, place);
		// Text-only like every other destination action — the decorative
		// stamp box once left a blank icon slot in the pending state.
		var tick = el("button", {
			class: "biwa-btn biwa-btn-secondary",
			type: "button",
			"aria-pressed": String(checked),
			"data-focus-key": "sheet-tick",
			text: t(checked ? "Completed" : "Mark as Completed"),
		});
		if (checked) tick.dataset.tone = "visited";
		tick.addEventListener("click", function () {
			if (store._saving) return;
			var target = !checked;
			var occurrenceId = occ;
			var placeId = place.placeId;
			// Progress write — local mirror is instant, doc write lands async.
			var resultP = store.applyLocalProgress(function (draft) {
				var p = placeId
					? (store.trip.places || []).filter(function (x) {
							return x.placeId === placeId;
						})[0]
					: null;
				Rules.applyArrival(draft, occurrenceId, p || place, target);
			});
			// The sheet may sit over map/nearby where the leaf layer is
			// hidden — the pill is view-independent and always reachable.
			if (target)
				resultP.then(function (result) {
					checkinSaved(result, placeName(place));
				});
			// The sheet body re-renders from the store change — keep context.
			// Celebrate a fresh tick only while the timeline view is active —
			// the leaf layer lives there and stays hidden on map/nearby.
			if (
				target &&
				document
					.getElementById("view-timeline")
					.classList.contains("is-active")
			) {
				burstLeaves();
			}
		});
		row.appendChild(tick);
		host.appendChild(row);
	}

	// Fetch normalized place details once per session and only while the
	// sheet is open — Google data is transient by design. The render guard
	// matches the CURRENT place id, not a request sequence: re-opening the
	// same card before its answer lands must still paint it.
	function maybeFetchDetails(place) {
		if (!place || !place.placeId) return;
		if (!(store.capabilities && store.capabilities.places)) return;
		if (placeDetailsCache[place.placeId] !== undefined) return;
		placeDetailsCache[place.placeId] = "loading";
		var placeId = place.placeId;
		store.fetchPlace(placeId).then(function (body) {
			if (body && body.ok && body.details) {
				placeDetailsCache[placeId] = body.details;
				var loc = body.details.location;
				if (
					loc &&
					typeof loc.lat === "number" &&
					typeof loc.lng === "number"
				) {
					transientLocations[placeId] = loc;
				}
			} else {
				placeDetailsCache[placeId] = "unavailable";
				// Live details failed — the policy-limited server cache may still
				// carry lat/lng (Google's 30-day allowance), surfaced separately
				// from details. Coordinates only: never treated as place content.
				var cachedLoc =
					body && body.source && body.source.cachedLocation;
				if (
					cachedLoc &&
					typeof cachedLoc.lat === "number" &&
					typeof cachedLoc.lng === "number"
				) {
					transientLocations[placeId] = {
						lat: cachedLoc.lat,
						lng: cachedLoc.lng,
					};
				}
			}
			// Paint iff the sheet still shows this exact place.
			if (
				sheetContext &&
				sheetContext.place &&
				sheetContext.place.placeId === placeId
			) {
				fillSheetDetails(sheetContext.place);
			}
			// The up-next card gains its backdrop only when the resolved place
			// is still the current day's next stop — never a stale or unrelated
			// photo, and never another day's card.
			var curDay = currentDay(store.trip);
			if (curDay && nextChosenId === placeId)
				renderNextCard(store.trip, curDay);
			// Markers/distances may have gained coordinates — refresh quietly.
			renderNearbyExtras();
			refreshMapMarkers();
			// Free the lazy card-photo queue slot and paint waiting rows.
			resolveCardPhotoWaiters(placeId);
		});
	}

	// Direct in-app details, provider data where it exists: photos with
	// credits first, then address, opening hours, and contact links. Nothing
	// is fabricated — a field the provider did not return simply does not
	// appear, and generic states name the fallback (Navigate opens
	// Google Maps with the latest info).
	function fillSheetDetails(place) {
		var slot = document.getElementById("biwa-sheet-details");
		if (!slot) return;
		slot.innerHTML = "";
		var cached = place.placeId
			? placeDetailsCache[place.placeId]
			: "unavailable";
		var d =
			cached && cached !== "loading" && cached !== "unavailable"
				? cached
				: null;

		// Compact facts under the name: the provider's own category plus the
		// rating/review count when Google returned them. A missing rating is
		// named explicitly — never rendered as a fake 0.
		if (d) {
			var facts = el("p", { class: "biwa-sheet-facts" });
			var segs = [];
			if (d.type) segs.push(document.createTextNode(d.type));
			if (typeof d.rating === "number") {
				// Singular/plural keys collapse to the same Chinese string — the
				// branch survives for English grammar only.
				var ratingText =
					d.rating.toFixed(1) +
					" / 5" +
					(typeof d.userRatingCount === "number"
						? t(
								d.userRatingCount === 1
									? " · {n} review"
									: " · {n} reviews",
								{ n: d.userRatingCount },
							)
						: "");
				var star = el("span", {
					class: "biwa-sheet-star",
					"aria-hidden": "true",
				});
				star.innerHTML = ICONS.star;
				segs.push(
					el(
						"span",
						{
							class: "biwa-sheet-rating",
							"aria-label": t("Rating {r}", { r: ratingText }),
						},
						[star, document.createTextNode(" " + ratingText)],
					),
				);
			} else {
				segs.push(document.createTextNode(t("Rating not provided")));
			}
			segs.forEach(function (node, i) {
				if (i) facts.appendChild(document.createTextNode(" · "));
				facts.appendChild(node);
			});
			slot.appendChild(facts);
		}

		// Photo-led gallery: up to three large 16:9 slides in a snap scroller
		// with prev/next controls, a counter and keyboard arrows — lazy-loaded,
		// no fake placeholder images.
		var hasPhotos = !!(d && d.photos && d.photos.length);
		if (hasPhotos) {
			var photos = d.photos.slice(0, 3);
			var gallery = el("div", {
				class: "biwa-sheet-gallery-wrap biwa-sheet-section",
			});
			var grid = el("div", {
				class: "biwa-sheet-gallery",
				role: "group",
				"aria-label": t("Photos of {name}", { name: placeName(place) }),
				tabindex: "0", // ←/→ step through the photos for keyboard users
			});
			photos.forEach(function (photo) {
				var img = el("img", {
					src: store.photoUrl(place.placeId, photo.index, 800),
					alt: t("Photo of {name}", { name: placeName(place) }),
					loading: "lazy",
				});
				// A failed photo must not leave a broken-image glyph: swap in an
				// honest note instead.
				img.addEventListener("error", function () {
					img.replaceWith(
						el("p", {
							class: "biwa-field-hint",
							text: t("Photo unavailable."),
						}),
					);
				});
				grid.appendChild(img);
			});
			gallery.appendChild(grid);
			if (photos.length > 1)
				gallery.appendChild(buildGalleryNav(grid, photos.length));
			slot.appendChild(gallery);
		} else if (d) {
			// The provider answered with an empty photo set — say so explicitly
			// instead of leaving a silent gap where the gallery would be.
			slot.appendChild(
				el("p", {
					class: "biwa-field-hint",
					text: t("No photos provided for this place."),
				}),
			);
		}

		// One Google Maps credit line whenever provider details are shown —
		// merged into the photo credit when photos exist so it never doubles.
		if (d) {
			var credit = el("p", { class: "biwa-sheet-credit" });
			if (hasPhotos) {
				var credits = [];
				d.photos.slice(0, 3).forEach(function (photo) {
					(photo.authorAttributions || []).forEach(function (a) {
						if (
							a.displayName &&
							credits.indexOf(a.displayName) === -1
						)
							credits.push(a.displayName);
					});
				});
				credit.appendChild(
					document.createTextNode(
						t("Photos © {names} via ", {
							names: credits.length
								? credits.join(", ")
								: t("Google contributors"),
						}),
					),
				);
			} else {
				credit.appendChild(document.createTextNode(t("Details via ")));
			}
			credit.appendChild(
				el("a", {
					href: d.mapsUrl || "https://www.google.com/maps",
					target: "_blank",
					rel: "noopener noreferrer",
					text: "Google Maps",
				}),
			);
			slot.appendChild(credit);
		}

		// Address: the provider's formatted address when fetched, else the
		// place's own source address — never debug/coordinate text.
		var address = (d && d.address) || place.address;
		if (address) {
			slot.appendChild(
				el("p", { class: "biwa-sheet-fact" }, [
					el("strong", { text: t("Address") }),
					document.createTextNode(" " + address),
				]),
			);
		}

		// Honest intermediate states while details resolve (or cannot).
		if (!d) {
			var note;
			if (!(store.capabilities && store.capabilities.places)) {
				note = t(
					"Opening hours and photos are not configured on this app — " +
						"Navigate opens Google Maps with the latest details.",
				);
			} else if (cached === "loading" || cached === undefined) {
				note = t("Loading details…");
			} else {
				note = t(
					"Details unavailable for this place — Navigate opens " +
						"Google Maps with the latest info.",
				);
			}
			slot.appendChild(el("p", { class: "biwa-field-hint", text: note }));
		}

		// Opening hours: open-now flag plus the weekday list when provided.
		if (d && d.hours) {
			var openNow = d.hours.openNow;
			if (openNow === true || openNow === false) {
				slot.appendChild(
					el(
						"p",
						{
							class: "biwa-sheet-fact",
							dataset: { tone: openNow ? "open" : "closed" },
						},
						[
							el("strong", {
								text: t(openNow ? "Open now" : "Closed now"),
							}),
						],
					),
				);
			}
			if (
				d.hours.weekdayDescriptions &&
				d.hours.weekdayDescriptions.length
			) {
				var hours = el("div", { class: "biwa-sheet-section" });
				hours.appendChild(el("h3", { text: t("Opening hours") }));
				var ul = el("ul", { class: "biwa-sheet-hours" });
				d.hours.weekdayDescriptions.forEach(function (line) {
					ul.appendChild(el("li", { text: line }));
				});
				hours.appendChild(ul);
				slot.appendChild(hours);
			}
		} else if (d) {
			// The provider answered but carries no hours — say so instead of
			// silently omitting the section or sending the user off-app.
			slot.appendChild(
				el("p", {
					class: "biwa-field-hint",
					text: t("Opening hours not provided for this place."),
				}),
			);
		}

		// Contact links — website and phone only (the Maps listing is not
		// repeated here; Navigate already hands off to it).
		if (d && (d.website || d.phone)) {
			var contacts = el("div", {
				class: "biwa-sheet-links biwa-sheet-section",
			});
			if (d.website) {
				contacts.appendChild(
					el("a", {
						href: d.website,
						target: "_blank",
						rel: "noopener noreferrer",
						text: t("Website"),
					}),
				);
			}
			if (d.phone) {
				contacts.appendChild(
					el("a", {
						href: "tel:" + d.phone,
						text: d.phone,
					}),
				);
			}
			slot.appendChild(contacts);
		}

		// Third-party data providers must be credited alongside the content.
		if (d && d.attributions && d.attributions.length) {
			var attr = el("p", { class: "biwa-sheet-credit" });
			d.attributions.forEach(function (a) {
				attr.appendChild(
					document.createTextNode(
						(attr.childNodes.length ? " · " : "") +
							(a.displayName || t("Third-party provider")),
					),
				);
			});
			slot.appendChild(attr);
		}
	}

	// Prev/next buttons plus a slide counter under the snap gallery. The
	// slide step is measured from the rendered offsets so it always matches
	// the CSS (full-width slide minus the next-slide peek, plus the gap).
	function buildGalleryNav(grid, count) {
		var nav = el("div", { class: "biwa-sheet-gallery-nav" });
		var prev = el("button", {
			class: "biwa-gallery-btn",
			type: "button",
			"aria-label": t("Previous photo"),
			text: "‹",
		});
		var counter = el("span", { class: "biwa-gallery-count" });
		var next = el("button", {
			class: "biwa-gallery-btn",
			type: "button",
			"aria-label": t("Next photo"),
			text: "›",
		});
		var reduced =
			window.matchMedia &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		function slideStep() {
			var imgs = grid.querySelectorAll("img");
			return imgs.length > 1
				? imgs[1].offsetLeft - imgs[0].offsetLeft
				: grid.clientWidth;
		}
		function currentIndex() {
			var step = slideStep();
			return step ? Math.round(grid.scrollLeft / step) : 0;
		}
		function paint() {
			var i = Math.min(count - 1, Math.max(0, currentIndex()));
			counter.textContent = i + 1 + " / " + count;
			prev.disabled = i <= 0;
			next.disabled = i >= count - 1;
		}
		function stepTo(dir) {
			var i = Math.min(count - 1, Math.max(0, currentIndex() + dir));
			grid.scrollTo({
				left: i * slideStep(),
				behavior: reduced ? "auto" : "smooth",
			});
		}
		prev.addEventListener("click", function () {
			stepTo(-1);
		});
		next.addEventListener("click", function () {
			stepTo(1);
		});
		// Swipe/scroll lands anywhere — the counter follows the settled slide.
		grid.addEventListener("scroll", paint);
		grid.addEventListener("keydown", function (ev) {
			if (ev.key === "ArrowLeft") {
				ev.preventDefault();
				stepTo(-1);
			}
			if (ev.key === "ArrowRight") {
				ev.preventDefault();
				stepTo(1);
			}
		});
		nav.appendChild(prev);
		nav.appendChild(counter);
		nav.appendChild(next);
		// offsetLeft is only meaningful once the slides are laid out.
		window.requestAnimationFrame(paint);
		return nav;
	}

	// --- dialogs ---------------------------------------------------------------------
	function openDialog(dialog, trigger) {
		dialogTrigger = trigger || document.activeElement;
		store.setEditorActive(true);
		dialog.showModal();
	}

	// Add a stop: pick any catalogue place (incl. all official alternatives).
	function openAddStopDialog() {
		var day = currentDay(store.trip);
		els["biwa-stop-dialog-title"].textContent = t("Add stop to {day}", {
			day: dayLabel(day),
		});
		var body = els["biwa-stop-dialog-body"];
		body.innerHTML = "";
		var field = el("div", { class: "biwa-field" });
		field.appendChild(
			el("label", { for: "biwa-stop-place", text: t("Place") }),
		);
		var sel = el("select", { id: "biwa-stop-place" });
		var catalogue = Rules.placesById(store.trip);
		(store.trip.places || [])
			.slice()
			.filter(function (p) {
				// Route anchors are not check-in destinations, and the legacy
				// station record is hidden while its canonical record exists —
				// neither is offered as an addable stop.
				if (p.category === "route-waypoint") return false;
				return !(
					p.placeId === "extra-takashima-station" &&
					catalogue["official-west-information"]
				);
			})
			.sort(function (a, b) {
				return placeName(a).localeCompare(placeName(b));
			})
			.forEach(function (p) {
				sel.appendChild(
					el("option", { value: p.placeId, text: placeName(p) }),
				);
			});
		field.appendChild(sel);
		field.appendChild(
			el("p", {
				class: "biwa-field-hint",
				text: t(
					"The full catalogue is listed — official checkpoints you add appear in the itinerary without affecting stamp progress until ticked.",
				),
			}),
		);
		body.appendChild(field);
		els["biwa-stop-dialog-save"].onclick = function () {
			var placeId = sel.value;
			if (!placeId) return;
			var saved = store.save(function (draft) {
				var d = draft.days.filter(function (x) {
					return x.dayId === day.dayId;
				})[0];
				// 27 locations/day incl. endpoints is the provider route cap.
				if (d.stops.length >= Rules.MAX_STOPS_PER_DAY) return;
				d.stops.push({
					occurrenceId: newOccurrenceId(d),
					placeId: placeId,
				});
			});
			els["biwa-stop-dialog"].close();
			return saved;
		};
		openDialog(els["biwa-stop-dialog"]);
	}

	function newOccurrenceId(day) {
		return (
			day.dayId +
			"-s" +
			Date.now().toString(36) +
			Math.floor(Math.random() * 36).toString(36)
		);
	}

	// Create or edit a place. Source certificate coordinates are fixed; user
	// places (custom/parking/accommodation) expose coordinates, Google place
	// id and address — coordinates stay optional when either resolver exists.
	// The category select is explicit: 'parking' means the group's confirmed
	// bike-friendly parking list — the only places allowed to carry that label.
	function openPlaceDialog(place) {
		var isNew = !place;
		var isUserPlace =
			isNew ||
			place.category === "custom" ||
			place.category === "parking" ||
			place.category === "accommodation";
		els["biwa-stop-dialog-title"].textContent = isNew
			? t("New custom place")
			: t("Edit {name}", { name: placeName(place) });
		var body = els["biwa-stop-dialog-body"];
		body.innerHTML = "";

		var labelField = el("div", { class: "biwa-field" });
		labelField.appendChild(
			el("label", { for: "biwa-place-label", text: t("Name") }),
		);
		var labelInput = el("input", {
			id: "biwa-place-label",
			type: "text",
			value: isNew ? "" : place.label,
			maxlength: "200",
		});
		labelField.appendChild(labelInput);
		body.appendChild(labelField);

		var catSel = null;
		if (isNew) {
			var catField = el("div", { class: "biwa-field" });
			catField.appendChild(
				el("label", { for: "biwa-place-category", text: t("Kind") }),
			);
			catSel = el("select", { id: "biwa-place-category" });
			catSel.appendChild(
				el("option", { value: "custom", text: t("Custom stop") }),
			);
			catSel.appendChild(
				el("option", {
					value: "accommodation",
					text: t("Accommodation"),
				}),
			);
			catSel.appendChild(
				el("option", {
					value: "parking",
					text: t("Bike-friendly parking (confirmed by the group)"),
				}),
			);
			catField.appendChild(catSel);
			catField.appendChild(
				el("p", {
					class: "biwa-field-hint",
					text: t(
						"Only choose parking for spots the group has actually confirmed — that label is what marks it bike-friendly.",
					),
				}),
			);
			body.appendChild(catField);
		}

		var latInput, lngInput, gidInput, addressInput;
		if (isUserPlace) {
			var row = el("div", { class: "biwa-field-row" });
			var latField = el("div", { class: "biwa-field" });
			latField.appendChild(
				el("label", { for: "biwa-place-lat", text: t("Latitude") }),
			);
			latInput = el("input", {
				id: "biwa-place-lat",
				type: "number",
				step: "any",
				value: isNew || place.lat == null ? "" : place.lat,
			});
			latField.appendChild(latInput);
			var lngField = el("div", { class: "biwa-field" });
			lngField.appendChild(
				el("label", { for: "biwa-place-lng", text: t("Longitude") }),
			);
			lngInput = el("input", {
				id: "biwa-place-lng",
				type: "number",
				step: "any",
				value: isNew || place.lng == null ? "" : place.lng,
			});
			lngField.appendChild(lngInput);
			row.appendChild(latField);
			row.appendChild(lngField);
			body.appendChild(row);
			var gidField = el("div", { class: "biwa-field" });
			gidField.appendChild(
				el("label", {
					for: "biwa-place-gid",
					text: t("Google place id (optional)"),
				}),
			);
			gidInput = el("input", {
				id: "biwa-place-gid",
				type: "text",
				placeholder: "ChIJ…",
				value: isNew || !place.googlePlaceId ? "" : place.googlePlaceId,
			});
			gidField.appendChild(gidInput);
			body.appendChild(gidField);
			var addressField = el("div", { class: "biwa-field" });
			addressField.appendChild(
				el("label", {
					for: "biwa-place-address",
					text: t("Address (optional)"),
				}),
			);
			addressInput = el("input", {
				id: "biwa-place-address",
				type: "text",
				maxlength: "300",
				value: isNew || !place.address ? "" : place.address,
			});
			addressField.appendChild(addressInput);
			body.appendChild(addressField);
			body.appendChild(
				el("p", {
					class: "biwa-field-hint",
					text: t(
						"Enter coordinates or a Google place id or an address — at least one is needed so the place can be found.",
					),
				}),
			);
		} else {
			body.appendChild(
				el("p", {
					class: "biwa-field-hint",
					text: t(
						"Certificate checkpoint coordinates and Google ids are fixed; only the name and notes can be edited.",
					),
				}),
			);
		}

		var notesField = el("div", { class: "biwa-field" });
		notesField.appendChild(
			el("label", { for: "biwa-place-notes", text: t("Notes") }),
		);
		var notesInput = el("textarea", { id: "biwa-place-notes", rows: "3" });
		notesInput.value = isNew ? "" : place.notes || "";
		notesField.appendChild(notesInput);
		body.appendChild(notesField);

		els["biwa-stop-dialog-save"].onclick = function () {
			var label = labelInput.value.trim();
			if (!label) {
				labelInput.focus();
				return;
			}
			if (isUserPlace) {
				var lat =
					latInput.value === "" ? null : parseFloat(latInput.value);
				var lng =
					lngInput.value === "" ? null : parseFloat(lngInput.value);
				var gid = gidInput.value.trim() || null;
				var addr = addressInput.value.trim() || null;
				if ((lat == null) !== (lng == null)) {
					latInput.focus();
					return;
				}
				if (
					lat != null &&
					(!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180))
				) {
					latInput.focus();
					return;
				}
				if (lat == null && !gid && !addr) {
					gidInput.focus();
					return;
				}
				var category = isNew ? catSel.value : place.category;
				store.save(function (draft) {
					var target;
					if (isNew) {
						target = {
							placeId: "custom-" + Date.now().toString(36),
							category: category,
							programmes: [],
							nameConfirmed: true,
						};
						// 'parking' places are the curated bike-friendly list.
						if (category === "parking") target.bikeFriendly = true;
						draft.places.push(target);
					} else {
						target = draft.places.filter(function (p) {
							return p.placeId === place.placeId;
						})[0];
					}
					target.label = label;
					target.lat = lat;
					target.lng = lng;
					target.googlePlaceId = gid;
					target.address = addr;
					target.notes = notesInput.value;
				});
			} else {
				store.save(function (draft) {
					var target = draft.places.filter(function (p) {
						return p.placeId === place.placeId;
					})[0];
					target.label = label;
					target.notes = notesInput.value;
				});
			}
			els["biwa-stop-dialog"].close();
		};
		openDialog(els["biwa-stop-dialog"]);
	}

	// Endpoint editor: existing place or typed coordinates — prefilled with the
	// current value. Saving a day's END also fills the NEXT day's start (the
	// shared overnight boundary: riders sleep where they stopped).
	function openEndpointDialog(day, which) {
		var current = day[which];
		els["biwa-endpoint-dialog-title"].textContent =
			t(which === "start" ? "Start point" : "Overnight point") +
			" — " +
			dayLabel(day);
		var body = els["biwa-endpoint-dialog-body"];
		body.innerHTML = "";

		var field = el("div", { class: "biwa-field" });
		field.appendChild(
			el("label", {
				for: "biwa-endpoint-place",
				text: t("Choose an existing place"),
			}),
		);
		var sel = el("select", { id: "biwa-endpoint-place" });
		sel.appendChild(
			el("option", {
				value: "",
				text: t("— or enter coordinates below —"),
			}),
		);
		var endpointCatalogue = Rules.placesById(store.trip);
		(store.trip.places || [])
			.slice()
			.filter(function (p) {
				// Route anchors and the hidden legacy station record are never
				// offered as start/overnight destinations either.
				if (p.category === "route-waypoint") return false;
				return !(
					p.placeId === "extra-takashima-station" &&
					endpointCatalogue["official-west-information"]
				);
			})
			.sort(function (a, b) {
				return placeName(a).localeCompare(placeName(b));
			})
			.forEach(function (p) {
				sel.appendChild(
					el("option", { value: p.placeId, text: placeName(p) }),
				);
			});
		if (current && current.placeId) sel.value = current.placeId;
		field.appendChild(sel);
		body.appendChild(field);

		var pinLabelField = el("div", { class: "biwa-field" });
		pinLabelField.appendChild(
			el("label", {
				for: "biwa-endpoint-pinlabel",
				text: t("Point label"),
			}),
		);
		var pinLabel = el("input", {
			id: "biwa-endpoint-pinlabel",
			type: "text",
			placeholder: t("e.g. Hotel in Hikone"),
			value: current && current.pin ? current.pin.label || "" : "",
		});
		pinLabelField.appendChild(pinLabel);
		body.appendChild(pinLabelField);
		var row2 = el("div", { class: "biwa-field-row" });
		var latField = el("div", { class: "biwa-field" });
		latField.appendChild(
			el("label", { for: "biwa-endpoint-lat", text: t("Latitude") }),
		);
		var latInput = el("input", {
			id: "biwa-endpoint-lat",
			type: "number",
			step: "any",
			value: current && current.pin ? current.pin.lat : "",
		});
		latField.appendChild(latInput);
		var lngField = el("div", { class: "biwa-field" });
		lngField.appendChild(
			el("label", { for: "biwa-endpoint-lng", text: t("Longitude") }),
		);
		var lngInput = el("input", {
			id: "biwa-endpoint-lng",
			type: "number",
			step: "any",
			value: current && current.pin ? current.pin.lng : "",
		});
		lngField.appendChild(lngInput);
		row2.appendChild(latField);
		row2.appendChild(lngField);
		body.appendChild(row2);
		if (which === "end") {
			body.appendChild(
				el("p", {
					class: "biwa-field-hint",
					text: t(
						"This also becomes the next day’s start — the group sleeps where the day ended.",
					),
				}),
			);
		}

		var clearBtn = el("button", {
			class: "biwa-btn-inline",
			type: "button",
			text: t("Clear endpoint"),
			dataset: { tone: "danger" },
		});
		clearBtn.addEventListener("click", function () {
			// A cancelled confirm keeps the editor open — nothing is written.
			if (saveEndpoint(day, which, null))
				els["biwa-endpoint-dialog"].close();
		});
		body.appendChild(clearBtn);

		els["biwa-endpoint-dialog-save"].onclick = function () {
			var endpoint = null;
			if (sel.value) {
				endpoint = { placeId: sel.value };
			} else if (latInput.value !== "" && lngInput.value !== "") {
				var lat = parseFloat(latInput.value),
					lng = parseFloat(lngInput.value);
				if (
					!(lat >= -90 && lat <= 90) ||
					!(lng >= -180 && lng <= 180)
				) {
					latInput.focus();
					return;
				}
				endpoint = {
					pin: {
						label: pinLabel.value.trim() || "Pinned point",
						lat: lat,
						lng: lng,
					},
				};
			} else {
				els["biwa-endpoint-dialog"].close();
				return;
			}
			if (saveEndpoint(day, which, endpoint))
				els["biwa-endpoint-dialog"].close();
		};
		openDialog(els["biwa-endpoint-dialog"]);
	}

	// Boundary edit → one atomic store.write: the planner module decides the
	// touched fields, the visit keys to retire and whether the change is
	// destructive enough to confirm. Returns false when the user cancels —
	// no save, no progress change, and the dialog stays open.
	function saveEndpoint(day, which, endpoint) {
		var plan =
			window.BiwaEndpointChange &&
			window.BiwaEndpointChange.planEndpointChange(
				store.trip,
				day.dayId,
				which,
				endpoint,
			);
		if (!plan) return false;
		if (plan.needsConfirmation) {
			var message =
				endpoint === null
					? t(
							"Clear this destination? The connected day boundary will also be cleared and its arrival completion marks removed. This cannot be undone.",
						)
					: t(
							"Change this destination? Existing arrival completion marks for this day boundary will be reset. This cannot be undone.",
						);
			if (!window.confirm(message)) return false;
		}
		store.save(
			function (draft) {
				plan.updates.forEach(function (u) {
					var target = draft.days.findIndex(function (d) {
						return d.dayId === u.dayId;
					});
					if (target >= 0) {
						draft.days[target][u.which] = u.endpoint
							? JSON.parse(JSON.stringify(u.endpoint))
							: null;
					}
				});
			},
			{ clearVisitIds: plan.clearVisitIds },
		);
		return true;
	}

	// --- map view -------------------------------------------------------------------
	// Lazy: the map page only initialises when its tab is first shown, and the
	// provider key comes from the public trip GET (browser config is not tied
	// to the shared-state backend being up).
	function initMapPage() {
		renderMapLegend();
		renderDayRoutesPanel();
		var key = store.browserMapsKey || null;
		// A key arriving after a keyless first visit must retry the loader —
		// but only once per key value, so a failed attempt never re-spends.
		if (mapInitialised && (!key || key === mapsKeyAttempted)) {
			// The schematic + its caveat painted once on the failure path — a
			// language switch lands here via render(), so repaint it in the
			// active language (renderSchematic replaces the whole canvas).
			if (!mapPage && schematicNote) paintMapSchematic(t(schematicNote));
			refreshMapContent();
			return;
		}
		mapInitialised = true;
		var canvas = els["biwa-map-canvas"];
		if (!key) {
			mapsNs = null;
			schematicNote =
				"Live map needs a configured Google Maps key — the stop schematic below is drawn from your own list.";
			paintMapSchematic(t(schematicNote));
			markAllDaysBlocked("map key not configured");
			return;
		}
		mapsKeyAttempted = key;
		Preview.loadMaps(key).then(function (ns) {
			mapsNs = ns;
			if (!ns) {
				schematicNote =
					"Live map unavailable — showing your stop order only.";
				paintMapSchematic(t(schematicNote));
				markAllDaysBlocked("map unavailable");
				return;
			}
			mapPage = Preview.createMapPage(canvas, ns);
			if (!mapPage) {
				schematicNote =
					"Live map unavailable — showing your stop order only.";
				paintMapSchematic(t(schematicNote));
				markAllDaysBlocked("map unavailable");
				return;
			}
			schematicNote = null;
			els["biwa-map-attribution"].hidden = false;
			refreshMapContent();
		});
	}

	// Null-coordinate places (lodgings, address-only stops) are never
	// bulk-fetched: opening a place's card resolves it transiently, and the
	// map gains its marker then — the trip snapshot never gains provider
	// coordinates.

	// Full repaint path: markers + polylines + per-day route requests.
	function refreshMapContent() {
		refreshMapMarkers();
		refreshDayRoutes();
		renderDayRoutesPanel();
		// Scheduled route-waypoint anchors carry a Google id but no stored
		// coordinates, and their clicks are suppressed — resolve them through
		// the shared details cache so their quiet dots can actually plot.
		// Scoped to scheduled waypoints only (the two known anchors): no other
		// places are fetched here, and maybeFetchDetails stays once-per-place
		// and capability-gated. Runs only from the map view's repaint path.
		var placesById = Rules.placesById(store.trip);
		(store.trip.days || []).forEach(function (day) {
			(day.stops || []).forEach(function (stop) {
				var p = placesById[stop.placeId];
				if (
					p &&
					p.category === "route-waypoint" &&
					typeof p.lat !== "number" &&
					!transientLocations[p.placeId]
				) {
					maybeFetchDetails(p);
				}
			});
		});
	}

	// Marker positions signature — fitBounds only re-runs when the plotted
	// set actually changes, so poll re-renders never steal the user's pan.
	var mapMarkersSig = null;

	// The English reason the stop schematic is showing (map key/loader
	// failure) — kept so a language toggle can repaint it translated.
	var schematicNote = null;

	// Programme memberships → the filter keys that govern a marker plus the
	// official shore area that recolours it. A place with no programme falls
	// back to its kind (stay vs other stop).
	function markerArea(p) {
		var area = null;
		Rules.OFFICIAL_AREAS.forEach(function (a) {
			if (p.programmes && p.programmes.indexOf(a.programme) !== -1)
				area = a.key;
		});
		return area;
	}

	function markerFilterKeys(p) {
		var keys = [];
		Rules.OFFICIAL_AREAS.forEach(function (a) {
			if (p.programmes && p.programmes.indexOf(a.programme) !== -1)
				keys.push(a.programme);
		});
		if (p.programmes && p.programmes.indexOf("rally") !== -1)
			keys.push("rally");
		if (!keys.length)
			keys.push(
				p.category === "accommodation" ? "accommodation" : "extra",
			);
		return keys;
	}

	// A marker fills in once its place is visited: programme checkpoints read
	// the shared family check; accommodation/extra places read their manual
	// arrival ticks — any visited occurrence across all days (stops AND
	// endpoints) counts.
	function markerVisited(trip, place) {
		if (Rules.programmeFamilies(place.programmes).length) {
			return Rules.placeProgrammeChecked(trip, place);
		}
		return (trip.days || []).some(function (day) {
			return Rules.dayPoints(trip, day).some(function (p) {
				return p.placeId === place.placeId && p.visited;
			});
		});
	}

	function refreshMapMarkers() {
		if (!mapPage || !store.trip) return;
		var placesById = Rules.placesById(store.trip);
		var items = (store.trip.places || [])
			.filter(function (p) {
				// The legacy station record is the same physical stop as the
				// canonical information centre — one pin only, never a duplicate.
				return !(
					p.placeId === "extra-takashima-station" &&
					placesById["official-west-information"]
				);
			})
			.map(function (p) {
				var loc =
					typeof p.lat === "number"
						? { lat: p.lat, lng: p.lng }
						: transientLocations[p.placeId];
				return {
					key: p.placeId + "|" + markerFilterKeys(p).join("+"),
					lat: loc ? loc.lat : null,
					lng: loc ? loc.lng : null,
					label:
						p.category === "route-waypoint"
							? placeName(p) + " " + t("(route point)")
							: placeName(p),
					shape: Preview.markerShape(p),
					area: markerArea(p),
					visited: markerVisited(store.trip, p),
					// Route-waypoint anchors plot as quiet dots but open no sheet.
					onClick:
						p.category === "route-waypoint"
							? null
							: function () {
									openSheet({
										place: p,
										occurrenceId: null,
										day: null,
										kind: "map",
									});
								},
				};
			});
		mapPage.setMarkers(items);
		// A shared checkpoint stays visible while ANY of its families is on —
		// the rally chip alone keeps Mizudori, and so does its shore chip.
		mapPage.setMarkerVisible(function (key) {
			return key
				.split("|")[1]
				.split("+")
				.some(function (k) {
					return mapFilters[k];
				});
		});
		var coords = items.filter(function (i) {
			return i.lat != null;
		});
		var sig = JSON.stringify(
			coords.map(function (c) {
				return [c.lat, c.lng];
			}),
		);
		if (coords.length && sig !== mapMarkersSig) {
			mapMarkersSig = sig;
			mapPage.fitBounds(coords);
		}
	}

	function refreshDayRoutes() {
		if (!mapPage || !store.trip) return;
		(store.trip.days || []).forEach(function (day) {
			maybeRequestDayRoute(day);
		});
		paintPolylines();
	}

	function paintPolylines() {
		if (!mapPage) return;
		mapPage.setPolylines(
			(store.trip.days || []).map(function (day) {
				var state = dayRoutes[day.dayId];
				return {
					dayId: day.dayId,
					path: state && state.path,
					visible: dayLineVisible[day.dayId] !== false,
				};
			}),
		);
	}

	// Issue (or skip) the provider request for one day. Signature covers the
	// routable anchors only — visit/programme ticks never re-request.
	function maybeRequestDayRoute(day) {
		var routed = Rules.routePoints(store.trip, day);
		var state =
			dayRoutes[day.dayId] || (dayRoutes[day.dayId] = { status: "idle" });
		if (DEV_NO_ROUTES) {
			state.status = "idle"; // never request — renders 'not requested'
			renderDayRoutesPanel();
			refreshTrackGaps();
			return;
		}
		if (!day.start || !day.end) {
			// Missing endpoints are an explicit configuration state, not a
			// silently partial route.
			state.status = "missing";
			state.error =
				(!day.start ? "start" : "") +
				(!day.start && !day.end ? " + " : "") +
				(!day.end ? "overnight" : "") +
				" point not set";
			renderDayRoutesPanel();
			refreshTrackGaps();
			return;
		}
		var signature = JSON.stringify(routed.points);
		if (routed.unroutable.length) {
			// A day with unroutable anchors gets NO partial route — the request
			// holds until every anchor can be positioned (a transient resolve
			// changes the signature, which re-evaluates this path).
			state.signature = signature;
			state.status = "unroutable";
			// Unroutable entries are label strings — resolve them back to their
			// place so Chinese swaps catalogue names while user-authored pin
			// labels keep their own text.
			var unroutablePlaces = Rules.placesById(store.trip);
			state.error =
				t("road preview waiting for coordinates — unroutable: ") +
				routed.unroutable
					.map(function (n) {
						var match = Object.keys(unroutablePlaces).filter(
							function (id) {
								return unroutablePlaces[id].label === n;
							},
						)[0];
						return match
							? placeName(unroutablePlaces[match])
							: t(n);
					})
					.join(", ");
			state.path = null;
			renderDayRoutesPanel();
			refreshTrackGaps();
			return;
		}
		if (
			state.signature === signature &&
			(state.status === "pending" ||
				state.status === "ok" ||
				state.status === "error" ||
				state.status === "blocked")
		) {
			return; // already fetched for these points; retries need a user event
		}
		state.signature = signature;
		state.requestId = Preview.newRequestId();
		state.status = "pending";
		state.path = null;
		state.error = null;
		renderDayRoutesPanel();
		refreshTrackGaps();
		var requestId = state.requestId;
		store
			.fetchRoute(day.dayId, routed.points, requestId)
			.then(function (body) {
				var now = dayRoutes[day.dayId];
				// Drop stale answers: rotated requestId, moved-on signature or a
				// day-id mismatch. A poll/tick replacing the TRIP OBJECT must not
				// strand this response — compare the day's routable anchors, not
				// the trip's object identity.
				if (
					!now ||
					now.requestId !== requestId ||
					now.signature !== signature ||
					(body && body.dayId && body.dayId !== day.dayId)
				)
					return;
				var freshDay = (store.trip ? store.trip.days || [] : []).filter(
					function (d) {
						return d.dayId === day.dayId;
					},
				)[0];
				var freshSignature = freshDay
					? JSON.stringify(
							Rules.routePoints(store.trip, freshDay).points,
						)
					: null;
				if (freshSignature !== signature) {
					// Anchors moved under the in-flight call — request anew, but only
					// while a consuming view (map or timeline) is live — no spend from
					// a hidden view.
					var timelineLive = document
						.getElementById("view-timeline")
						.classList.contains("is-active");
					var mapLive =
						mapPage &&
						document
							.getElementById("view-map")
							.classList.contains("is-active");
					if (freshDay && (timelineLive || mapLive)) {
						maybeRequestDayRoute(freshDay);
					}
					return;
				}
				if (!body || !body.ok || !body.route) {
					now.status = "error";
					now.error =
						body && body.error === "provider_blocked"
							? "blocked"
							: "unavailable";
					renderDayRoutesPanel();
					refreshTrackGaps();
					return;
				}
				now.status = "ok";
				now.path = Preview.decodePolyline(body.route.polyline || "");
				now.distanceMeters = body.route.distanceMeters;
				now.legsMeters = body.route.legsMeters;
				now.elevation = body.elevation;
				paintPolylines();
				renderDayRoutesPanel();
				// Update ONLY the gap texts — a full track repaint here would kill an
				// in-flight drag and steal focus.
				refreshTrackGaps();
			});
	}

	function markAllDaysBlocked(reason) {
		(store.trip ? store.trip.days : []).forEach(function (day) {
			dayRoutes[day.dayId] = {
				status: "blocked",
				error: reason,
				signature: null,
				path: null,
			};
		});
		renderDayRoutesPanel();
		refreshTrackGaps();
	}

	// User-initiated retry only — a blocked/erroring day never re-requests on
	// its own (no polling spend).
	function retryDayRoute(dayId) {
		var day = (store.trip.days || []).filter(function (d) {
			return d.dayId === dayId;
		})[0];
		if (!day || !mapPage) return;
		var state = dayRoutes[dayId];
		if (state) state.signature = null; // force the next request
		maybeRequestDayRoute(day);
	}

	// Whole-trip schematic (user-owned points only) when there is no live map.
	function paintMapSchematic(note) {
		var canvas = els["biwa-map-canvas"];
		var points = [];
		// The fallback schematic is still a route preview — hidden waypoints
		// belong in its point set even though no itinerary list shows them.
		(store.trip ? store.trip.days : []).forEach(function (day) {
			Rules.dayPoints(store.trip, day).forEach(function (p) {
				if (typeof p.lat === "number" && typeof p.lng === "number")
					points.push(p);
			});
		});
		if (points.length >= 2) Preview.renderSchematic(canvas, points);
		else canvas.innerHTML = "";
		els["biwa-map-attribution"].hidden = true;
		canvas.appendChild(el("p", { class: "biwa-caveat", text: note }));
	}

	// --- interactive legend -----------------------------------------------------
	// The legend doubles as the layer control: each entry carries the marker
	// glyph or day-line swatch, its label and an eye state icon, so show/hide
	// never rides on colour alone. Both eyes are flat single-colour fills like
	// every other icon — the pupil ring is punched out of the almond with
	// fill-rule="evenodd" and refilled as a smaller disc.
	var EYE_ON_SVG =
		'<svg viewBox="0 0 22 22" width="16" height="16" aria-hidden="true">' +
		'<g fill="currentColor">' +
		'<path fill-rule="evenodd" d="M11 5.4C6.4 5.4 3.1 8.4 1.9 10.9c1.2 2.5 4.5 5.5 9.1 5.5s7.9-3 9.1-5.5c-1.2-2.5-4.5-5.5-9.1-5.5zm0 8.7a3.3 3.3 0 1 1 0-6.6 3.3 3.3 0 0 1 0 6.6z"/>' +
		'<circle cx="11" cy="10.8" r="1.5"/>' +
		"</g></svg>";
	var EYE_OFF_SVG =
		'<svg viewBox="0 0 22 22" width="16" height="16" aria-hidden="true">' +
		'<g fill="currentColor">' +
		'<path fill-rule="evenodd" d="M11 5.4C6.4 5.4 3.1 8.4 1.9 10.9c1.2 2.5 4.5 5.5 9.1 5.5s7.9-3 9.1-5.5c-1.2-2.5-4.5-5.5-9.1-5.5zm0 8.7a3.3 3.3 0 1 1 0-6.6 3.3 3.3 0 0 1 0 6.6z"/>' +
		'<rect x="-1.5" y="9.95" width="25" height="1.9" rx="0.95" transform="rotate(-35 11 11)"/>' +
		"</g></svg>";

	// One legend toggle: visual (swatch or glyph) + label + eye icon.
	// onToggle flips the shared state and returns the new visibility; the
	// button's own aria/icon are then updated in place so a tap never rebuilds
	// the row under the user's finger.
	function legendToggle(visual, label, pressed, focusKey, onToggle) {
		var item = el("button", {
			class: "biwa-legend-item",
			type: "button",
			"aria-pressed": String(pressed),
			"data-focus-key": focusKey,
		});
		item.appendChild(visual);
		item.appendChild(
			el("span", { class: "biwa-legend-label", text: label }),
		);
		var eye = el("span", {
			class: "biwa-legend-eye",
			"aria-hidden": "true",
			html: pressed ? EYE_ON_SVG : EYE_OFF_SVG,
		});
		item.appendChild(eye);
		item.addEventListener("click", function () {
			var now = onToggle();
			item.setAttribute("aria-pressed", String(now));
			eye.innerHTML = now ? EYE_ON_SVG : EYE_OFF_SVG;
		});
		return item;
	}

	// Day route lines first (their swatch is the line colour), then the marker
	// categories — official shore circles in area colours, then the other
	// kinds. Toggling a day repaints polylines; toggling a category repaints
	// markers.
	function renderMapLegend() {
		var host = els["biwa-map-legend"];
		host.innerHTML = "";
		(store.trip ? store.trip.days : []).forEach(function (day) {
			var dayId = day.dayId;
			var swatch = el("span", {
				class: "biwa-legend-swatch",
				"aria-hidden": "true",
				dataset: { day: dayId },
			});
			host.appendChild(
				legendToggle(
					swatch,
					t("{day} route", { day: dayLabel(day) }),
					dayLineVisible[dayId] !== false,
					"dayline-" + dayId,
					function () {
						dayLineVisible[dayId] =
							dayLineVisible[dayId] === false ? true : false;
						paintPolylines();
						return dayLineVisible[dayId];
					},
				),
			);
		});
		Rules.OFFICIAL_AREAS.map(function (a) {
			return {
				key: a.programme,
				label: areaText(a),
				shape: "official",
				shapeKey: a.key,
			};
		})
			.concat([
				{ key: "rally", label: t("Rally stops"), shape: "rally" },
				{
					key: "accommodation",
					label: t("Stays"),
					shape: "accommodation",
				},
				{
					key: "extra",
					label: t("Other stops / route points"),
					shape: "extra",
				},
			])
			.forEach(function (f) {
				var shape = el("span", {
					class: "biwa-legend-shape",
					"aria-hidden": "true",
				});
				shape.innerHTML = Preview.legendShapeSvg(f.shape, f.shapeKey);
				host.appendChild(
					legendToggle(
						shape,
						f.label,
						!!mapFilters[f.key],
						"filter-" + f.key,
						function () {
							mapFilters[f.key] = !mapFilters[f.key];
							refreshMapMarkers();
							return mapFilters[f.key];
						},
					),
				);
			});
	}

	// Per-day status rows: distance when routed, the specific blocked reason
	// when not, and a read-only list of the day's locations with their
	// manual check-in state. The map is viewing-only — no external directions
	// links, and the list never opens the sheet or ticks anything.
	// Filled status dots: solid green disc with a white check polygon when
	// done, a quiet petal disc with a rosy inner dot while pending — no
	// outlined shapes.
	var DAYLOC_CHECK_SVG =
		'<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
		'<circle cx="8" cy="8" r="7" fill="var(--biwa-success)"/>' +
		'<path d="M4.4 8.2 5.9 6.7 7.1 8.2 10.9 4.5 12.1 6.1 7.1 11.2z" fill="#fff"/></svg>';
	var DAYLOC_EMPTY_SVG =
		'<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
		'<circle cx="8" cy="8" r="7" fill="var(--biwa-petal)"/>' +
		'<circle cx="8" cy="8" r="2" fill="var(--biwa-rosy)"/></svg>';

	// One static list item: name, an optional quiet endpoint role, and the
	// visited status exactly as the timeline computes it (no GPS inference).
	function dayRouteLocationItem(name, role, visited, missing) {
		var li = el("li", { class: "biwa-dayroute-location" });
		if (missing) li.dataset.missing = "true";
		var nameSpan = el("span", { class: "biwa-dayroute-locname" }, [
			document.createTextNode(name),
		]);
		if (role) {
			// The role rides inline after the name so it reads as a quiet
			// qualifier — never squeezed over to the status side.
			nameSpan.appendChild(
				el("span", {
					class: "biwa-dayroute-locrole",
					text: " · " + role,
				}),
			);
		}
		li.appendChild(nameSpan);
		li.appendChild(
			el(
				"span",
				{
					class: "biwa-dayroute-status",
					dataset: { done: String(visited) },
				},
				[
					el("span", {
						class: "biwa-dayroute-status-icon",
						"aria-hidden": "true",
						html: visited ? DAYLOC_CHECK_SVG : DAYLOC_EMPTY_SVG,
					}),
					el("span", { text: t(visited ? "Completed" : "Pending") }),
				],
			),
		);
		return li;
	}

	// The ordered location list for one day — start, stops, finish from
	// Rules.visibleDayPoints (hidden route anchors steer the road line but
	// are not listed destinations). Missing endpoints render as explicit
	// static "not set" rows at their real positions.
	function dayRouteLocationList(trip, day) {
		var points = Rules.visibleDayPoints(trip, day);
		var ol = el("ol", { class: "biwa-dayroute-locations" });
		if (!points.length) {
			ol.appendChild(
				el("li", { class: "biwa-dayroute-location" }, [
					el("span", {
						class: "biwa-dayroute-locname",
						text: t("No locations planned"),
					}),
				]),
			);
			return ol;
		}
		if (points[0].kind !== "start") {
			ol.appendChild(
				dayRouteLocationItem(
					t("Start point not set"),
					null,
					false,
					true,
				),
			);
		}
		points.forEach(function (p) {
			var role =
				p.kind === "start"
					? t("Start")
					: p.kind === "end"
						? t("Finish")
						: null;
			ol.appendChild(
				dayRouteLocationItem(placeName(p), role, p.visited, false),
			);
		});
		if (points[points.length - 1].kind !== "end") {
			ol.appendChild(
				dayRouteLocationItem(
					t("Finish point not set"),
					null,
					false,
					true,
				),
			);
		}
		return ol;
	}

	function renderDayRoutesPanel() {
		var host = els["biwa-day-routes"];
		host.innerHTML = "";
		if (!store.trip) return;
		(store.trip.days || []).forEach(function (day) {
			var state = dayRoutes[day.dayId] || {};
			var row = el("div", {
				class: "biwa-dayroute-row",
				dataset: { day: day.dayId },
			});
			var heading = el("div", { class: "biwa-dayroute-heading" });
			heading.appendChild(el("strong", { text: dayLabel(day) }));
			var meta = "";
			if (state.status === "pending")
				meta = t("requesting road preview…");
			else if (state.status === "ok") {
				meta =
					state.distanceMeters != null
						? t("{n} km road", {
								n: (state.distanceMeters / 1000).toFixed(1),
							})
						: t("road distance unavailable");
			} else if (
				state.status === "blocked" ||
				state.error === "blocked"
			) {
				meta = t(
					"road preview blocked — enable the Routes API for the Google key",
				);
			} else if (state.status === "missing") {
				meta = t("set the {err} to unlock the road preview", {
					err: t(state.error),
				});
			} else if (state.status === "unroutable") {
				// Named data state, not a provider failure — no Retry button.
				meta = state.error;
			} else if (state.status === "error") {
				meta = t("road preview unavailable");
			} else {
				meta = t("road preview not requested");
			}
			heading.appendChild(
				el("span", { class: "biwa-dayroute-meta", text: meta }),
			);

			var links = el("span", { class: "biwa-dayroute-links" });
			if (
				state.status === "error" ||
				state.status === "blocked" ||
				state.error === "blocked"
			) {
				var retry = el("button", {
					class: "biwa-btn-inline",
					type: "button",
					text: t("Retry"),
					"data-focus-key": "retry-route-" + day.dayId,
				});
				retry.addEventListener("click", function () {
					retryDayRoute(day.dayId);
				});
				links.appendChild(retry);
			}
			heading.appendChild(links);
			row.appendChild(heading);
			row.appendChild(dayRouteLocationList(store.trip, day));
			host.appendChild(row);
		});
	}

	// --- nearby view --------------------------------------------------------------------
	var NEARBY_CATEGORIES = [
		{ key: "sights", label: "Attractions", query: "tourist attractions" },
		{ key: "food", label: "Restaurants", query: "restaurants" },
		{
			key: "stores",
			label: "Convenience stores",
			query: "convenience store",
		},
		{ key: "laundry", label: "Laundromats", query: "laundromat" },
		{ key: "repair", label: "Bike repair", query: "bicycle repair shop" },
		{
			key: "parking",
			label: "Bike parking",
			query: "bicycle parking",
			curated: true,
		},
	];

	// Filled category glyphs for the shortcut grid — solid silhouettes in
	// currentColor (lineless like every other icon), never emoji. The camera
	// path is the same shape as the official-checkpoint map marker.
	var NEARBY_ICONS = {
		sights: '<path d="M6 8.5h2.2l.7-1.2h4.2l.7 1.2H16c.55 0 1 .45 1 1V14c0 .55-.45 1-1 1H6c-.55 0-1-.45-1-1V9.5c0-.55.45-1 1-1zm5 5.7a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z"/>',
		food:
			'<path d="M7 3h1.1v4.6h1.3V3h1.3v4.6h1.3V3h1.1v5.4c0 1.5-1.1 2.7-2.6 2.8V19H9v-7.8C7.8 11.1 7 9.9 7 8.4z"/>' +
			'<path d="M17 3c-1.8 0-3 1.7-3 3.9 0 1.9 1 3.4 2.4 3.9V19h1.4v-8.2c1.4-.5 2.4-2 2.4-3.9C20.2 4.7 18.8 3 17 3z"/>',
		// The bag's ink ran y5–y19.7 (centre ~12.4 in the 22-unit box) — shifted
		// up 1.4 so the glyph's own centre lands on 11 like its neighbours.
		stores: '<path d="M6 5.6h10l1 11a1.5 1.5 0 0 1-1.5 1.7H6.5A1.5 1.5 0 0 1 5 16.6zM9 5.6a2 2 0 0 1 4 0h-1.2a.8.8 0 0 0-1.6 0z"/>',
		laundry:
			'<path d="M5.5 3h11A1.5 1.5 0 0 1 18 4.5v13A1.5 1.5 0 0 1 16.5 19h-11A1.5 1.5 0 0 1 4 17.5v-13A1.5 1.5 0 0 1 5.5 3zM11 7.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM6.6 4.7a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8zM9.6 4.7a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8z" fill-rule="evenodd"/>',
		// The bicycle glyph is drawn on a 24-unit grid — a nested scale group
		// fits it inside the shared 22-unit box without redrawing the shape.
		repair: '<g transform="scale(0.9167)"><path d="M15.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM5 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5zm0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5zm5.8-10l2.4-2.4.8.8c1.3 1.3 3 2.1 5.1 2.1V9c-1.5 0-2.7-.6-3.6-1.5l-1.9-1.9c-.5-.4-1-.6-1.6-.6s-1.1.2-1.4.6L9.4 6.6c-.4.4-.6.9-.6 1.4 0 .6.2 1.1.6 1.4L11 12v5h2v-6.5zM19 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5zm0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z"/></g>',
		parking:
			'<path d="M5 3h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 7v9h1.8v-3.2h2.6a3 3 0 0 0 0-5.8zM10.8 8.6h2.4a1.4 1.4 0 0 1 0 2.8h-2.4z" fill-rule="evenodd"/>',
	};

	// Icon + label pair shared by the Maps-search anchors and the curated
	// parking button, so every shortcut reads the same way.
	function appendShortcutContent(shortcut, cat, labelText) {
		var icon = el("span", {
			class: "biwa-shortcut-icon",
			"aria-hidden": "true",
		});
		icon.innerHTML =
			'<svg viewBox="0 0 22 22" width="19" height="19">' +
			'<g fill="currentColor">' +
			(NEARBY_ICONS[cat.key] || "") +
			"</g></svg>";
		shortcut.appendChild(icon);
		shortcut.appendChild(
			el("span", { class: "biwa-shortcut-label", text: labelText }),
		);
	}

	// Coordinates for a point/place: source coords first, then the transient
	// Google resolution loaded on demand — never stored back.
	function resolvedCoords(item) {
		if (!item) return null;
		if (typeof item.lat === "number" && typeof item.lng === "number") {
			return { lat: item.lat, lng: item.lng };
		}
		var placeId = item.placeId || (item.place && item.place.placeId);
		if (placeId && transientLocations[placeId])
			return transientLocations[placeId];
		return null;
	}

	function renderNearby(trip) {
		renderNearbyExtras();
		renderParking(trip);
	}

	function renderNearbyExtras() {
		renderNearbyContext();
		renderNearbyGrid();
	}

	// The search anchor: the granted GPS fix wins for EVERY shortcut; with no
	// GPS the anchor comes from the plan itself (progress-derived below).
	function nearbyAnchorCoords() {
		if (geoPoint) return geoPoint;
		var plan = nearbyPlanAnchor();
		return plan ? plan.coords : null;
	}

	// Nearest resolved scheduled point across ALL three days to a centre —
	// context display only ("near X"), never a claim about where the rider is.
	function nearestPlanPoint(center) {
		if (!center || !store.trip) return null;
		var best = null;
		(store.trip.days || []).forEach(function (day) {
			Rules.visibleDayPoints(store.trip, day).forEach(function (p) {
				var c = resolvedCoords(p);
				if (!c) return;
				var m = Geo.distanceMeters(center, c);
				if (m == null) return;
				// Strict < keeps ties at the first row in stable itinerary order.
				if (!best || m < best.meters)
					best = { meters: m, point: p, day: day };
			});
		});
		return best;
	}

	// No-GPS anchor derived from completion state: the first day that still
	// has unvisited rows → that day's latest completed row that resolves →
	// else its first unvisited resolved row → else its first resolved row.
	// Every day complete → the final day's end point when it resolves.
	function nearbyPlanAnchor() {
		if (!store.trip) return null;
		var days = store.trip.days || [];
		for (var i = 0; i < days.length; i++) {
			var day = days[i];
			var points = Rules.visibleDayPoints(store.trip, day);
			var hasUnvisited = points.some(function (p) {
				return !p.visited;
			});
			if (!hasUnvisited) continue;
			var latestCompleted = null;
			var firstUnvisited = null;
			var firstResolved = null;
			points.forEach(function (p) {
				var c = resolvedCoords(p);
				if (!c) return;
				if (!firstResolved) firstResolved = p;
				if (p.visited) latestCompleted = p;
				else if (!firstUnvisited) firstUnvisited = p;
			});
			var chosen = latestCompleted || firstUnvisited || firstResolved;
			if (chosen)
				return {
					point: chosen,
					coords: resolvedCoords(chosen),
					day: day,
				};
		}
		var lastDay = days[days.length - 1];
		if (lastDay) {
			var endPoint = Rules.visibleDayPoints(store.trip, lastDay).filter(
				function (p) {
					return p.kind === "end";
				},
			)[0];
			var c = resolvedCoords(endPoint);
			if (endPoint && c)
				return { point: endPoint, coords: c, day: lastDay };
		}
		return null;
	}

	// One honest context line under the button: where searches centre and
	// WHY — granted location, plan anchor, or nothing yet.
	function renderNearbyContext() {
		var note = els["biwa-nearby-anchor-note"];
		if (geoPoint) {
			var nearest = nearestPlanPoint(geoPoint);
			note.textContent = nearest
				? t("Near {name} · {day}", {
						name: placeName(nearest.point),
						day: dayLabel(nearest.day),
					})
				: t("Near your location");
			return;
		}
		var plan = nearbyPlanAnchor();
		note.textContent = plan
			? t("Search area: {name} · based on completed stops", {
					name: placeName(plan.point),
				})
			: t("Update your location to search nearby");
	}

	// Six direct shortcut buttons: plain Google Maps category searches
	// centred on the anchor, disabled outright when no anchor exists.
	function renderNearbyGrid() {
		var grid = els["biwa-nearby-grid"];
		grid.innerHTML = "";
		var anchor = nearbyAnchorCoords();
		var hasParkingList = !!(
			store.trip &&
			(store.trip.places || []).some(function (p) {
				return p.category === "parking";
			})
		);
		NEARBY_CATEGORIES.forEach(function (cat) {
			// Curated parking: scroll to the group's own list when it has spots;
			// an empty list falls back to an ordinary Maps search — never
			// labelled "bike-friendly", that tag belongs to the curated list only.
			if (cat.curated && hasParkingList) {
				var toList = el("button", {
					class: "biwa-nearby-shortcut",
					type: "button",
				});
				appendShortcutContent(
					toList,
					cat,
					t("{cat} — group’s list", { cat: t(cat.label) }),
				);
				toList.addEventListener("click", function () {
					els["biwa-parking-card"].scrollIntoView({
						behavior: "smooth",
						block: "start",
					});
				});
				grid.appendChild(toList);
				return;
			}
			var link = el("a", {
				class: "biwa-nearby-shortcut",
				target: "_blank",
				rel: "noopener noreferrer",
			});
			appendShortcutContent(link, cat, t(cat.label));
			if (anchor) {
				link.href = MapLinks.nearbySearchUrl(cat.query, anchor);
			} else {
				link.setAttribute("aria-disabled", "true");
				link.classList.add("is-disabled");
			}
			grid.appendChild(link);
		});
	}

	// The curated parking list: the whole card collapses when empty — no
	// giant blank card asking for something that isn't there.
	function renderParking(trip) {
		var list = els["biwa-parking-list"];
		list.innerHTML = "";
		var parking = (trip.places || []).filter(function (p) {
			return p.category === "parking";
		});
		els["biwa-parking-card"].hidden = parking.length === 0;
		parking.forEach(function (p) {
			var item = el("li", { class: "biwa-stamp-item" });
			var name = el("button", {
				class: "biwa-stamp-name biwa-card-body",
				type: "button",
				"aria-label": t("{name} — details", { name: placeName(p) }),
			});
			name.appendChild(document.createTextNode(placeName(p) + " "));
			name.appendChild(
				el("span", {
					class: "biwa-badge",
					text: t("Bike-friendly — group curated"),
				}),
			);
			name.addEventListener("click", function () {
				openSheet({
					place: p,
					occurrenceId: null,
					day: null,
					kind: "catalogue",
				});
			});
			item.appendChild(name);
			item.appendChild(
				el("span", { class: "biwa-stamp-actions" }, [
					el("a", {
						class: "biwa-btn-inline",
						href: MapLinks.pinUrl(p),
						target: "_blank",
						rel: "noopener noreferrer",
						// A place VIEW, not a route — pinUrl pins the listing, so
						// the copy says view, not navigate.
						text: t("View in Google Maps"),
					}),
				]),
			);
			list.appendChild(item);
		});
	}

	// Explicit button press only — fresh fix (no cache), high accuracy, 10s
	// ceiling. The point is used for searches only: never stored, never
	// shared, and it never ticks anything off.
	function updateMyLocation() {
		var status = els["biwa-nearby-geo-status"];
		if (!navigator.geolocation) {
			status.textContent = t(
				"Geolocation is not available in this browser.",
			);
			return;
		}
		status.textContent = t("Requesting location…");
		navigator.geolocation.getCurrentPosition(
			function (pos) {
				geoPoint = {
					lat: pos.coords.latitude,
					lng: pos.coords.longitude,
				};
				status.textContent = t("Location updated (accuracy ±{n} m).", {
					n: Math.round(pos.coords.accuracy),
				});
				renderNearbyExtras();
			},
			function () {
				// A denial keeps any earlier good fix — it must not silently drop the
				// anchor the rider already granted this session.
				status.textContent = geoPoint
					? t(
							"Could not refresh your location — keeping the last fix. Check the browser permission.",
						)
					: t(
							"Location unavailable — searches use the plan anchor below. Check the browser permission and try again.",
						);
				renderNearbyExtras();
			},
			{ enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
		);
	}
})();
