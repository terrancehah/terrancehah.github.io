/* trip-store.js — personal trip state: per-owner reads/writes, polling,
 * conflict handling and honest offline states.
 *
 * Sync boundaries (owner-keyed docs):
 *  - The trip is PERSONAL: every request carries X-Biwa-Owner and each
 *    owner's doc lives at biwa:v2:owner:<id>:trip — no TTL, never expires.
 *    The id is 'dev:<uuid>' minted once into localStorage today; a future
 *    auth layer swaps the scheme ('google:<sub>') without changing the
 *    key layout. biwa-pair mints a 10-minute code that lets a second
 *    device claim the same owner id.
 *  - Writes are compare-and-set: PUT {expectedRevision, trip}. A 409
 *    carries the server's latest trip, which is consumed and adopted; the
 *    local draft is never thrown away — it stays as a recoverable
 *    pendingDraft / conflict until the user resolves it or a retry
 *    succeeds. With a personal doc the only real conflict surface is two
 *    tabs/devices sharing one owner id; the machinery stays regardless.
 *  - Check-in progress (visitStatus/programmeStatus) now lives INSIDE the
 *    personal doc — applyLocalProgress still updates the localStorage
 *    mirror first (instant ticks, offline buffer, and the migration path
 *    for progress made under the old model) and then persists the whole
 *    snapshot through the normal save queue.
 *  - Only idempotent checkbox intents (arrival ticks) are rebased, once,
 *    after a successful refresh; an intent whose target stop/place no
 *    longer exists is dropped cleanly rather than re-adding it.
 *  - Unsent work is durable: every draft (network failure, 503, 409) is
 *    written to localStorage BEFORE the wire attempt so a reload can
 *    never lose it. init restores a persisted draft as pendingDraft
 *    ahead of any refresh — a later server read may update latestServer
 *    but must not adopt over the draft — and only acknowledged saves
 *    clear the durable copy. The last-known server snapshot keeps its
 *    own key as the labelled-stale offline fallback.
 *  - Polling runs every 60 s while the tab is visible plus on focus —
 *    slower than the shared era since foreign writes are impossible;
 *    paired same-owner devices are the only thing it can ever learn.
 *    A read started before an editor opened or a write began is stale
 *    and cannot adopt (read generation is bumped on both events).
 *  - A 503 (backend not configured/unavailable) is a temporary
 *    'unavailable' state, not a permanent local-only mode: polling keeps
 *    trying and an unsent draft retries once the service returns.
 *  - Local drafts/caches live under v2 storage keys so the retired v1 data
 *    is never touched.
 */
(function (global) {
	"use strict";

	var POLL_MS = 60000;
	var LOCAL_LAST_KNOWN_KEY = "biwa:v2:last-known-trip";
	var LOCAL_DRAFT_KEY = "biwa:v2:local-draft";
	var LOCAL_PROGRESS_KEY = "biwa:v2:local-progress";
	var LOCAL_OWNER_KEY = "biwa:v2:owner-id";
	// Server-side validation of the '<scheme>:<subject>' owner id shape.
	var OWNER_ID_RE = /^[a-z][a-z0-9]{0,15}:[A-Za-z0-9._~+-]{8,128}$/;

	// Catalogue records whose classification was corrected after shared
	// snapshots already carried the old metadata. Only these ids get their
	// canonical fields overlaid during normalization — every other place
	// (custom stops, edits, progress) is left exactly as stored.
	var CATALOGUE_CORRECTION_IDS = {
		"extra-chomeiji-183": true,
		"extra-oura": true,
		"official-west-information": true,
		"extra-ukawa": true,
		"extra-takashima-station": true,
	};
	// The legacy station stop is the same physical place as the canonical
	// information centre; old snapshots reference the old id in Day 3.
	var LEGACY_STATION_ID = "extra-takashima-station";
	var CANONICAL_INFO_ID = "official-west-information";
	// Fields the overlay trusts from the loaded manifest — label/notes are
	// deliberately absent: they are the two user-editable manifest fields.
	var CANONICAL_IMMUTABLE_FIELDS = [
		"category",
		"programmes",
		"googlePlaceId",
		"address",
		"lat",
		"lng",
		"source",
		"nameConfirmed",
	];
	// Pre-correction defaults for label/notes. A snapshot field is migrated
	// ONLY while it still holds one of these (or is absent) — a rider's own
	// rename or note always wins over the canonical text.
	var CATALOGUE_OLD_DEFAULTS = {
		"extra-chomeiji-183": {
			notes: "Address-only stop from the supplied itinerary; no business identity has been assumed.",
		},
		"extra-oura": {
			notes: "Address-only stop from the supplied itinerary.",
		},
		"official-west-information": {
			label: "Omitakashima Information Center",
			notes: "",
		},
		"extra-ukawa": {
			label: "215 Ukawa",
			notes: "User-supplied address; Google place details resolve to Shirahige Shrine.",
		},
	};

	// --- store -----------------------------------------------------------------

	function TripStore() {
		this.apiBase = "api/";
		// Personal identity — 'dev:<uuid>' minted once into localStorage, or an
		// id adopted through a pairing code. Sent on every request.
		this.ownerId = loadOwnerId();
		this.trip = null;
		this.places = [];
		this.capabilities = {};
		this.browserMapsKey = null;
		// loading|local|saved|saving|unavailable|disconnected|conflict
		this.state = "loading";
		// Sharing unavailable (no backend configured) → drafts stay local until
		// a poll sees the service come back; never a permanent mode.
		this.localOnly = false;
		// A real wire failure — rejected fetch, 5xx, PUT failure — not the
		// provisional 'disconnected' label a restored doc wears before the
		// first read answers. The offline module toasts only on this proof.
		this.connectionIssue = false;
		this.conflict = null; // {draft, server} while unresolved
		this.pendingDraft = null; // unsent whole-snapshot draft (recoverable)
		this.latestServer = null; // last authoritative server snapshot seen
		this.editorActive = false; // UI sets while a dialog is open
		this._saving = false;
		// Per-device check-in state — overlaid onto this.trip, never shared.
		// Seeded once from whatever doc first carries the legacy shared fields
		// so progress made under the old shared model is not lost.
		this.localProgress = { visitStatus: {}, programmeStatus: {} };
		this._progressLoaded = false;
		this._listeners = [];
		this._writeQueue = Promise.resolve();
		this._queuedWrites = 0; // saves enqueued, decremented on settle
		// Pending-work bookkeeping for CAS-409 merging. Ordinary check-ins are
		// replayable boolean deltas keyed per flag (last action wins); any plan
		// edit enqueued marks the pending doc 'mixed', which keeps the explicit
		// whole-draft conflict path — only pure-progress work may auto-merge.
		this._opSeq = 0; // ordering stamp for recorded operations
		this._pendingDeltas = {}; // deltaKey -> {kind,key,programme,value,seq}
		this._pendingPlanSeqs = []; // seqs of enqueued non-progress saves
		this._readSeq = 0; // bumped on saves/editor entry: kills stale reads
		// Config responses get their own ordering guard: _readSeq is bumped by
		// editor entry, which would otherwise strand provider config forever.
		this._configReadSeq = 0;
		this._pollTimer = null;
		// Whether localStorage actually works — probed once here, and flipped
		// false by any later access that throws. The UI turns this flag into
		// an honest "may not persist" warning instead of letting the app
		// claim offline persistence it does not have.
		this.storageAvailable = probeStorage();
		// True while the durable localStorage copy of pendingDraft matches
		// the in-memory draft — cleared drafts and write failures read false.
		this.draftPersisted = false;
	}

	TripStore.prototype.onChange = function (fn) {
		this._listeners.push(fn);
		return fn;
	};

	TripStore.prototype._emit = function () {
		var self = this;
		// Every adoption path funnels through emit — normalizing here catches
		// shared snapshots, local caches, pending drafts and both conflict
		// sides alike without duplicating the call at each adoption site.
		this._normalizeTrip(this.trip);
		this._normalizeTrip(this.pendingDraft);
		this._normalizeTrip(this.latestServer);
		if (this.conflict) {
			this._normalizeTrip(this.conflict.draft);
			this._normalizeTrip(this.conflict.server);
		}
		// Progress is resolved lazily on the first emit with a doc available:
		// stored progress wins; otherwise the legacy shared fields seed it.
		if (!this._progressLoaded) {
			this._loadProgress(
				this.trip || this.pendingDraft || this.latestServer,
			);
		}
		// The UI reads progress through this.trip only — raw docs keep their
		// own fields for CAS bases and conflict sides, never the view. A view
		// that still aliases a raw doc (pendingDraft, a conflict side,
		// latestServer, the seed) is detached first: overlaying in place
		// would silently rewrite the durable draft's pinned progress.
		this._detachView();
		this._overlayProgress(this.trip);
		this._listeners.forEach(function (fn) {
			fn(self);
		});
	};

	TripStore.prototype._detachView = function () {
		var raw = this.trip;
		if (!raw) return;
		var aliases = [this.pendingDraft, this.latestServer, this._seed];
		if (this.conflict) {
			aliases.push(this.conflict.draft, this.conflict.server);
		}
		if (aliases.indexOf(raw) !== -1) {
			this.trip = JSON.parse(JSON.stringify(raw));
		}
	};

	// One-time local progress resolution. A stored snapshot always wins;
	// otherwise the first doc still carrying the legacy shared fields
	// (server trip, unsent draft or last-known cache — old drafts double as
	// a backup here) seeds the local copy, which is then persisted so the
	// seed can never re-run. Called with a null doc when nothing has loaded
	// yet — it simply stays unloaded for the next emit.
	TripStore.prototype._loadProgress = function (doc) {
		var stored = null;
		try {
			stored = JSON.parse(this._storageGet(LOCAL_PROGRESS_KEY) || "null");
		} catch (e) {}
		if (stored && typeof stored === "object") {
			this.localProgress = {
				visitStatus: stored.visitStatus || {},
				programmeStatus: stored.programmeStatus || {},
			};
			this._progressLoaded = true;
			return;
		}
		if (!doc) return;
		this.localProgress = {
			visitStatus: JSON.parse(JSON.stringify(doc.visitStatus || {})),
			programmeStatus: JSON.parse(
				JSON.stringify(doc.programmeStatus || {}),
			),
		};
		this._progressLoaded = true;
		this._storageSet(
			LOCAL_PROGRESS_KEY,
			JSON.stringify(this.localProgress),
		);
	};

	// Replace a doc's progress fields with deep copies of the local state.
	// Copies (not references) keep _normalizeTrip's legacy-id transfer and
	// any future mutator from writing straight into the local store.
	TripStore.prototype._overlayProgress = function (doc) {
		if (!doc) return doc;
		doc.visitStatus = JSON.parse(
			JSON.stringify(this.localProgress.visitStatus),
		);
		doc.programmeStatus = JSON.parse(
			JSON.stringify(this.localProgress.programmeStatus),
		);
		return doc;
	};

	// Check-in write: mutate a draft of the local progress copy through the
	// same Rules helpers the doc model uses, persist the local mirror, emit
	// instantly, then save the whole trip snapshot — progress now lives
	// inside the owner's personal doc, so the tick is durable server-side
	// once the write lands. Resolves like save() ('saved'|'local'|...), so
	// the UI's durable-write toast gate needs no new vocabulary.
	TripStore.prototype.applyLocalProgress = function (mutator) {
		var before = JSON.parse(JSON.stringify(this.localProgress));
		var progressDraft = JSON.parse(JSON.stringify(this.localProgress));
		try {
			mutator(progressDraft);
		} catch (e) {
			return Promise.resolve("error");
		}
		// The precise boolean deltas this call produced drive the CAS-409
		// auto-merge: only keys this call truly changed, removals included.
		var changes = diffProgress(before, progressDraft);
		this.localProgress = progressDraft;
		this._storageSet(LOCAL_PROGRESS_KEY, JSON.stringify(progressDraft));
		this._emit();
		// No trip doc loaded at all (catalogue fetch failed hard): the local
		// copy already persisted above — skip the doc write entirely.
		if (!this.trip && !this.pendingDraft) return Promise.resolve("local");
		var self = this;
		return this.save(
			function (draft) {
				// Pin the mirror AS IT STANDS WHEN THE WRITE RUNS — queueing
				// behind another write must not resurrect a stale snapshot and
				// drop a tick that a paired device landed meanwhile.
				draft.visitStatus = JSON.parse(
					JSON.stringify(self.localProgress.visitStatus),
				);
				draft.programmeStatus = JSON.parse(
					JSON.stringify(self.localProgress.programmeStatus),
				);
			},
			{ progressChanges: changes },
		);
	};

	// Per-flag boolean diff between two progress copies — the mergeable
	// vocabulary for check-ins. A removal reports value:false (uncheck),
	// never an absent entry, so 'undo' deltas replay correctly too.
	function diffProgress(before, after) {
		var changes = [];
		var vBefore = (before && before.visitStatus) || {};
		var vAfter = (after && after.visitStatus) || {};
		var visitKeys = {};
		Object.keys(vBefore).forEach(function (k) {
			visitKeys[k] = true;
		});
		Object.keys(vAfter).forEach(function (k) {
			visitKeys[k] = true;
		});
		Object.keys(visitKeys).forEach(function (k) {
			if ((vBefore[k] === true) !== (vAfter[k] === true)) {
				changes.push({
					kind: "visit",
					key: k,
					value: vAfter[k] === true,
				});
			}
		});
		var pBefore = (before && before.programmeStatus) || {};
		var pAfter = (after && after.programmeStatus) || {};
		var families = {};
		Object.keys(pBefore).forEach(function (f) {
			families[f] = true;
		});
		Object.keys(pAfter).forEach(function (f) {
			families[f] = true;
		});
		Object.keys(families).forEach(function (f) {
			var fb = pBefore[f] || {};
			var fa = pAfter[f] || {};
			var memberKeys = {};
			Object.keys(fb).forEach(function (k) {
				memberKeys[k] = true;
			});
			Object.keys(fa).forEach(function (k) {
				memberKeys[k] = true;
			});
			Object.keys(memberKeys).forEach(function (k) {
				if ((fb[k] === true) !== (fa[k] === true)) {
					changes.push({
						kind: "programme",
						programme: f,
						key: k,
						value: fa[k] === true,
					});
				}
			});
		});
		return changes;
	}

	// Non-destructive migration for pre-correction snapshots. Two fixes on an
	// OWNED snapshot only (this store's copies — canonical values are deep-
	// copied so a snapshot never shares the manifest's arrays/objects):
	//  1. Canonical immutable metadata for the corrected place ids is
	//     overlaid from the loaded manifest (category, programmes, ids,
	//     source coords). label/notes migrate only while the snapshot still
	//     carries the pre-correction default — user edits always win.
	//  2. Itinerary references to the legacy station id are retargeted to the
	//     canonical information-centre record — occurrence ids and visit
	//     flags are preserved; a visited legacy row also marks the canonical
	//     record's official check so progress is not lost.
	// Returns the same object (mutated in place). Revisions, day order,
	// occurrence ids, visit/programme status and user-edited place metadata
	// are never reset; the correction persists on the next normal save —
	// normalization alone never triggers a write.
	TripStore.prototype._normalizeTrip = function (trip) {
		if (!trip || !trip.places) return trip;
		var canonical = {};
		(this.places || []).forEach(function (p) {
			if (CATALOGUE_CORRECTION_IDS[p.placeId]) canonical[p.placeId] = p;
		});
		trip.places.forEach(function (p) {
			var canon = p && canonical[p.placeId];
			if (!canon) return;
			CANONICAL_IMMUTABLE_FIELDS.forEach(function (f) {
				var v = canon[f];
				if (v === undefined) delete p[f];
				else p[f] = JSON.parse(JSON.stringify(v));
			});
			// The backend treats label/notes as the only mutable manifest
			// fields: overwrite only a pre-correction default (or a gap), never
			// a rider's own text.
			["label", "notes"].forEach(function (f) {
				if (p[f] === canon[f]) return;
				var defaults = CATALOGUE_OLD_DEFAULTS[p.placeId] || {};
				if (p[f] === undefined || p[f] === defaults[f]) {
					if (canon[f] === undefined) delete p[f];
					else p[f] = canon[f];
				}
			});
		});
		// Only retarget when the canonical record actually exists in this
		// snapshot's catalogue — otherwise the stop would dangle.
		var hasCanonical = trip.places.some(function (p) {
			return p && p.placeId === CANONICAL_INFO_ID;
		});
		if (!hasCanonical) return trip;
		var visitedLegacy = false;
		(trip.days || []).forEach(function (day) {
			(day.stops || []).forEach(function (stop) {
				if (stop.placeId !== LEGACY_STATION_ID) return;
				stop.placeId = CANONICAL_INFO_ID;
				if (trip.visitStatus && trip.visitStatus[stop.occurrenceId])
					visitedLegacy = true;
			});
			["start", "end"].forEach(function (which) {
				var endpoint = day[which];
				if (endpoint && endpoint.placeId === LEGACY_STATION_ID) {
					endpoint.placeId = CANONICAL_INFO_ID;
					if (
						trip.visitStatus &&
						trip.visitStatus[day.dayId + "-" + which]
					)
						visitedLegacy = true;
				}
			});
		});
		// A legacy row that was already ticked counts toward the canonical
		// record's official check.
		var officialStatus =
			trip.programmeStatus && trip.programmeStatus.official;
		if (
			visitedLegacy ||
			(officialStatus && officialStatus[LEGACY_STATION_ID])
		) {
			trip.programmeStatus = trip.programmeStatus || {};
			trip.programmeStatus.official = trip.programmeStatus.official || {};
			trip.programmeStatus.official[CANONICAL_INFO_ID] = true;
		}
		// The legacy id is not a programme member — its key is invalid to the
		// server validator — so the check transfers to the canonical record
		// rather than duplicating. The transfer above always lands first, so
		// nothing is lost by removing the old key.
		if (officialStatus && LEGACY_STATION_ID in officialStatus) {
			delete officialStatus[LEGACY_STATION_ID];
		}
		return trip;
	};

	TripStore.prototype._setState = function (state) {
		this.state = state;
		this._emit();
	};

	TripStore.prototype._headers = function () {
		// The owner header is how the server knows WHICH personal doc — it is
		// also sent on provider calls (harmless today, and it lets future
		// per-user rate limits key off identity rather than IP).
		return {
			"Content-Type": "application/json",
			"X-Biwa-Owner": this.ownerId,
		};
	};

	// Mint-or-load the device identity. The UUID is random per browser
	// profile; a pairing claim overwrites the stored id before the app
	// reloads, so this function only ever mints for genuinely new devices.
	function loadOwnerId() {
		var stored = null;
		try {
			stored = global.localStorage.getItem(LOCAL_OWNER_KEY);
		} catch (e) {}
		if (stored && OWNER_ID_RE.test(stored)) return stored;
		var uuid =
			global.crypto && global.crypto.randomUUID
				? global.crypto.randomUUID()
				: // Hand-rolled v4 for the rare browser lacking crypto.randomUUID —
					// collisions are still astronomically unlikely at 122 random bits.
					"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
						/[xy]/g,
						function (c) {
							var r = (Math.random() * 16) | 0;
							return (c === "x" ? r : (r & 0x3) | 0x8).toString(
								16,
							);
						},
					);
		var id = "dev:" + uuid;
		try {
			global.localStorage.setItem(LOCAL_OWNER_KEY, id);
		} catch (e) {}
		return id;
	}

	// The UI flips this when a dialog opens/closes. Opening an editor bumps the
	// read generation so an in-flight GET can no longer adopt over the edit.
	TripStore.prototype.setEditorActive = function (active) {
		this.editorActive = !!active;
		if (active) this._readSeq++;
	};

	// A one-time probe so storage failures are known before first use rather
	// than discovered mid-write (private windows can throw on setItem).
	function probeStorage() {
		try {
			var key = "biwa:v2:storage-probe";
			global.localStorage.setItem(key, "1");
			global.localStorage.removeItem(key);
			return true;
		} catch (e) {
			return false;
		}
	}

	// --- durable local state --------------------------------------------------
	// Every localStorage access below funnels through these helpers so an
	// unavailable or throwing store degrades to honest flags instead of
	// silently pretending work was persisted.

	TripStore.prototype._flagStorageFailure = function () {
		// Deliberately no _emit here — a failure can surface mid-notify; the
		// next state change carries the flag to listeners.
		this.storageAvailable = false;
	};

	TripStore.prototype._storageGet = function (key) {
		try {
			return global.localStorage.getItem(key);
		} catch (e) {
			this._flagStorageFailure();
			return null;
		}
	};

	TripStore.prototype._storageSet = function (key, value) {
		try {
			global.localStorage.setItem(key, value);
			return true;
		} catch (e) {
			this._flagStorageFailure();
			return false;
		}
	};

	TripStore.prototype._storageRemove = function (key) {
		try {
			global.localStorage.removeItem(key);
			return true;
		} catch (e) {
			this._flagStorageFailure();
			return false;
		}
	};

	// --- pending-work bookkeeping ----------------------------------------------
	// Every save() classifies itself at enqueue time: progress-only writes
	// record their boolean deltas, anything else pushes a plan seq that makes
	// the pending doc 'mixed'. A CAS-409 may auto-merge tracked deltas onto
	// the fresh server snapshot; mixed work always keeps the explicit
	// whole-draft conflict so no edit is ever silently dropped or guessed.

	TripStore.prototype._deltaKey = function (c) {
		return c.kind === "programme"
			? "programme:" + c.programme + ":" + c.key
			: "visit:" + c.key;
	};

	TripStore.prototype._pendingDeltaList = function () {
		var deltas = this._pendingDeltas;
		return Object.keys(deltas).map(function (k) {
			return deltas[k];
		});
	};

	// Record this save's pending work at ENQUEUE time and return the batch
	// handle: {cap, undo()}. `cap` freezes the op boundary — only work
	// recorded at-or-before this enqueue may ever be acknowledged by this
	// write's success (the draft physically contains everything recorded
	// earlier: prior queue entries already ran or live inside pendingDraft,
	// later entries are strictly another write's business). `undo` retires
	// exactly this save's classification if its mutator throws — a failed
	// enqueue must not leave phantom pending work.
	TripStore.prototype._trackSave = function (options) {
		var self = this;
		var recordedDeltas = [];
		var planSeq = null;
		if (options && options.progressChanges) {
			options.progressChanges.forEach(function (c) {
				// Last action wins per flag — a tick then untick keeps only
				// the untick in the pending set.
				var seq = ++self._opSeq;
				self._pendingDeltas[self._deltaKey(c)] = {
					kind: c.kind,
					key: c.key,
					programme: c.programme,
					value: c.value === true,
					seq: seq,
				};
				recordedDeltas.push({ key: self._deltaKey(c), seq: seq });
			});
		} else if (!(options && options.intent)) {
			// Legacy single-intent saves keep their own bounded-rebase
			// machinery and neither count as plan edits nor record deltas.
			planSeq = ++this._opSeq;
			this._pendingPlanSeqs.push(planSeq);
		}
		return {
			cap: this._opSeq,
			undo: function () {
				recordedDeltas.forEach(function (r) {
					// Only remove an entry still owned by this save — a later
					// save may already have overwritten the same key.
					if (
						self._pendingDeltas[r.key] &&
						self._pendingDeltas[r.key].seq === r.seq
					) {
						delete self._pendingDeltas[r.key];
					}
				});
				if (planSeq !== null) {
					self._pendingPlanSeqs = self._pendingPlanSeqs.filter(
						function (s) {
							return s !== planSeq;
						},
					);
				}
			},
		};
	};

	// Does the acknowledged document contain this delta's effect? A delta is
	// only truly acked when the saved doc carries it — a plan save's draft
	// does not pin the progress mirror, so flags recorded before it must not
	// be dropped on ITS success.
	TripStore.prototype._docReflectsDelta = function (doc, c) {
		if (c.kind === "programme") {
			var fam = (doc.programmeStatus || {})[c.programme] || {};
			return (fam[c.key] === true) === c.value;
		}
		return ((doc.visitStatus || {})[c.key] === true) === c.value;
	};

	// Is this delta's target still present on doc? The same existence and
	// membership checks _applyDelta uses to build merge payloads — a visit
	// delta applies while its occurrence (a stop, or a live implicit
	// endpoint) exists, a programme delta only while the place remains a
	// member of that family. A skipped delta can never be 'reflected' on
	// the doc, so applicability — not effect — is what lets acknowledgement
	// retire it instead of tracking it forever.
	TripStore.prototype._deltaApplicable = function (doc, c) {
		if (c.kind === "programme") {
			var place = (doc.places || []).filter(function (p) {
				return p.placeId === c.key;
			})[0];
			if (!place) return false;
			return familiesOf(place.programmes).indexOf(c.programme) !== -1;
		}
		return this._occurrenceExists(doc, c.key);
	};

	// Drop every op the acknowledged doc settles — a recorded delta is
	// retired when the doc REFLECTS its effect, or when its target no
	// longer applies there (a merge dropped it deliberately; keeping it
	// would pin pendingDraft and block pairing forever). Anything recorded
	// after the save's enqueue cap, or still applicable-but-unsent, rides a
	// later write and stays.
	TripStore.prototype._acknowledgeThrough = function (seqCap, doc) {
		var self = this;
		var deltas = this._pendingDeltas;
		Object.keys(deltas).forEach(function (k) {
			if (deltas[k].seq > seqCap) return;
			if (
				self._docReflectsDelta(doc, deltas[k]) ||
				!self._deltaApplicable(doc, deltas[k])
			) {
				delete deltas[k];
			}
		});
		this._pendingPlanSeqs = this._pendingPlanSeqs.filter(function (s) {
			return s > seqCap;
		});
	};

	TripStore.prototype._forgetPendingWork = function () {
		this._pendingDeltas = {};
		this._pendingPlanSeqs = [];
	};

	// Persist an unsent draft BEFORE it travels — a reload, crash or closed
	// tab between "user saved" and "server acked" must never lose the work.
	// The snapshot's own revision field is the CAS base, so the durable copy
	// alone is enough to retry from.
	TripStore.prototype._persistDraft = function (draft) {
		if (!draft) return;
		// The durable copy carries pending-work bookkeeping under a reserved
		// local-only field — written into a serialized copy so the in-memory
		// draft and the wire payload never see it. A reload restores the
		// deltas so a progress-only draft can still auto-merge on conflict
		// instead of asking the user to re-resolve work already made.
		var stored = JSON.parse(JSON.stringify(draft));
		stored._biwaLocalProgress = {
			progressOnly: this._pendingPlanSeqs.length === 0,
			changes: this._pendingDeltaList(),
		};
		this.draftPersisted = this._storageSet(
			LOCAL_DRAFT_KEY,
			JSON.stringify(stored),
		);
	};

	// Clear the durable copy ONLY for work the server acknowledged — a newer
	// queued mutation re-persists first (writes are serial), so removing
	// here can never drop newer work. A throwing removeItem leaves the copy
	// on disk (it would resurrect on reload), so draftPersisted stays true
	// rather than claiming a clean slate the device does not have.
	TripStore.prototype._clearPersistedDraft = function () {
		this.draftPersisted = !this._storageRemove(LOCAL_DRAFT_KEY);
	};

	// Read back a persisted unsent draft, or null when absent/unreadable —
	// corrupt data must fail open to the other fallbacks, never throw.
	TripStore.prototype._restorePersistedDraft = function () {
		var draft = null;
		try {
			draft = JSON.parse(this._storageGet(LOCAL_DRAFT_KEY) || "null");
		} catch (e) {
			draft = null;
		}
		if (!draft || typeof draft !== "object" || !draft.days) return null;
		// The reserved local-only field rides inside the durable copy —
		// restore it to the store's bookkeeping fields and strip it so the
		// draft payload sent on the wire stays clean.
		this._restoredDraftMeta = draft._biwaLocalProgress || null;
		delete draft._biwaLocalProgress;
		return draft;
	};

	// Restore the persisted pending-work bookkeeping a relaunch carried.
	// Deltas replay as seq-0 work (the restored draft's pinned progress
	// already contains them, so the first ack of it drops them). A draft
	// written before metadata existed — or one persisted while plan edits
	// were outstanding — counts as mixed: auto-merge never guesses.
	TripStore.prototype._adoptRestoredDraftMeta = function () {
		var meta = this._restoredDraftMeta;
		this._restoredDraftMeta = null;
		var self = this;
		if (meta && Array.isArray(meta.changes)) {
			meta.changes.forEach(function (c) {
				self._pendingDeltas[self._deltaKey(c)] = {
					kind: c.kind,
					key: c.key,
					programme: c.programme,
					value: c.value === true,
					seq: 0,
				};
			});
		}
		if (!meta || meta.progressOnly !== true) {
			this._pendingPlanSeqs.push(0);
		}
	};

	// The last-known server snapshot is the labelled-stale offline view and
	// the restored CAS anchor — same fail-open treatment as the draft.
	TripStore.prototype._restoreLastKnown = function () {
		var trip = null;
		try {
			trip = JSON.parse(this._storageGet(LOCAL_LAST_KNOWN_KEY) || "null");
		} catch (e) {
			trip = null;
		}
		return trip && typeof trip === "object" && trip.days ? trip : null;
	};

	// --- boot ------------------------------------------------------------------

	TripStore.prototype.init = function () {
		var self = this;
		// Ask for durable storage so local check-in progress survives long
		// idle stretches — browsers may evict non-persistent site data, and
		// there is no way for a page to set an expiry itself. Best-effort:
		// an unsupported API or a denied grant quietly does nothing.
		if (
			global.navigator &&
			navigator.storage &&
			navigator.storage.persist
		) {
			navigator.storage.persist().catch(function () {});
		}
		// Adopt durable local state BEFORE the first network wait so an
		// offline start renders real content instead of a blank shell:
		//  - a persisted unsent draft is the newest work on this device — it
		//    becomes pendingDraft now so no refresh can adopt over it later;
		//  - the last-known server snapshot restores both the labelled-stale
		//    view and the CAS anchor latestServer.
		var restoredDraft = this._restorePersistedDraft();
		if (restoredDraft) {
			this.pendingDraft = restoredDraft;
			this.draftPersisted = true;
			this._adoptRestoredDraftMeta();
		}
		var lastKnown = this._restoreLastKnown();
		if (lastKnown) this.latestServer = lastKnown;
		// A draft is newer than anything last-known can offer, so it wins
		// the visible slot when both exist.
		if (restoredDraft) this.trip = restoredDraft;
		else if (lastKnown) this.trip = lastKnown;
		if (this.trip) {
			// Paint the restored doc NOW — the catalogue/seed fetch below may
			// be slow or unreachable, and blanking an offline relaunch serves
			// nobody. The restored draft's own progress fields are the newest
			// unsent work, so they seed localProgress ahead of the (possibly
			// older) mirror; without a draft the normal _loadProgress ordering
			// runs on the first emit. State stays 'disconnected' until a real
			// server read confirms anything — never a false 'saved'.
			if (restoredDraft) {
				this.localProgress = {
					visitStatus: JSON.parse(
						JSON.stringify(restoredDraft.visitStatus || {}),
					),
					programmeStatus: JSON.parse(
						JSON.stringify(restoredDraft.programmeStatus || {}),
					),
				};
				this._progressLoaded = true;
				this._storageSet(
					LOCAL_PROGRESS_KEY,
					JSON.stringify(this.localProgress),
				);
			}
			this._setState("disconnected");
		}
		return Promise.all([
			fetch("data/checkpoints.json").then(function (r) {
				return r.json();
			}),
			fetch("data/trip-seed.json").then(function (r) {
				return r.json();
			}),
		])
			.then(function (results) {
				self.places = results[0].places;
				var seed = results[1];
				// The seed defers to checkpoints.json so the catalogue is single-source.
				seed.places = self.places;
				self._seed = seed;
				return self.refresh();
			})
			.then(function (adopted) {
				// A restored draft shouldn't idle until the first poll tick — send
				// it now that the initial read succeeded, through the same guarded
				// recovery path (own-base CAS; a 409 surfaces, never overwrites).
				var retry =
					adopted &&
					self.pendingDraft &&
					!self.localOnly &&
					!self.conflict
						? self._retryPendingDraft()
						: Promise.resolve("skipped");
				return retry.then(function () {
					self._startPolling();
					return self;
				});
			})
			.catch(function () {
				// Even catalogue fetch failure shouldn't white-screen the app.
				if (!self.trip) self._adoptLocalFallback(false);
				self._startPolling();
				return self;
			});
	};

	// Fallback snapshot for failure modes. allowSharedCache gates the
	// last-known shared copy: offline reads may show it (labelled stale by the
	// UI); a permanently-local session starts from the seed/local draft.
	TripStore.prototype._adoptLocalFallback = function (allowSharedCache) {
		var draft = this._restorePersistedDraft();
		var cached = allowSharedCache ? this._restoreLastKnown() : null;
		if (!this.trip) this.trip = draft || cached || this._seed;
		// The caller may follow with a more specific state (e.g. 'unauthorized').
		this._setState(this.localOnly ? "local" : "disconnected");
	};

	// GET this owner's snapshot. Returns true only when server state was
	// adopted. Pure read: it never retries a pending draft (retry has one
	// guarded caller in the poll tick / UI action, so a refresh can't race
	// a write).
	TripStore.prototype.refresh = function () {
		var self = this;
		var seq = ++this._readSeq;
		// Every response branch must re-check the read generation before
		// mutating state — a read started before an edit/write began is stale
		// for errors too, not just for adoptions.
		var stale = function () {
			return seq !== self._readSeq;
		};
		return fetch(this.apiBase + "biwa-trip", { headers: this._headers() })
			.then(function (res) {
				if (res.status === 503) {
					if (stale()) return false;
					// Sharing is down or not configured — temporary, keep polling.
					self.localOnly = true;
					self.connectionIssue = true;
					self._ensureFallbackSnapshot();
					self._setState("unavailable");
					return false;
				}
				if (res.status === 401 || res.status === 403) {
					if (stale()) return false;
					// A guard response means shared state is off-limits — reset the
					// display to the local seed/draft. A cached shared snapshot must
					// never surface after a rejection, so the fallback deliberately
					// skips it, and browser provider config is cleared. The HTTP
					// answer itself proves the wire works, so any earlier outage
					// flag clears — an identity problem is never a connection issue.
					self.connectionIssue = false;
					self.localOnly = true;
					self.capabilities = {};
					self.browserMapsKey = null;
					self.latestServer = null;
					if (!self.pendingDraft) self.trip = null;
					self._adoptLocalFallback(false);
					self._setState("unauthorized");
					return false;
				}
				if (!res.ok) {
					if (stale()) return false;
					self._markDisconnected();
					return false;
				}
				return res.json().then(function (body) {
					// Provider config is not trip data — adopt it independently of
					// the read-stale guard. setEditorActive() bumps _readSeq, so a
					// GET landing after a sheet opened would otherwise never
					// configure the providers that sheet needs. _configReadSeq
					// orders config instead: an older response may never overwrite
					// newer config.
					var configChanged = false;
					if (seq >= self._configReadSeq) {
						self._configReadSeq = seq;
						var nextCapabilities = body.capabilities || {};
						var nextKey = body.browserMapsKey || null;
						configChanged =
							JSON.stringify(self.capabilities) !==
								JSON.stringify(nextCapabilities) ||
							self.browserMapsKey !== nextKey;
						self.capabilities = nextCapabilities;
						self.browserMapsKey = nextKey;
					}
					// A read started before an editor opened or a write began must
					// not adopt a trip over the user's work — but a config change
					// still emits (when a trip exists to render against) so an open
					// sheet/map learns the new capabilities.
					if (stale() || self.editorActive || self._saving) {
						if (configChanged && self.trip) self._emit();
						return false;
					}
					// The server may answer while its backend is unconfigured: the
					// trip still renders (static seed, local drafts) but writes stay
					// local until a later poll sees the service come back.
					self.connectionIssue = false;
					self.localOnly = body.sharingAvailable === false;
					if (body.trip) {
						self._adoptServerTrip(body.trip);
						return true;
					}
					if (self.localOnly) {
						// Backend absent: seed locally, keep polling.
						self._ensureFallbackSnapshot();
						self._setState("unavailable");
						return false;
					}
					// This owner has no server doc. A restored/unsent draft
					// IS the trip — retry it against its own base rather than
					// seeding the blueprint over it; only a genuinely fresh
					// device seeds.
					if (self.pendingDraft) {
						return self._retryPendingDraft().then(function () {
							return true;
						});
					}
					return self._seedOwner().then(function () {
						return true;
					});
				});
			})
			.catch(function () {
				if (stale()) return false;
				self._markDisconnected();
				return false;
			});
	};

	TripStore.prototype._ensureFallbackSnapshot = function () {
		// A visible unsent draft is never swapped out for a fallback either.
		if (this.pendingDraft) {
			this.trip = this.pendingDraft;
			return;
		}
		if (!this.trip) this._adoptLocalFallback(true);
	};

	// Anchor + durable cache only — no view swap, no progress mirroring. The
	// CAS-409 consume path uses this so a moved server snapshot can never
	// overwrite the local progress the pending write still owns.
	TripStore.prototype._recordServerSnapshot = function (
		trip,
		statusOverride,
	) {
		// Normalize before the last-known cache write so a stale-metadata
		// snapshot is never persisted as "known good".
		this._normalizeTrip(trip);
		this.latestServer = trip;
		this.localOnly = false;
		this.connectionIssue = false;
		if (statusOverride) {
			// A cached adoption after a failed read is not a wire success —
			// the caller's failed status wins before ANYTHING emits, so no
			// transient 'saved'/connected frame can reach listeners.
			this.localOnly = statusOverride.localOnly;
			this.connectionIssue = statusOverride.connectionIssue;
		}
		this._storageSet(LOCAL_LAST_KNOWN_KEY, JSON.stringify(trip));
	};

	// The 409-side adoption: the server snapshot is authoritative as a CAS
	// base but must not swap the view or mirror its progress while unsent
	// local work owns those — the conflict path decides what happens next.
	TripStore.prototype._onConflictServerTrip = function (trip) {
		if (
			this.pendingDraft ||
			this._pendingDeltaList().length ||
			this._pendingPlanSeqs.length
		) {
			this._recordServerSnapshot(trip);
			this._emit();
			return;
		}
		this._adoptServerTrip(trip);
	};

	// Record the authoritative server snapshot. It is displayed only when no
	// unsent draft is visible — a background read must never hide the user's
	// un-synced work. latestServer always tracks the newest server state (the
	// CAS anchor for explicit replaces and the conflict base).
	TripStore.prototype._adoptServerTrip = function (trip, statusOverride) {
		this._recordServerSnapshot(trip, statusOverride);
		if (this.pendingDraft) {
			this.trip = this.pendingDraft;
			this._emit(); // draft stays visible; no 'saved' label while unsent
			return;
		}
		// The personal doc owns progress now — a paired same-owner device's
		// ticks arrive through it. Mirror the adopted fields into the local
		// copy so the emit overlay and any offline view stay current. Skipped
		// while ANY unsent work is tracked: pending local deltas are newer
		// than the doc's progress fields and mirroring them away would lose
		// the user's own ticks from view (a mid-flight 409 surfaced exactly
		// this wipe).
		var pendingWork =
			this._pendingDeltaList().length || this._pendingPlanSeqs.length;
		if (!pendingWork && (trip.visitStatus || trip.programmeStatus)) {
			this.localProgress = {
				visitStatus: JSON.parse(JSON.stringify(trip.visitStatus || {})),
				programmeStatus: JSON.parse(
					JSON.stringify(trip.programmeStatus || {}),
				),
			};
			this._progressLoaded = true;
			this._storageSet(
				LOCAL_PROGRESS_KEY,
				JSON.stringify(this.localProgress),
			);
		}
		this.trip = trip;
		this.conflict = null;
		if (this.state !== "saving") {
			this._setState(statusOverride ? statusOverride.state : "saved");
		}
	};

	TripStore.prototype._seedOwner = function () {
		var self = this;
		this.trip = this._seed;
		return this._put(this._seed, 0).then(function (result) {
			// A 409 here means a paired same-owner device seeded first — just
			// read back what it wrote.
			if (result === "conflict") return self.refresh();
			return result;
		});
	};

	TripStore.prototype._markDisconnected = function () {
		// Keep showing the last-known snapshot (invite holders only) or the seed
		// rather than a blank app — labelled stale by the UI, never live.
		this.connectionIssue = true;
		this._ensureFallbackSnapshot();
		if (this.state !== "saving") this._setState("disconnected");
	};

	// --- writes ----------------------------------------------------------------

	// Queue a mutation. `mutator` edits a draft copy; the whole snapshot is then
	// written via CAS. options.intent marks simple idempotent checkbox intents
	// eligible for one bounded rebase retry: {kind:'visit'|'programme',
	// key, programme?, value:true}. Retained for compatibility — check-in
	// progress is per-device now and bypasses save() via applyLocalProgress.
	TripStore.prototype.save = function (mutator, options) {
		var self = this;
		// Counted synchronously at enqueue so hasUnsavedChanges() — and the
		// pairing gate that depends on it — can never race a queued write
		// still waiting for its microtask turn.
		this._queuedWrites++;
		var batch = this._trackSave(options);
		// A throwing mutator must not poison the queue for later writes.
		this._writeQueue = this._writeQueue
			.then(function () {
				return self._applySave(mutator, options, batch);
			})
			.catch(function () {
				return "error";
			})
			.finally(function () {
				self._queuedWrites--;
			});
		return this._writeQueue;
	};

	TripStore.prototype._applySave = function (mutator, options, batch) {
		var self = this;
		batch = batch || { cap: this._opSeq, undo: function () {} };
		if (this.localOnly) {
			var localDraft = JSON.parse(
				JSON.stringify(this.pendingDraft || this.trip),
			);
			try {
				mutator(localDraft);
			} catch (e) {
				batch.undo();
				return "error";
			}
			this._applyVisitClears(options, localDraft, batch.cap);
			// Normalize before the local cache write — the draft the device
			// keeps must carry corrected metadata, not the pre-correction copy.
			this._normalizeTrip(localDraft);
			this.pendingDraft = localDraft;
			this.trip = localDraft;
			this._persistDraft(localDraft);
			this._setState("local");
			return "local";
		}
		// Unsent drafts are the base for the next edit — a failed PUT never
		// discards the user's accumulated changes. The draft keeps its OWN base
		// revision: a later refresh must never bump it (that would silently
		// overwrite another rider's edits on retry).
		var hadPendingDraft = !!this.pendingDraft || !!this.conflict;
		var draft = JSON.parse(JSON.stringify(this.pendingDraft || this.trip));
		try {
			mutator(draft);
		} catch (e) {
			batch.undo();
			return "error";
		}
		this._applyVisitClears(options, draft, batch.cap);
		// This write may only ever acknowledge ops recorded at-or-before ITS
		// enqueue — the frozen cap, not the live seq (later queue entries'
		// work is not in this draft).
		var batchSeq = batch.cap;
		// Durable before the wire: a reload or crash between mutation and
		// ack can only lose the in-flight flag, never the user's work.
		this._persistDraft(draft);
		this._saving = true;
		this._readSeq++; // in-flight reads are now obsolete
		this._setState("saving");
		return this._put(draft, draft.revision || 0).then(function (result) {
			self._saving = false;
			if (result === "saved") {
				return self._finalizeSaved(draft, batchSeq);
			}
			if (result === "conflict") {
				// Pure check-in work auto-merges onto the just-adopted server
				// snapshot and retries once — paired devices ticking routine
				// stops must never surface a keep-mine dialog.
				if (
					!self._pendingPlanSeqs.length &&
					((options && options.progressChanges) ||
						// Tracked deltas pending alone still merge — but a legacy
						// intent write is NOT a tracked delta, so it keeps the
						// explicit conflict rather than losing its mutation.
						(self._pendingDeltaList().length &&
							!(options && options.intent)))
				) {
					return self._resolveProgressConflict(draft);
				}
				// The draft already carried unsent work: a single-intent rebase
				// would apply only this tick and clear the rest. Surface the whole
				// accumulated draft as an explicit conflict — nothing is lost.
				if (hadPendingDraft) return self._declareConflict(draft);
				return self._handleConflict(draft, options && options.intent);
			}
			// error/unavailable: keep the draft visible AND recoverable — the
			// user sees their edits with an unsynced label, and retry sends later.
			self.pendingDraft = draft;
			self.trip = draft;
			self._setState(
				result === "unavailable" ? "unavailable" : "disconnected",
			);
			return result;
		});
	};

	// An endpoint clear carries the visit-key deletions for the boundary it
	// touched — applied to the local mirror AND the outgoing draft before
	// any emit or persist, so the whole change travels as one atomic write.
	// `cap` is this save's enqueue-time seq cap: a still-unsent tick on the
	// endpoint is superseded too — a replacement keeps the SAME implicit
	// occurrence id, so its recorded delta would otherwise stay applicable
	// and a later merge could re-check the NEW destination. Only batch work
	// retires here; a tick queued after keeps its own seq and write.
	TripStore.prototype._applyVisitClears = function (options, draft, cap) {
		if (
			!options ||
			!options.clearVisitIds ||
			!options.clearVisitIds.length
		) {
			return;
		}
		var self = this;
		options.clearVisitIds.forEach(function (id) {
			delete self.localProgress.visitStatus[id];
			var pending = self._pendingDeltas["visit:" + id];
			if (pending && pending.seq <= cap) {
				delete self._pendingDeltas["visit:" + id];
			}
		});
		this._storageSet(
			LOCAL_PROGRESS_KEY,
			JSON.stringify(this.localProgress),
		);
		draft.visitStatus = JSON.parse(
			JSON.stringify(this.localProgress.visitStatus),
		);
		draft.programmeStatus = JSON.parse(
			JSON.stringify(this.localProgress.programmeStatus),
		);
	};

	// Acknowledge a saved write: drop every recorded op the acknowledged doc
	// actually contains (bounded by this write's own enqueue cap), then
	// mirror the doc's progress back into the local copy — still-pending
	// later deltas are re-applied on top so a queued tick can never flicker
	// out of the mirror. While ANY op stays unacknowledged a queued write
	// owns it — keep the durable snapshot and the honest 'saving' state so
	// nothing ever claims all-synced mid-queue.
	TripStore.prototype._finalizeSaved = function (doc, seqCap) {
		var self = this;
		this._acknowledgeThrough(seqCap, doc);
		this.conflict = null;
		this.trip = doc;
		var mirror = {
			visitStatus: JSON.parse(JSON.stringify(doc.visitStatus || {})),
			programmeStatus: JSON.parse(
				JSON.stringify(doc.programmeStatus || {}),
			),
		};
		this._pendingDeltaList().forEach(function (c) {
			self._applyDeltaToProgress(mirror, c);
		});
		this.localProgress = mirror;
		this._progressLoaded = true;
		this._storageSet(
			LOCAL_PROGRESS_KEY,
			JSON.stringify(this.localProgress),
		);
		if (this._pendingDeltaList().length || this._pendingPlanSeqs.length) {
			// Later queue entries own the outstanding work — keep a durable
			// pending anchor that also carries the unacked deltas (queued
			// plan ops can't be serialized ahead of their own write). A
			// reload between acks then replays a complete doc.
			var anchor = JSON.parse(JSON.stringify(doc));
			this._pendingDeltaList().forEach(function (c) {
				self._applyDelta(anchor, c);
			});
			this.pendingDraft = anchor;
			this._persistDraft(anchor);
			this._setState("saving");
			return "saved";
		}
		this.pendingDraft = null;
		this._clearPersistedDraft();
		this._setState("saved");
		return "saved";
	};

	TripStore.prototype._put = function (trip, expectedRevision) {
		var self = this;
		// Last gate before the wire: even a queued draft created before the
		// catalogue correction reaches the server with current metadata, so
		// the immutable-manifest check can never reject it.
		this._normalizeTrip(trip);
		// Progress fields stay in the payload — the personal doc owns them.
		return fetch(this.apiBase + "biwa-trip", {
			method: "PUT",
			headers: this._headers(),
			body: JSON.stringify({
				expectedRevision: expectedRevision,
				trip: trip,
			}),
		})
			.then(function (res) {
				if (res.status === 409) {
					// Consume the server's latest trip — it is authoritative as a
					// CAS base, but the consume must not mirror its progress over
					// unsent local work: _onConflictServerTrip records only the
					// anchor while pending deltas or a draft still own the view.
					return res
						.json()
						.then(function (body) {
							if (body && body.trip)
								self._onConflictServerTrip(body.trip);
							else self.refresh();
							return "conflict";
						})
						.catch(function () {
							self.refresh();
							return "conflict";
						});
				}
				if (res.status === 503) {
					self.connectionIssue = true;
					self._setState("unavailable");
					return "unavailable";
				}
				if (res.status === 401 || res.status === 403) {
					// Identity rejection, not connectivity — the wire answered, so a
					// stale outage flag clears too. The save still resolves 'error'
					// so _applySave keeps the draft pending and recoverable.
					self.connectionIssue = false;
					return "error";
				}
				if (!res.ok) {
					self._markDisconnected();
					return "error";
				}
				return res.json().then(function (body) {
					trip.revision = body.revision;
					trip.updatedAt = body.updatedAt;
					self._adoptServerTrip(trip);
					return "saved";
				});
			})
			.catch(function () {
				self._markDisconnected();
				return "error";
			});
	};

	// Apply one tracked delta to a doc — but only while its target still
	// exists there: a deleted occurrence is never resurrected, and a
	// programme delta lands only while the place remains a member.
	TripStore.prototype._applyDelta = function (doc, c) {
		if (!this._deltaApplicable(doc, c)) return;
		this._applyDeltaToProgress(doc, c);
	};

	// Raw boolean write into a progress-shaped object — used both for merge
	// payloads (after _applyDelta's existence checks) and for re-applying
	// unacked deltas onto the progress mirror after an ack.
	TripStore.prototype._applyDeltaToProgress = function (progress, c) {
		if (c.kind === "programme") {
			progress.programmeStatus = progress.programmeStatus || {};
			progress.programmeStatus[c.programme] =
				progress.programmeStatus[c.programme] || {};
			if (c.value) {
				progress.programmeStatus[c.programme][c.key] = true;
			} else {
				delete progress.programmeStatus[c.programme][c.key];
			}
			return;
		}
		progress.visitStatus = progress.visitStatus || {};
		if (c.value) progress.visitStatus[c.key] = true;
		else delete progress.visitStatus[c.key];
	};

	// CAS-409 with only checkbox work outstanding: rebuild the payload on the
	// authoritative snapshot _put just recorded, replay every outstanding
	// local delta that still applies and CAS once more. Remote plan edits and
	// other devices' ticks ride along untouched — nothing is overwritten.
	TripStore.prototype._resolveProgressConflict = function (draft) {
		var self = this;
		var server = this.latestServer;
		if (!server) {
			// No trustworthy base — keep the draft durable and visible.
			this.pendingDraft = draft;
			this.trip = draft;
			this._persistDraft(draft);
			this._emit();
			return Promise.resolve("error");
		}
		var merged = JSON.parse(JSON.stringify(server));
		this._pendingDeltaList().forEach(function (c) {
			self._applyDelta(merged, c);
		});
		// The merged payload contains exactly the deltas seen NOW — the seq
		// cap freezes that batch so a tick arriving while the merge PUT is in
		// flight is never acknowledged without being sent.
		var mergeSeq = this._opSeq;
		var progressEqual =
			JSON.stringify(merged.visitStatus || {}) ===
				JSON.stringify(server.visitStatus || {}) &&
			JSON.stringify(merged.programmeStatus || {}) ===
				JSON.stringify(server.programmeStatus || {});
		if (progressEqual) {
			// Everything owed already landed (a paired device wrote it) or its
			// target is gone — adopt the server doc, no extra write needed.
			return Promise.resolve(self._finalizeSaved(merged, mergeSeq));
		}
		this._saving = true;
		this._readSeq++;
		this._setState("saving");
		return this._put(merged, server.revision || 0).then(function (result) {
			self._saving = false;
			if (result === "saved") {
				return self._finalizeSaved(merged, mergeSeq);
			}
			// Moved again or failed: keep the merged payload durable and unsent
			// — the guarded poll/reconnect retries the merge later. Progress-only
			// work never raises the keep-mine dialog.
			self.pendingDraft = merged;
			self.trip = merged;
			self._persistDraft(merged);
			self._setState(
				result === "conflict" || result === "local"
					? "local"
					: result === "unavailable"
						? "unavailable"
						: "disconnected",
			);
			return result === "conflict" ? "local" : result;
		});
	};

	// Can this idempotent intent still apply to the latest snapshot? Returns
	// false when the target was deleted — the tick is dropped cleanly. Checks
	// the server snapshot, not the visible draft.
	TripStore.prototype._intentApplicable = function (intent, trip) {
		trip = trip || this.latestServer || this.trip;
		if (!trip) return false;
		if (intent.kind === "visit") {
			return this._occurrenceExists(trip, intent.key);
		}
		if (intent.kind === "arrival") {
			// A v2 arrival tick carries both parts; it applies when either side
			// still exists (occurrence for the visit flag, place for programmes).
			return (
				this._occurrenceExists(trip, intent.occurrenceId) ||
				(trip.places || []).some(function (p) {
					return p.placeId === intent.placeId;
				})
			);
		}
		return (trip.places || []).some(function (p) {
			return p.placeId === intent.key;
		});
	};

	TripStore.prototype._occurrenceExists = function (trip, occurrenceId) {
		return (trip.days || []).some(function (day) {
			if (
				(day.stops || []).some(function (s) {
					return s.occurrenceId === occurrenceId;
				})
			)
				return true;
			return (
				(occurrenceId === day.dayId + "-start" && !!day.start) ||
				(occurrenceId === day.dayId + "-end" && !!day.end)
			);
		});
	};

	TripStore.prototype._handleConflict = function (draft, intent) {
		var self = this;
		if (!intent) return Promise.resolve(this._declareConflict(draft));
		// Checkbox intents are idempotent: refetch, re-apply the single intent,
		// retry once — anything else keeps the draft and asks the user.
		return this.refresh().then(function (ok) {
			var current = self.latestServer;
			if (!ok || !current) {
				// Could not get a trustworthy base — keep the draft recoverable.
				self.pendingDraft = draft;
				self.trip = draft;
				self._persistDraft(draft);
				self._emit();
				return "error";
			}
			var already;
			if (intent.kind === "arrival") {
				// The UI tick derived "arrived" from the own visit OR the programme
				// flag; the intent is already satisfied when the server-side
				// derived state matches what the user meant.
				var place = (current.places || []).filter(function (p) {
					return p.placeId === intent.placeId;
				})[0];
				var fams = place ? familiesOf(place.programmes) : [];
				var progHit = fams.some(function (f) {
					return (
						current.programmeStatus &&
						current.programmeStatus[f] &&
						current.programmeStatus[f][intent.placeId]
					);
				});
				var visitHit = !!(
					current.visitStatus &&
					current.visitStatus[intent.occurrenceId]
				);
				already = visitHit || progHit;
			} else {
				already =
					intent.kind === "visit"
						? !!(
								current.visitStatus &&
								current.visitStatus[intent.key]
							)
						: !!(
								current.programmeStatus &&
								current.programmeStatus[intent.programme] &&
								current.programmeStatus[intent.programme][
									intent.key
								]
							);
			}
			if (
				!self._intentApplicable(intent, current) ||
				already === intent.value
			) {
				// Target deleted (drop the intent) or it already landed on the
				// server — either way nothing to write, and the intent was
				// acknowledged so its durable draft copy can go. A prior
				// pendingDraft still carries any other unsent edits and stays.
				if (!self.pendingDraft) {
					self.trip = current;
					self._clearPersistedDraft();
					self._setState("saved");
				}
				return "saved";
			}
			var rebased = JSON.parse(JSON.stringify(current));
			if (intent.kind === "arrival") {
				// One tick → own visit flag plus EVERY programme family the place
				// belongs to (a shared checkpoint like Mizudori clears both).
				if (self._occurrenceExists(rebased, intent.occurrenceId)) {
					rebased.visitStatus = rebased.visitStatus || {};
					if (intent.value)
						rebased.visitStatus[intent.occurrenceId] = true;
					else delete rebased.visitStatus[intent.occurrenceId];
				}
				var target = (rebased.places || []).filter(function (p) {
					return p.placeId === intent.placeId;
				})[0];
				familiesOf(target ? target.programmes : []).forEach(
					function (family) {
						rebased.programmeStatus = rebased.programmeStatus || {};
						rebased.programmeStatus[family] =
							rebased.programmeStatus[family] || {};
						if (intent.value)
							rebased.programmeStatus[family][intent.placeId] =
								true;
						else
							delete rebased.programmeStatus[family][
								intent.placeId
							];
					},
				);
			} else if (intent.kind === "visit") {
				rebased.visitStatus = rebased.visitStatus || {};
				if (intent.value) rebased.visitStatus[intent.key] = true;
				else delete rebased.visitStatus[intent.key];
			} else {
				rebased.programmeStatus = rebased.programmeStatus || {};
				rebased.programmeStatus[intent.programme] =
					rebased.programmeStatus[intent.programme] || {};
				if (intent.value)
					rebased.programmeStatus[intent.programme][intent.key] =
						true;
				else
					delete rebased.programmeStatus[intent.programme][
						intent.key
					];
			}
			self._saving = true;
			self._readSeq++;
			self._setState("saving");
			return self
				._put(rebased, current.revision || 0)
				.then(function (result) {
					self._saving = false;
					if (result === "saved") {
						return self._finalizeSaved(rebased, self._opSeq);
					}
					if (result === "conflict") {
						self.pendingDraft = draft;
						return self._declareConflict(draft);
					}
					// Failure during rebase: the draft is still recoverable, the intent
					// is not re-applied automatically a second time.
					self.pendingDraft = draft;
					self.trip = draft;
					self._persistDraft(draft);
					self._setState(
						result === "unavailable"
							? "unavailable"
							: "disconnected",
					);
					return result;
				});
		});
	};

	TripStore.prototype._declareConflict = function (draft) {
		// The draft stays visible AND recoverable; the server snapshot is kept
		// separately as the conflict's other side. The 409 must be durable too —
		// a reload before the user resolves keeps the draft, not a silent drop.
		this.pendingDraft = draft;
		this.trip = draft;
		this._persistDraft(draft);
		this.conflict = { draft: draft, server: this.latestServer };
		this._setState("conflict");
		return "conflict";
	};

	// User chose "load latest": adopt the server snapshot kept on the conflict
	// (or the newest one seen), drop the draft and confirm the synced state.
	TripStore.prototype.resolveConflictReload = function () {
		var server =
			(this.conflict && this.conflict.server) || this.latestServer;
		this.conflict = null;
		this.pendingDraft = null;
		this._forgetPendingWork();
		// The user chose the server side — the abandoned draft's durable
		// copy goes with it.
		this._clearPersistedDraft();
		if (!server) return this.refresh();
		// Route through the normal adoption lifecycle so progress mirroring,
		// the last-known cache and the 'saved' label all stay consistent.
		this._adoptServerTrip(server);
		return Promise.resolve("saved");
	};

	// User chose "replace the shared trip with my whole snapshot" — an explicit
	// acknowledgement, not a merge. On another 409/failure the draft is kept
	// and the conflict is re-presented rather than losing the work. The write
	// only happens after a successful refresh supplies a trustworthy base —
	// never against a stale or guessed revision.
	TripStore.prototype.resolveConflictReapply = function () {
		var self = this;
		var draft = (this.conflict && this.conflict.draft) || this.pendingDraft;
		this.conflict = null;
		if (!draft) {
			this._emit();
			return Promise.resolve("none");
		}
		return this.refresh().then(function (ok) {
			if (!ok || !self.latestServer) {
				// No trustworthy server base — do not write; keep the draft.
				self.pendingDraft = draft;
				self.trip = draft;
				self._persistDraft(draft);
				self._emit();
				return "error";
			}
			var base = self.latestServer.revision || 0;
			self._saving = true;
			self._readSeq++;
			self._setState("saving");
			// The draft's progress was pinned when it was built — the ack cap
			// freezes here so work arriving mid-flight is never claimed.
			var capSeq = self._opSeq;
			return self._put(draft, base).then(function (result) {
				self._saving = false;
				if (result === "saved") {
					return self._finalizeSaved(draft, capSeq);
				}
				if (result === "conflict") return self._declareConflict(draft);
				self.pendingDraft = draft;
				self.trip = draft;
				self._persistDraft(draft);
				self._setState(
					result === "unavailable" ? "unavailable" : "disconnected",
				);
				return result;
			});
		});
	};

	// Retry a recoverable unsent draft — called from the single guarded
	// recovery point (poll tick after a successful refresh) and the UI's
	// retry action. The draft is written against ITS OWN base revision, never
	// the refreshed server revision: if another rider saved meanwhile the CAS
	// must fail and surface an explicit conflict rather than silently
	// overwriting their edits.
	TripStore.prototype._retryPendingDraft = function () {
		var self = this;
		if (
			!this.pendingDraft ||
			this.localOnly ||
			this._saving ||
			this._queuedWrites > 0 ||
			this.editorActive ||
			this.conflict
		) {
			return Promise.resolve("skipped");
		}
		var draft = this.pendingDraft;
		this._saving = true;
		this._readSeq++;
		this._setState("saving");
		var capSeq = this._opSeq; // mid-flight work must stay unacknowledged
		return this._put(draft, draft.revision || 0).then(function (result) {
			self._saving = false;
			if (result === "saved") {
				return self._finalizeSaved(draft, capSeq);
			}
			if (result === "conflict") {
				// A restored/retried progress-only draft merges its tracked
				// deltas onto the fresh snapshot instead of asking.
				if (
					!self._pendingPlanSeqs.length &&
					self._pendingDeltaList().length
				) {
					return self._resolveProgressConflict(draft);
				}
				return self._declareConflict(draft);
			}
			// error/unavailable: the draft stays recoverable and visible.
			self.trip = draft;
			self._setState(
				result === "unavailable" ? "unavailable" : "disconnected",
			);
			return result;
		});
	};

	TripStore.prototype.retryPendingDraft = function () {
		var self = this;
		return this.refresh().then(function () {
			return self._retryPendingDraft();
		});
	};

	// Discard the recoverable unsent draft and adopt the latest shared state.
	// The discard only completes when an authoritative view exists: a failed
	// refresh adopts the last-known server snapshot if there is one, or — when
	// nothing authoritative was ever seen — keeps the draft recoverable rather
	// than silently losing the work (or leaving an abandoned draft displayed
	// where a later save could quietly re-send it).
	TripStore.prototype.discardPendingDraft = function () {
		var self = this;
		var discarded =
			this.pendingDraft || (this.conflict && this.conflict.draft);
		this.pendingDraft = null;
		this.conflict = null;
		this._forgetPendingWork();
		this._clearPersistedDraft();
		return this.refresh().then(function (ok) {
			if (ok || !discarded) return ok;
			// The failed read already painted the honest state ('unavailable'/
			// 'disconnected') — keep it over any adoption below, which would
			// otherwise relabel an unreachable server 'saved'.
			var failedState = self.state;
			if (self.latestServer) {
				// An authoritative base exists — adopt it through the normal
				// lifecycle so the view, progress mirror and last-known cache
				// stay consistent. The adoption is cached, not a wire success:
				// the failed read's honest status rides into the adoption
				// itself, so no transient 'saved'/connected emission slips out.
				self._adoptServerTrip(self.latestServer, {
					state: self.state,
					connectionIssue: self.connectionIssue,
					localOnly: self.localOnly,
				});
			} else {
				// Nothing authoritative was ever confirmed: keep the draft
				// recoverable instead of dropping unsent work into the void.
				// Its bookkeeping was just forgotten — mark it mixed so the
				// durable copy can never be auto-merged blind on retry.
				self.pendingDraft = discarded;
				self.trip = discarded;
				self._pendingPlanSeqs.push(++self._opSeq);
				self._persistDraft(discarded);
				self._setState(failedState);
			}
			return ok;
		});
	};

	// --- polling ---------------------------------------------------------------

	TripStore.prototype._startPolling = function () {
		var self = this;
		var tick = function () {
			// Never stomp an open editor, a queued write or an unresolved conflict.
			// localOnly is NOT skipped: it only means sharing was unavailable last
			// time — the poll itself is how recovery is detected.
			if (self.editorActive || self._saving || self.conflict) return;
			self.refresh().then(function (ok) {
				// The single guarded auto-retry: only after a successful read, and
				// re-checked against editor/save/conflict state that may have
				// changed while the read was in flight.
				if (
					ok &&
					!self.localOnly &&
					!self.editorActive &&
					!self._saving &&
					!self.conflict
				) {
					self._retryPendingDraft();
				}
			});
		};
		this._pollTimer = global.setInterval(function () {
			if (
				global.document &&
				global.document.visibilityState === "visible"
			)
				tick();
		}, POLL_MS);
		if (global.document) {
			global.document.addEventListener("visibilitychange", function () {
				if (global.document.visibilityState === "visible") tick();
			});
		}
		if (global.addEventListener) {
			global.addEventListener("focus", tick);
			// navigator.onLine flipping true is only a hint — the reconnect
			// runs the same guarded read-then-retry path as a poll tick,
			// never a blind whole-snapshot replay.
			global.addEventListener("online", tick);
		}
	};

	// --- pairing (share this device's trip to another of yours) ---------------

	// True while anything the server hasn't acknowledged exists — a durable
	// pending draft, an open conflict, an in-flight write, a queued write or
	// tracked progress deltas awaiting their write's turn. Pairing switches
	// identity by wiping local state, so it is only safe when this is false.
	TripStore.prototype.hasUnsavedChanges = function () {
		return !!(
			this.pendingDraft ||
			this.conflict ||
			this._saving ||
			this._queuedWrites > 0 ||
			this._pendingPlanSeqs.length ||
			this._pendingDeltaList().length
		);
	};

	// Why pairing is currently unsafe, or null when it may proceed. Pairing
	// is pointless without a connection and destructive with unsaved work —
	// the dialog turns this reason into an honest message instead of a
	// misleading 'invalid code'.
	TripStore.prototype.getPairingBlockReason = function () {
		if (
			(global.navigator && global.navigator.onLine === false) ||
			this.connectionIssue ||
			this.localOnly
		) {
			return "offline";
		}
		if (this.hasUnsavedChanges()) return "unsaved_changes";
		if (this.state !== "saved") return "not_ready";
		if (!this.storageAvailable) return "storage_unavailable";
		return null;
	};

	// Mint a short-lived code that resolves to this device's owner id.
	// Resolves {code, expiresIn} or {error} — never throws. Blocked reasons
	// short-circuit before the wire so no fetch fires while offline or
	// unsaved; real transport failures surface as 'network', never 'code'.
	TripStore.prototype.createPairCode = function () {
		var reason = this.getPairingBlockReason();
		if (reason) return Promise.resolve({ ok: false, error: reason });
		return this._postPair({ op: "create" });
	};

	// Resolve a code shown on another device to its owner id.
	// Resolves {ownerId} on success or {error:'code_expired'|...}.
	TripStore.prototype.claimPairCode = function (code) {
		var reason = this.getPairingBlockReason();
		if (reason) return Promise.resolve({ ok: false, error: reason });
		return this._postPair({ op: "claim", code: code });
	};

	// One transport path for both pairing calls — status classes map to an
	// honest error vocabulary the dialog can word correctly: a 5xx or a
	// malformed/non-JSON body is a CONNECTION story ('network'), 429 is a
	// rate limit, and real code verdicts (code_expired/bad_code) pass
	// through untouched so they keep their own message.
	TripStore.prototype._postPair = function (payload) {
		return fetch(this.apiBase + "biwa-pair", {
			method: "POST",
			headers: this._headers(),
			body: JSON.stringify(payload),
		})
			.then(function (res) {
				if (res.status >= 500) {
					return { ok: false, error: "network" };
				}
				if (res.status === 429) {
					return { ok: false, error: "rate_limited" };
				}
				return res.json().catch(function () {
					return { ok: false, error: "network" };
				});
			})
			.catch(function () {
				return { ok: false, error: "network" };
			});
	};

	// Switch this device to a claimed owner id. The old identity's local
	// state is wiped — progress, draft and last-known keys would otherwise
	// leak into the newly adopted doc's overlay. The caller reloads the
	// page so every module reboots under the new identity. Refuses while any
	// unsent work exists (the pre-guard keeps removals from ever touching
	// pending data), and only commits the in-memory switch once every
	// storage operation actually succeeded — a denied write leaves ownerId
	// and pending work untouched and returns false, never a silent loss.
	TripStore.prototype.adoptOwner = function (ownerId) {
		if (!ownerId || !OWNER_ID_RE.test(ownerId)) return false;
		if (this.getPairingBlockReason() || this.hasUnsavedChanges()) {
			return false;
		}
		// Sequential checked removals — a denied cache clear aborts BEFORE
		// the owner write so storage and memory can never diverge on
		// identity. (The cache keys are replaceable state only; the unsaved
		// guard above already proved nothing irreplaceable exists.)
		if (!this._storageRemove(LOCAL_PROGRESS_KEY)) return false;
		if (!this._storageRemove(LOCAL_DRAFT_KEY)) return false;
		if (!this._storageRemove(LOCAL_LAST_KNOWN_KEY)) return false;
		if (!this._storageSet(LOCAL_OWNER_KEY, ownerId)) return false;
		this.draftPersisted = false;
		this.ownerId = ownerId;
		return true;
	};

	// The programmeStatus families a place's membership maps to — 'rally'
	// plus 'official' for any official-* area (shared checkpoints hit both).
	function familiesOf(programmes) {
		var fams = [];
		(programmes || []).forEach(function (p) {
			if (p === "rally" && fams.indexOf("rally") === -1)
				fams.push("rally");
			else if (
				typeof p === "string" &&
				p.indexOf("official-") === 0 &&
				fams.indexOf("official") === -1
			)
				fams.push("official");
		});
		return fams;
	}

	// --- providers (public, server-proxied) -------------------------------------

	TripStore.prototype.fetchRoute = function (dayId, coordinates, requestId) {
		return fetch(this.apiBase + "biwa-route", {
			method: "POST",
			headers: this._headers(),
			body: JSON.stringify({
				dayId: dayId,
				orderedCoordinates: coordinates,
				requestId: requestId,
			}),
		})
			.then(function (res) {
				return res.json();
			})
			.catch(function () {
				return { ok: false, error: "network" };
			});
	};

	// Transient Google place details by INTERNAL id (never a raw Google id —
	// the server resolves the mapping so the endpoint is not an open proxy).
	TripStore.prototype.fetchPlace = function (placeId) {
		// The owner header lets the server resolve this owner's custom places.
		return fetch(
			this.apiBase + "biwa-place?placeId=" + encodeURIComponent(placeId),
			{ headers: this._headers() },
		)
			.then(function (res) {
				return res.json();
			})
			.catch(function () {
				return { ok: false, error: "network" };
			});
	};

	// Photo URL for <img src> — the server proxies, bounds and hosts-checks
	// Google's photo bytes; the client never touches provider credentials.
	TripStore.prototype.photoUrl = function (placeId, index, width) {
		return (
			this.apiBase +
			"biwa-photo?placeId=" +
			encodeURIComponent(placeId) +
			"&index=" +
			index +
			"&width=" +
			width
		);
	};

	if (typeof module !== "undefined" && module.exports)
		module.exports = TripStore;
	global.BiwaTripStore = TripStore;
})(typeof window !== "undefined" ? window : globalThis);
