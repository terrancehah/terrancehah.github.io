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
  'use strict';

  var POLL_MS = 60000;
  var LOCAL_LAST_KNOWN_KEY = 'biwa:v2:last-known-trip';
  var LOCAL_DRAFT_KEY = 'biwa:v2:local-draft';
  var LOCAL_PROGRESS_KEY = 'biwa:v2:local-progress';
  var LOCAL_OWNER_KEY = 'biwa:v2:owner-id';
  // Server-side validation of the '<scheme>:<subject>' owner id shape.
  var OWNER_ID_RE = /^[a-z][a-z0-9]{0,15}:[A-Za-z0-9._~+-]{8,128}$/;

  // Catalogue records whose classification was corrected after shared
  // snapshots already carried the old metadata. Only these ids get their
  // canonical fields overlaid during normalization — every other place
  // (custom stops, edits, progress) is left exactly as stored.
  var CATALOGUE_CORRECTION_IDS = {
    'extra-chomeiji-183': true,
    'extra-oura': true,
    'official-west-information': true,
    'extra-ukawa': true,
    'extra-takashima-station': true
  };
  // The legacy station stop is the same physical place as the canonical
  // information centre; old snapshots reference the old id in Day 3.
  var LEGACY_STATION_ID = 'extra-takashima-station';
  var CANONICAL_INFO_ID = 'official-west-information';
  // Fields the overlay trusts from the loaded manifest — label/notes are
  // deliberately absent: they are the two user-editable manifest fields.
  var CANONICAL_IMMUTABLE_FIELDS = [
    'category', 'programmes', 'googlePlaceId', 'address',
    'lat', 'lng', 'source', 'nameConfirmed'
  ];
  // Pre-correction defaults for label/notes. A snapshot field is migrated
  // ONLY while it still holds one of these (or is absent) — a rider's own
  // rename or note always wins over the canonical text.
  var CATALOGUE_OLD_DEFAULTS = {
    'extra-chomeiji-183': {
      notes: 'Address-only stop from the supplied itinerary; no business identity has been assumed.'
    },
    'extra-oura': {
      notes: 'Address-only stop from the supplied itinerary.'
    },
    'official-west-information': {
      label: 'Omitakashima Information Center',
      notes: ''
    },
    'extra-ukawa': {
      label: '215 Ukawa',
      notes: 'User-supplied address; Google place details resolve to Shirahige Shrine.'
    }
  };

  // --- store -----------------------------------------------------------------

  function TripStore() {
    this.apiBase = 'api/';
    // Personal identity — 'dev:<uuid>' minted once into localStorage, or an
    // id adopted through a pairing code. Sent on every request.
    this.ownerId = loadOwnerId();
    this.trip = null;
    this.places = [];
    this.capabilities = {};
    this.browserMapsKey = null;
    // loading|local|saved|saving|unavailable|disconnected|conflict
    this.state = 'loading';
    // Sharing unavailable (no backend configured) → drafts stay local until
    // a poll sees the service come back; never a permanent mode.
    this.localOnly = false;
    this.conflict = null;           // {draft, server} while unresolved
    this.pendingDraft = null;       // unsent whole-snapshot draft (recoverable)
    this.latestServer = null;       // last authoritative server snapshot seen
    this.editorActive = false;      // UI sets while a dialog is open
    this._saving = false;
    // Per-device check-in state — overlaid onto this.trip, never shared.
    // Seeded once from whatever doc first carries the legacy shared fields
    // so progress made under the old shared model is not lost.
    this.localProgress = { visitStatus: {}, programmeStatus: {} };
    this._progressLoaded = false;
    this._listeners = [];
    this._writeQueue = Promise.resolve();
    this._readSeq = 0;              // bumped on saves/editor entry: kills stale reads
    // Config responses get their own ordering guard: _readSeq is bumped by
    // editor entry, which would otherwise strand provider config forever.
    this._configReadSeq = 0;
    this._pollTimer = null;
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
      this._loadProgress(this.trip || this.pendingDraft || this.latestServer);
    }
    // The UI reads progress through this.trip only — raw docs keep their
    // own fields for CAS bases and conflict sides, never the view.
    this._overlayProgress(this.trip);
    this._listeners.forEach(function (fn) { fn(self); });
  };

  // One-time local progress resolution. A stored snapshot always wins;
  // otherwise the first doc still carrying the legacy shared fields
  // (server trip, unsent draft or last-known cache — old drafts double as
  // a backup here) seeds the local copy, which is then persisted so the
  // seed can never re-run. Called with a null doc when nothing has loaded
  // yet — it simply stays unloaded for the next emit.
  TripStore.prototype._loadProgress = function (doc) {
    var stored = null;
    try { stored = JSON.parse(global.localStorage.getItem(LOCAL_PROGRESS_KEY) || 'null'); } catch (e) {}
    if (stored && typeof stored === 'object') {
      this.localProgress = {
        visitStatus: stored.visitStatus || {},
        programmeStatus: stored.programmeStatus || {}
      };
      this._progressLoaded = true;
      return;
    }
    if (!doc) return;
    this.localProgress = {
      visitStatus: JSON.parse(JSON.stringify(doc.visitStatus || {})),
      programmeStatus: JSON.parse(JSON.stringify(doc.programmeStatus || {}))
    };
    this._progressLoaded = true;
    try { global.localStorage.setItem(LOCAL_PROGRESS_KEY, JSON.stringify(this.localProgress)); } catch (e) {}
  };

  // Replace a doc's progress fields with deep copies of the local state.
  // Copies (not references) keep _normalizeTrip's legacy-id transfer and
  // any future mutator from writing straight into the local store.
  TripStore.prototype._overlayProgress = function (doc) {
    if (!doc) return doc;
    doc.visitStatus = JSON.parse(JSON.stringify(this.localProgress.visitStatus));
    doc.programmeStatus = JSON.parse(JSON.stringify(this.localProgress.programmeStatus));
    return doc;
  };

  // Check-in write: mutate a draft of the local progress copy through the
  // same Rules helpers the doc model uses, persist the local mirror, emit
  // instantly, then save the whole trip snapshot — progress now lives
  // inside the owner's personal doc, so the tick is durable server-side
  // once the write lands. Resolves like save() ('saved'|'local'|...), so
  // the UI's durable-write toast gate needs no new vocabulary.
  TripStore.prototype.applyLocalProgress = function (mutator) {
    var progressDraft = JSON.parse(JSON.stringify(this.localProgress));
    try { mutator(progressDraft); } catch (e) { return Promise.resolve('error'); }
    this.localProgress = progressDraft;
    try { global.localStorage.setItem(LOCAL_PROGRESS_KEY, JSON.stringify(progressDraft)); } catch (e) {}
    this._emit();
    // No trip doc loaded at all (catalogue fetch failed hard): the local
    // copy already persisted above — skip the doc write entirely.
    if (!this.trip && !this.pendingDraft) return Promise.resolve('local');
    return this.save(function (draft) {
      // Write the post-mutation snapshot explicitly — the draft already
      // carries the overlaid copy, but pinning the exact fields keeps the
      // doc's progress = this tick's result rather than any older overlay.
      draft.visitStatus = JSON.parse(JSON.stringify(progressDraft.visitStatus));
      draft.programmeStatus = JSON.parse(JSON.stringify(progressDraft.programmeStatus));
    });
  };

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
  // occurrence ids, visit/programme status and unrelated place metadata
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
      ['label', 'notes'].forEach(function (f) {
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
        if (trip.visitStatus && trip.visitStatus[stop.occurrenceId]) visitedLegacy = true;
      });
      ['start', 'end'].forEach(function (which) {
        var endpoint = day[which];
        if (endpoint && endpoint.placeId === LEGACY_STATION_ID) {
          endpoint.placeId = CANONICAL_INFO_ID;
          if (trip.visitStatus && trip.visitStatus[day.dayId + '-' + which]) visitedLegacy = true;
        }
      });
    });
    // A legacy row that was already ticked counts toward the canonical
    // record's official check.
    var officialStatus = trip.programmeStatus && trip.programmeStatus.official;
    if (visitedLegacy || (officialStatus && officialStatus[LEGACY_STATION_ID])) {
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
      'Content-Type': 'application/json',
      'X-Biwa-Owner': this.ownerId
    };
  };

  // Mint-or-load the device identity. The UUID is random per browser
  // profile; a pairing claim overwrites the stored id before the app
  // reloads, so this function only ever mints for genuinely new devices.
  function loadOwnerId() {
    var stored = null;
    try { stored = global.localStorage.getItem(LOCAL_OWNER_KEY); } catch (e) {}
    if (stored && OWNER_ID_RE.test(stored)) return stored;
    var uuid = (global.crypto && global.crypto.randomUUID)
      ? global.crypto.randomUUID()
      // Hand-rolled v4 for the rare browser lacking crypto.randomUUID —
      // collisions are still astronomically unlikely at 122 random bits.
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          var r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
        });
    var id = 'dev:' + uuid;
    try { global.localStorage.setItem(LOCAL_OWNER_KEY, id); } catch (e) {}
    return id;
  }

  // The UI flips this when a dialog opens/closes. Opening an editor bumps the
  // read generation so an in-flight GET can no longer adopt over the edit.
  TripStore.prototype.setEditorActive = function (active) {
    this.editorActive = !!active;
    if (active) this._readSeq++;
  };

  // --- boot ------------------------------------------------------------------

  TripStore.prototype.init = function () {
    var self = this;
    // Ask for durable storage so local check-in progress survives long
    // idle stretches — browsers may evict non-persistent site data, and
    // there is no way for a page to set an expiry itself. Best-effort:
    // an unsupported API or a denied grant quietly does nothing.
    if (global.navigator && navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function () {});
    }
    return Promise.all([
      fetch('data/checkpoints.json').then(function (r) { return r.json(); }),
      fetch('data/trip-seed.json').then(function (r) { return r.json(); })
    ]).then(function (results) {
      self.places = results[0].places;
      var seed = results[1];
      // The seed defers to checkpoints.json so the catalogue is single-source.
      seed.places = self.places;
      self._seed = seed;
      return self.refresh();
    }).then(function () {
      self._startPolling();
      return self;
    }).catch(function () {
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
    var draft = null, cached = null;
    try { draft = JSON.parse(global.localStorage.getItem(LOCAL_DRAFT_KEY) || 'null'); } catch (e) {}
    if (allowSharedCache) {
      try { cached = JSON.parse(global.localStorage.getItem(LOCAL_LAST_KNOWN_KEY) || 'null'); } catch (e) {}
    }
    if (!this.trip) this.trip = draft || cached || this._seed;
    // The caller may follow with a more specific state (e.g. 'unauthorized').
    this._setState(this.localOnly ? 'local' : 'disconnected');
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
    var stale = function () { return seq !== self._readSeq; };
    return fetch(this.apiBase + 'biwa-trip', { headers: this._headers() })
      .then(function (res) {
        if (res.status === 503) {
          if (stale()) return false;
          // Sharing is down or not configured — temporary, keep polling.
          self.localOnly = true;
          self._ensureFallbackSnapshot();
          self._setState('unavailable');
          return false;
        }
        if (res.status === 401 || res.status === 403) {
          if (stale()) return false;
          // A guard response means shared state is off-limits — reset the
          // display to the local seed/draft. A cached shared snapshot must
          // never surface after a rejection, so the fallback deliberately
          // skips it, and browser provider config is cleared.
          self.localOnly = true;
          self.capabilities = {};
          self.browserMapsKey = null;
          self.latestServer = null;
          if (!self.pendingDraft) self.trip = null;
          self._adoptLocalFallback(false);
          self._setState('unauthorized');
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
              JSON.stringify(self.capabilities) !== JSON.stringify(nextCapabilities) ||
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
          self.localOnly = body.sharingAvailable === false;
          if (body.trip) {
            self._adoptServerTrip(body.trip);
            return true;
          }
          if (self.localOnly) {
            // Backend absent: seed locally, keep polling.
            self._ensureFallbackSnapshot();
            self._setState('unavailable');
            return false;
          }
          // This owner has never saved: seed their personal doc now.
          return self._seedOwner().then(function () { return true; });
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
    if (this.pendingDraft) { this.trip = this.pendingDraft; return; }
    if (!this.trip) this._adoptLocalFallback(true);
  };

  // Record the authoritative server snapshot. It is displayed only when no
  // unsent draft is visible — a background read must never hide the user's
  // un-synced work. latestServer always tracks the newest server state (the
  // CAS anchor for explicit replaces and the conflict base).
  TripStore.prototype._adoptServerTrip = function (trip) {
    // Normalize before the last-known cache write so a stale-metadata
    // snapshot is never persisted as "known good".
    this._normalizeTrip(trip);
    this.latestServer = trip;
    this.localOnly = false;
    try { global.localStorage.setItem(LOCAL_LAST_KNOWN_KEY, JSON.stringify(trip)); } catch (e) {}
    if (this.pendingDraft) {
      this.trip = this.pendingDraft;
      this._emit();   // draft stays visible; no 'saved' label while unsent
      return;
    }
    // The personal doc owns progress now — a paired same-owner device's
    // ticks arrive through it. Mirror the adopted fields into the local
    // copy so the emit overlay and any offline view stay current. Skipped
    // while a pendingDraft is up: that draft's progress (already mirrored
    // locally) is the newer work and must not be overwritten in view.
    if (trip.visitStatus || trip.programmeStatus) {
      this.localProgress = {
        visitStatus: JSON.parse(JSON.stringify(trip.visitStatus || {})),
        programmeStatus: JSON.parse(JSON.stringify(trip.programmeStatus || {}))
      };
      this._progressLoaded = true;
      try { global.localStorage.setItem(LOCAL_PROGRESS_KEY, JSON.stringify(this.localProgress)); } catch (e) {}
    }
    this.trip = trip;
    this.conflict = null;
    if (this.state !== 'saving') this._setState('saved');
  };

  TripStore.prototype._seedOwner = function () {
    var self = this;
    this.trip = this._seed;
    return this._put(this._seed, 0).then(function (result) {
      // A 409 here means a paired same-owner device seeded first — just
      // read back what it wrote.
      if (result === 'conflict') return self.refresh();
      return result;
    });
  };

  TripStore.prototype._markDisconnected = function () {
    // Keep showing the last-known snapshot (invite holders only) or the seed
    // rather than a blank app — labelled stale by the UI, never live.
    this._ensureFallbackSnapshot();
    if (this.state !== 'saving') this._setState('disconnected');
  };

  // --- writes ----------------------------------------------------------------

  // Queue a mutation. `mutator` edits a draft copy; the whole snapshot is then
  // written via CAS. options.intent marks simple idempotent checkbox intents
  // eligible for one bounded rebase retry: {kind:'visit'|'programme',
  // key, programme?, value:true}. Retained for compatibility — check-in
  // progress is per-device now and bypasses save() via applyLocalProgress.
  TripStore.prototype.save = function (mutator, options) {
    var self = this;
    // A throwing mutator must not poison the queue for later writes.
    this._writeQueue = this._writeQueue.then(function () {
      return self._applySave(mutator, options);
    }).catch(function () { return 'error'; });
    return this._writeQueue;
  };

  TripStore.prototype._applySave = function (mutator, options) {
    var self = this;
    if (this.localOnly) {
      var localDraft = JSON.parse(JSON.stringify(this.pendingDraft || this.trip));
      try { mutator(localDraft); } catch (e) { return 'error'; }
      // Normalize before the local cache write — the draft the device
      // keeps must carry corrected metadata, not the pre-correction copy.
      this._normalizeTrip(localDraft);
      this.pendingDraft = localDraft;
      this.trip = localDraft;
      try { global.localStorage.setItem(LOCAL_DRAFT_KEY, JSON.stringify(localDraft)); } catch (e) {}
      this._setState('local');
      return 'local';
    }
    // Unsent drafts are the base for the next edit — a failed PUT never
    // discards the user's accumulated changes. The draft keeps its OWN base
    // revision: a later refresh must never bump it (that would silently
    // overwrite another rider's edits on retry).
    var hadPendingDraft = !!this.pendingDraft || !!this.conflict;
    var draft = JSON.parse(JSON.stringify(this.pendingDraft || this.trip));
    try { mutator(draft); } catch (e) { return 'error'; }
    this._saving = true;
    this._readSeq++;                 // in-flight reads are now obsolete
    this._setState('saving');
    return this._put(draft, draft.revision || 0).then(function (result) {
      self._saving = false;
      if (result === 'saved') {
        // Label 'saved' only now — _saving had to clear first, and _put's
        // adoption deliberately declined to flip state while a draft was up.
        self.pendingDraft = null;
        self.trip = draft;
        self._setState('saved');
        return 'saved';
      }
      if (result === 'conflict') {
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
      self._setState(result === 'unavailable' ? 'unavailable' : 'disconnected');
      return result;
    });
  };

  TripStore.prototype._put = function (trip, expectedRevision) {
    var self = this;
    // Last gate before the wire: even a queued draft created before the
    // catalogue correction reaches the server with current metadata, so
    // the immutable-manifest check can never reject it.
    this._normalizeTrip(trip);
    // Progress fields stay in the payload — the personal doc owns them.
    return fetch(this.apiBase + 'biwa-trip', {
      method: 'PUT',
      headers: this._headers(),
      body: JSON.stringify({ expectedRevision: expectedRevision, trip: trip })
    }).then(function (res) {
      if (res.status === 409) {
        // Consume the server's latest trip — it is authoritative, and the
        // conflict/rebase paths below need the real base revision.
        return res.json().then(function (body) {
          if (body && body.trip) self._adoptServerTrip(body.trip);
          else self.refresh();
          return 'conflict';
        }).catch(function () { self.refresh(); return 'conflict'; });
      }
      if (res.status === 503) { self._setState('unavailable'); return 'unavailable'; }
      if (!res.ok) { self._markDisconnected(); return 'error'; }
      return res.json().then(function (body) {
        trip.revision = body.revision;
        trip.updatedAt = body.updatedAt;
        self._adoptServerTrip(trip);
        return 'saved';
      });
    }).catch(function () { self._markDisconnected(); return 'error'; });
  };

  // Can this idempotent intent still apply to the latest snapshot? Returns
  // false when the target was deleted — the tick is dropped cleanly. Checks
  // the server snapshot, not the visible draft.
  TripStore.prototype._intentApplicable = function (intent, trip) {
    trip = trip || this.latestServer || this.trip;
    if (!trip) return false;
    if (intent.kind === 'visit') {
      return this._occurrenceExists(trip, intent.key);
    }
    if (intent.kind === 'arrival') {
      // A v2 arrival tick carries both parts; it applies when either side
      // still exists (occurrence for the visit flag, place for programmes).
      return this._occurrenceExists(trip, intent.occurrenceId) ||
        (trip.places || []).some(function (p) { return p.placeId === intent.placeId; });
    }
    return (trip.places || []).some(function (p) { return p.placeId === intent.key; });
  };

  TripStore.prototype._occurrenceExists = function (trip, occurrenceId) {
    return (trip.days || []).some(function (day) {
      if ((day.stops || []).some(function (s) { return s.occurrenceId === occurrenceId; })) return true;
      return occurrenceId === day.dayId + '-start' && !!day.start ||
        occurrenceId === day.dayId + '-end' && !!day.end;
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
        self._emit();
        return 'error';
      }
      var already;
      if (intent.kind === 'arrival') {
        // The UI tick derived "arrived" from the own visit OR the programme
        // flag; the intent is already satisfied when the server-side
        // derived state matches what the user meant.
        var place = (current.places || []).filter(function (p) {
          return p.placeId === intent.placeId;
        })[0];
        var fams = place ? familiesOf(place.programmes) : [];
        var progHit = fams.some(function (f) {
          return current.programmeStatus && current.programmeStatus[f] &&
            current.programmeStatus[f][intent.placeId];
        });
        var visitHit = !!(current.visitStatus && current.visitStatus[intent.occurrenceId]);
        already = visitHit || progHit;
      } else {
        already = intent.kind === 'visit'
          ? !!(current.visitStatus && current.visitStatus[intent.key])
          : !!(current.programmeStatus && current.programmeStatus[intent.programme] &&
               current.programmeStatus[intent.programme][intent.key]);
      }
      if (!self._intentApplicable(intent, current) || already === intent.value) {
        // Target deleted (drop the intent) or it already landed on the
        // server — either way nothing to write. A prior pendingDraft still
        // carries any other unsent edits and stays recoverable.
        if (!self.pendingDraft) { self.trip = current; self._setState('saved'); }
        return 'saved';
      }
      var rebased = JSON.parse(JSON.stringify(current));
      if (intent.kind === 'arrival') {
        // One tick → own visit flag plus EVERY programme family the place
        // belongs to (a shared checkpoint like Mizudori clears both).
        if (self._occurrenceExists(rebased, intent.occurrenceId)) {
          rebased.visitStatus = rebased.visitStatus || {};
          if (intent.value) rebased.visitStatus[intent.occurrenceId] = true;
          else delete rebased.visitStatus[intent.occurrenceId];
        }
        var target = (rebased.places || []).filter(function (p) {
          return p.placeId === intent.placeId;
        })[0];
        familiesOf(target ? target.programmes : []).forEach(function (family) {
          rebased.programmeStatus = rebased.programmeStatus || {};
          rebased.programmeStatus[family] = rebased.programmeStatus[family] || {};
          if (intent.value) rebased.programmeStatus[family][intent.placeId] = true;
          else delete rebased.programmeStatus[family][intent.placeId];
        });
      } else if (intent.kind === 'visit') {
        rebased.visitStatus = rebased.visitStatus || {};
        if (intent.value) rebased.visitStatus[intent.key] = true;
        else delete rebased.visitStatus[intent.key];
      } else {
        rebased.programmeStatus = rebased.programmeStatus || {};
        rebased.programmeStatus[intent.programme] = rebased.programmeStatus[intent.programme] || {};
        if (intent.value) rebased.programmeStatus[intent.programme][intent.key] = true;
        else delete rebased.programmeStatus[intent.programme][intent.key];
      }
      self._saving = true;
      self._readSeq++;
      self._setState('saving');
      return self._put(rebased, current.revision || 0).then(function (result) {
        self._saving = false;
        if (result === 'saved') {
          self.pendingDraft = null;
          self.trip = rebased;
          self._setState('saved');
          return 'saved';
        }
        if (result === 'conflict') {
          self.pendingDraft = draft;
          return self._declareConflict(draft);
        }
        // Failure during rebase: the draft is still recoverable, the intent
        // is not re-applied automatically a second time.
        self.pendingDraft = draft;
        self.trip = draft;
        self._setState(result === 'unavailable' ? 'unavailable' : 'disconnected');
        return result;
      });
    });
  };

  TripStore.prototype._declareConflict = function (draft) {
    // The draft stays visible AND recoverable; the server snapshot is kept
    // separately as the conflict's other side.
    this.pendingDraft = draft;
    this.trip = draft;
    this.conflict = { draft: draft, server: this.latestServer };
    this._setState('conflict');
    return 'conflict';
  };

  // User chose "load latest": adopt the server snapshot kept on the conflict
  // (or the newest one seen), drop the draft and confirm the synced state.
  TripStore.prototype.resolveConflictReload = function () {
    var server = (this.conflict && this.conflict.server) || this.latestServer;
    this.conflict = null;
    this.pendingDraft = null;
    if (!server) return this.refresh();
    this.latestServer = server;
    this.trip = server;
    this._setState('saved');
    return Promise.resolve('saved');
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
    if (!draft) { this._emit(); return Promise.resolve('none'); }
    return this.refresh().then(function (ok) {
      if (!ok || !self.latestServer) {
        // No trustworthy server base — do not write; keep the draft.
        self.pendingDraft = draft;
        self.trip = draft;
        self._emit();
        return 'error';
      }
      var base = self.latestServer.revision || 0;
      self._saving = true;
      self._readSeq++;
      self._setState('saving');
      return self._put(draft, base).then(function (result) {
        self._saving = false;
        if (result === 'saved') {
          self.pendingDraft = null;
          self.trip = draft;
          self._setState('saved');
          return 'saved';
        }
        if (result === 'conflict') return self._declareConflict(draft);
        self.pendingDraft = draft;
        self.trip = draft;
        self._setState(result === 'unavailable' ? 'unavailable' : 'disconnected');
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
    if (!this.pendingDraft || this.localOnly || this._saving || this.editorActive || this.conflict) {
      return Promise.resolve('skipped');
    }
    var draft = this.pendingDraft;
    this._saving = true;
    this._readSeq++;
    this._setState('saving');
    return this._put(draft, draft.revision || 0).then(function (result) {
      self._saving = false;
      if (result === 'saved') {
        self.pendingDraft = null;
        self.trip = draft;
        self._setState('saved');
        return 'saved';
      }
      if (result === 'conflict') return self._declareConflict(draft);
      // error/unavailable: the draft stays recoverable and visible.
      self.trip = draft;
      self._setState(result === 'unavailable' ? 'unavailable' : 'disconnected');
      return result;
    });
  };

  TripStore.prototype.retryPendingDraft = function () {
    var self = this;
    return this.refresh().then(function () { return self._retryPendingDraft(); });
  };

  // Discard the recoverable unsent draft and adopt the latest shared state.
  TripStore.prototype.discardPendingDraft = function () {
    this.pendingDraft = null;
    this.conflict = null;
    return this.refresh();
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
        if (ok && !self.localOnly && !self.editorActive && !self._saving && !self.conflict) {
          self._retryPendingDraft();
        }
      });
    };
    this._pollTimer = global.setInterval(function () {
      if (global.document && global.document.visibilityState === 'visible') tick();
    }, POLL_MS);
    if (global.document) {
      global.document.addEventListener('visibilitychange', function () {
        if (global.document.visibilityState === 'visible') tick();
      });
    }
    if (global.addEventListener) {
      global.addEventListener('focus', tick);
    }
  };

  // --- pairing (share this device's trip to another of yours) ---------------

  // Mint a short-lived code that resolves to this device's owner id.
  // Resolves {code, expiresIn} or {error} — never throws.
  TripStore.prototype.createPairCode = function () {
    return fetch(this.apiBase + 'biwa-pair', {
      method: 'POST', headers: this._headers(), body: JSON.stringify({ op: 'create' })
    }).then(function (res) { return res.json(); })
      .catch(function () { return { ok: false, error: 'network' }; });
  };

  // Resolve a code shown on another device to its owner id.
  // Resolves {ownerId} on success or {error:'code_expired'|...}.
  TripStore.prototype.claimPairCode = function (code) {
    return fetch(this.apiBase + 'biwa-pair', {
      method: 'POST', headers: this._headers(),
      body: JSON.stringify({ op: 'claim', code: code })
    }).then(function (res) { return res.json(); })
      .catch(function () { return { ok: false, error: 'network' }; });
  };

  // Switch this device to a claimed owner id. The old identity's local
  // state is wiped — progress, draft and last-known keys would otherwise
  // leak into the newly adopted doc's overlay. The caller reloads the
  // page so every module reboots under the new identity.
  TripStore.prototype.adoptOwner = function (ownerId) {
    if (!ownerId || !OWNER_ID_RE.test(ownerId)) return false;
    try {
      global.localStorage.removeItem(LOCAL_PROGRESS_KEY);
      global.localStorage.removeItem(LOCAL_DRAFT_KEY);
      global.localStorage.removeItem(LOCAL_LAST_KNOWN_KEY);
      global.localStorage.setItem(LOCAL_OWNER_KEY, ownerId);
    } catch (e) {}
    this.ownerId = ownerId;
    return true;
  };

  // The programmeStatus families a place's membership maps to — 'rally'
  // plus 'official' for any official-* area (shared checkpoints hit both).
  function familiesOf(programmes) {
    var fams = [];
    (programmes || []).forEach(function (p) {
      if (p === 'rally' && fams.indexOf('rally') === -1) fams.push('rally');
      else if (typeof p === 'string' && p.indexOf('official-') === 0 &&
               fams.indexOf('official') === -1) fams.push('official');
    });
    return fams;
  }

  // --- providers (public, server-proxied) -------------------------------------

  TripStore.prototype.fetchRoute = function (dayId, coordinates, requestId) {
    return fetch(this.apiBase + 'biwa-route', {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ dayId: dayId, orderedCoordinates: coordinates, requestId: requestId })
    }).then(function (res) { return res.json(); })
      .catch(function () { return { ok: false, error: 'network' }; });
  };

  // Transient Google place details by INTERNAL id (never a raw Google id —
  // the server resolves the mapping so the endpoint is not an open proxy).
  TripStore.prototype.fetchPlace = function (placeId) {
    return fetch(this.apiBase + 'biwa-place?placeId=' + encodeURIComponent(placeId))
      .then(function (res) { return res.json(); })
      .catch(function () { return { ok: false, error: 'network' }; });
  };

  // Photo URL for <img src> — the server proxies, bounds and hosts-checks
  // Google's photo bytes; the client never touches provider credentials.
  TripStore.prototype.photoUrl = function (placeId, index, width) {
    return this.apiBase + 'biwa-photo?placeId=' + encodeURIComponent(placeId) +
      '&index=' + index + '&width=' + width;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = TripStore;
  global.BiwaTripStore = TripStore;
})(typeof window !== 'undefined' ? window : globalThis);
