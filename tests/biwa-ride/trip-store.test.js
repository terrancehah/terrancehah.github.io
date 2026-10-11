// Behavior tests for trip-store.js: CAS drafts, conflict handling, recovery.
// A fake fetch + in-memory "server" drives real store instances — no network.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const seed = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'projects/biwa-ride/data/trip-seed.json'), 'utf8'));
const catalogue = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'projects/biwa-ride/data/checkpoints.json'), 'utf8'));

// trip-store exports its constructor for CommonJS and reads browser globals
// off globalThis, so stub the globals before requiring it.
function stubGlobals(fetchImpl) {
  // The app is public — the plain URL is enough, no invite fragment needed.
  globalThis.location = { hash: '#/timeline', pathname: '/projects/biwa-ride/', search: '' };
  globalThis.history = { replaceState() {} };
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  };
  const local = new Map();
  globalThis.localStorage = {
    getItem: k => (local.has(k) ? local.get(k) : null),
    setItem: (k, v) => local.set(k, String(v)),
    removeItem: k => local.delete(k)
  };
  globalThis.document = undefined;             // polling guards on this
  globalThis.setInterval = () => 0;            // never fire polls in tests
  globalThis.clearInterval = () => {};
  globalThis.addEventListener = () => {};
  globalThis.fetch = fetchImpl;
}

const TripStore = require('../../projects/biwa-ride/trip-store.js');

function jsonRes(status, body) {
  return {
    status, ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body)
  };
}

// A minimal CAS server: remembers the newest trip + revision, answers
// GET/PUT like the real endpoints (409 carries the latest trip).
function makeServer() {
  return {
    trip: null, rev: 0, down: false, authFail: false, deferGet: null,
    handleGet() {
      if (this.authFail) return Promise.resolve(jsonRes(401, { ok: false }));
      if (this.down) return Promise.resolve(jsonRes(503, { ok: false, error: 'not_configured' }));
      const body = () => ({ ok: true, trip: this.trip, capabilities: {} });
      // Body is evaluated at resolution time so a held-open read returns
      // whatever the server looks like when it finally answers.
      if (this.deferGet) return this.deferGet.then(() => jsonRes(200, body()));
      return Promise.resolve(jsonRes(200, body()));
    },
    handlePut(body) {
      if (this.authFail) return Promise.resolve(jsonRes(401, { ok: false }));
      if (this.down) return Promise.resolve(jsonRes(503, { ok: false, error: 'not_configured' }));
      if (this.force409) {
        this.force409 -= 1;
        return Promise.resolve(jsonRes(409, { ok: false, error: 'conflict', trip: this.trip }));
      }
      if (body.expectedRevision !== this.rev) {
        return Promise.resolve(jsonRes(409, { ok: false, error: 'conflict', trip: this.trip }));
      }
      this.rev += 1;
      this.trip = Object.assign({}, body.trip, { revision: this.rev });
      return Promise.resolve(jsonRes(200, { ok: true, revision: this.rev, updatedAt: 't' }));
    }
  };
}

function makeFetch(server) {
  const calls = [];
  const impl = (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const call = {
      url: String(url), method,
      headers: opts.headers || {},
      body: opts.body ? JSON.parse(opts.body) : null
    };
    calls.push(call);
    if (call.url.endsWith('data/checkpoints.json')) return Promise.resolve(jsonRes(200, catalogue));
    if (call.url.endsWith('data/trip-seed.json')) return Promise.resolve(jsonRes(200, seed));
    if (call.url.includes('biwa-trip')) {
      return method === 'GET' ? server.handleGet() : server.handlePut(call.body);
    }
    return Promise.resolve(jsonRes(404, { ok: false }));
  };
  impl.calls = calls;
  return impl;
}

function tripWithRev(rev, extra) {
  const t = JSON.parse(JSON.stringify(seed));
  t.places = catalogue.places;
  t.revision = rev;
  return Object.assign(t, extra || {});
}

async function makeStore(server) {
  const fetchImpl = makeFetch(server);
  stubGlobals(fetchImpl);
  const store = new TripStore();
  await store.init();
  store.fetchImpl = fetchImpl;
  return store;
}

// --- public shared state -------------------------------------------------------

test('plain URL works: GET/PUT carry no Authorization header, first load seeds', async () => {
  const server = makeServer();
  const store = await makeStore(server);
  // First load with an empty shared state seeds the blueprint and PUTs it.
  assert.ok(store.trip, 'seed rendered on first load');
  assert.equal(server.rev, 1, 'seed saved to shared state');
  const apiCalls = store.fetchImpl.calls.filter(c => c.url.includes('biwa-trip'));
  assert.ok(apiCalls.length >= 2, 'GET then PUT happened');
  for (const call of apiCalls) {
    assert.ok(!('Authorization' in call.headers) && !('authorization' in call.headers),
      'no auth header on public requests');
  }
  assert.equal(store.state, 'saved');
});

// --- draft retry must use the draft's own base revision ------------------------

test('offline draft rev1 + remote rev2: retry CASes base 1 and surfaces 409, no overwrite', async () => {
  const server = makeServer();
  server.trip = tripWithRev(1); server.rev = 1;
  const store = await makeStore(server);
  assert.equal(store.trip.revision, 1);

  // Go offline and edit — the draft is built on revision 1.
  server.down = true;
  await store.save(d => { d.days[0].label = 'my offline edit'; });
  assert.ok(store.pendingDraft, 'draft retained after failed write');
  assert.equal(store.trip.days[0].label, 'my offline edit', 'draft stays visible');

  // Another rider saves while we are offline.
  server.down = false;
  server.trip = tripWithRev(2, { days: server.trip.days.map((d, i) =>
    i === 0 ? Object.assign({}, d, { label: 'other rider' }) : d) });
  server.rev = 2;

  // A refresh must NOT hide the draft nor bump its base revision.
  await store.refresh();
  assert.equal(store.trip.days[0].label, 'my offline edit');
  assert.equal(store.latestServer.revision, 2);
  assert.equal(store.pendingDraft.revision, 1);

  const putsBefore = store.fetchImpl.calls.filter(c => c.method === 'PUT').length;
  const result = await store._retryPendingDraft();
  assert.equal(result, 'conflict');
  const lastPut = store.fetchImpl.calls.filter(c => c.method === 'PUT').pop();
  assert.equal(lastPut.body.expectedRevision, 1, 'retries the draft base, not rev2');
  assert.equal(putsBefore + 1, store.fetchImpl.calls.filter(c => c.method === 'PUT').length);
  assert.ok(store.conflict, 'explicit conflict surfaced');
  assert.ok(store.pendingDraft, 'draft retained');
  assert.equal(server.trip.days[0].label, 'other rider', 'remote never overwritten');
});

test('pending draft retries cleanly when the base is still current', async () => {
  const server = makeServer();
  server.trip = tripWithRev(1); server.rev = 1;
  const store = await makeStore(server);
  server.down = true;
  await store.save(d => { d.days[0].label = 'offline'; });
  server.down = false;
  const result = await store._retryPendingDraft();
  assert.equal(result, 'saved');
  assert.equal(store.state, 'saved');
  assert.equal(store.pendingDraft, null);
  assert.equal(server.rev, 2);
  assert.equal(server.trip.days[0].label, 'offline');
});

test('immediate successful save lands saved with draft cleared', async () => {
  const server = makeServer();
  const store = await makeStore(server);   // seeds → rev1
  assert.equal(server.rev, 1);
  const result = await store.save(d => { d.days[1].label = 'Day two edit'; });
  assert.equal(result, 'saved');
  assert.equal(store.state, 'saved');
  assert.equal(store.pendingDraft, null);
  assert.equal(store.trip.revision, 2);
});

// --- stale reads -----------------------------------------------------------------

test('in-flight GET cannot adopt after an editor opens', async () => {
  const server = makeServer();
  server.trip = tripWithRev(1); server.rev = 1;
  const store = await makeStore(server);

  // The remote moves while a read is held open; the editor then opens and
  // the late response must be dropped entirely.
  let release;
  server.deferGet = new Promise(r => { release = r; });
  const readP = store.refresh();
  const remote = tripWithRev(2); remote.days[0].label = 'remote-won';
  server.trip = remote; server.rev = 2;
  store.setEditorActive(true);
  release();
  server.deferGet = null;
  await readP;
  assert.notEqual(store.trip.days[0].label, 'remote-won', 'stale read not adopted');
  assert.equal(store.trip.revision, 1, 'still on the pre-read snapshot');
  store.setEditorActive(false);
});

test('in-flight GET cannot adopt over a save that began during the read', async () => {
  const server = makeServer();
  server.trip = tripWithRev(1); server.rev = 1;
  const store = await makeStore(server);
  let release;
  server.deferGet = new Promise(r => { release = r; });
  const readP = store.refresh();                // GET held open
  const saveP = store.save(d => { d.days[0].label = 'during read'; });
  // Let the queued write flush to the server (rev2) before the remote moves.
  await new Promise(r => setImmediate(r));
  assert.equal(server.rev, 2, 'save landed at its own base');
  const remote = tripWithRev(3); remote.days[0].label = 'remote-won';
  server.trip = remote; server.rev = 3;
  release();
  server.deferGet = null;
  await Promise.all([readP, saveP]);
  assert.equal(store.trip.days[0].label, 'during read', 'write result shown, not stale read');
  assert.equal(store.trip.revision, 2, 'own saved revision kept, remote rev3 not adopted');
});

// --- availability and invite handling ---------------------------------------------

test('503 is temporary: keeps content, recovers via refresh, retry then sends draft', async () => {
  const server = makeServer();
  server.trip = tripWithRev(1); server.rev = 1;
  const store = await makeStore(server);
  server.down = true;
  await store.refresh();
  assert.equal(store.state, 'unavailable');
  // Writes go local while sharing is down — but this is not a permanent
  // mode: the poll below recovers to shared state and the draft sends.
  assert.ok(store.trip, 'last-known content still shown, never blank');
  await store.save(d => { d.days[2].label = 'queued while down'; });
  assert.ok(store.pendingDraft);
  server.down = false;
  await store.refresh();
  const result = await store._retryPendingDraft();
  assert.equal(result, 'saved');
  assert.equal(store.state, 'saved');
  assert.equal(server.trip.days[2].label, 'queued while down');
});

test('first-load 401 renders the seed, never a cached shared trip', async () => {
  const server = makeServer();
  server.authFail = true;
  // Plant a cached shared snapshot — a rejected first read must not see it.
  stubGlobals(makeFetch(server));
  globalThis.localStorage.setItem('biwa:v2:last-known-trip',
    JSON.stringify(tripWithRev(99, { provenance: 'stale-shared' })));
  const store = new TripStore();
  await store.init();
  assert.equal(store.state, 'unauthorized');
  assert.equal(store.localOnly, true);
  assert.ok(store.trip, 'fallback content rendered');
  assert.equal(store.trip.days.length, 3, 'seed rendered');
  assert.notEqual(store.trip.provenance, 'stale-shared');
  assert.equal(store.browserMapsKey, null);
});

// --- queue safety -----------------------------------------------------------------

test('a throwing mutator does not poison the write queue', async () => {
  const server = makeServer();
  const store = await makeStore(server);
  const r1 = await store.save(() => { throw new Error('boom'); });
  assert.equal(r1, 'error');
  const r2 = await store.save(d => { d.days[0].label = 'after throw'; });
  assert.equal(r2, 'saved');
  assert.equal(server.trip.days[0].label, 'after throw');
});

// --- conflict resolution ------------------------------------------------------------

test('conflict reload adopts the server trip; reapply CASes latest base; repeated 409 keeps draft', async () => {
  const server = makeServer();
  server.trip = tripWithRev(1); server.rev = 1;
  const store = await makeStore(server);

  server.trip = tripWithRev(2); server.rev = 2;   // another rider moved on
  const r = await store.save(d => { d.days[0].label = 'mine'; });
  assert.equal(r, 'conflict');
  assert.ok(store.conflict);
  assert.equal(store.trip.days[0].label, 'mine', 'draft stays visible behind the dialog');

  // "Load latest" adopts the server snapshot kept on the conflict.
  const rr = await store.resolveConflictReload();
  assert.equal(rr, 'saved');
  assert.equal(store.trip.revision, 2);
  assert.equal(store.pendingDraft, null);

  // Conflict again, then reapply — the write goes against the refreshed base.
  server.trip = tripWithRev(3); server.rev = 3;
  await store.save(d => { d.days[0].label = 'mine again'; });
  assert.ok(store.conflict);
  const ra = await store.resolveConflictReapply();
  assert.equal(ra, 'saved');
  assert.equal(server.trip.days[0].label, 'mine again');
  assert.equal(server.rev, 4);

  // A second 409 during reapply keeps the draft and re-shows the conflict.
  server.trip = tripWithRev(5); server.rev = 5;
  await store.save(d => { d.days[0].label = 'mine thrice'; });
  assert.ok(store.conflict);
  server.force409 = 1;                             // CAS fails even at right base
  const ra2 = await store.resolveConflictReapply();
  assert.equal(ra2, 'conflict');
  assert.ok(store.pendingDraft, 'draft retained after repeated 409');
  assert.ok(store.conflict, 'conflict re-presented');
});

test('reapply on a failed refresh does not write at all', async () => {
  const server = makeServer();
  server.trip = tripWithRev(1); server.rev = 1;
  const store = await makeStore(server);
  server.trip = tripWithRev(2); server.rev = 2;
  await store.save(d => { d.days[0].label = 'mine'; });
  assert.ok(store.conflict);
  server.down = true;
  const puts = () => store.fetchImpl.calls.filter(c => c.method === 'PUT').length;
  const before = puts();
  const ra = await store.resolveConflictReapply();
  assert.equal(ra, 'error');
  assert.equal(puts(), before, 'no write attempted without a trustworthy base');
  assert.ok(store.pendingDraft, 'draft kept');
});

test('409 over an accumulated draft surfaces whole-draft conflict, not partial rebase', async () => {
  const server = makeServer();
  server.trip = tripWithRev(1); server.rev = 1;
  const store = await makeStore(server);
  const occ = store.trip.days[0].stops[0].occurrenceId;

  // Offline label edit becomes a pending draft built on rev1.
  server.down = true;
  await store.save(d => { d.days[0].label = 'offline label'; });
  assert.ok(store.pendingDraft);

  // The remote moves meanwhile; service returns.
  server.down = false;
  const remote = tripWithRev(2); remote.days[1].label = 'remote edit';
  server.trip = remote; server.rev = 2;

  // A checkbox tick builds on the pending draft → 409. A single-intent
  // rebase would drop the label edit — the whole draft must conflict instead.
  const r = await store.save(
    d => { d.visitStatus[occ] = true; },
    { intent: { kind: 'visit', key: occ, value: true } });
  assert.equal(r, 'conflict');
  assert.ok(store.conflict, 'explicit conflict, no silent rebase');
  assert.equal(store.trip.days[0].label, 'offline label', 'earlier edit preserved');
  assert.equal(store.trip.visitStatus[occ], true, 'the tick is preserved too');
  assert.equal(server.trip.days[1].label, 'remote edit', 'remote untouched');
  assert.notEqual(server.trip.days[0].label, 'offline label', 'remote not overwritten');
  assert.ok(!(server.trip.visitStatus || {})[occ], 'tick not smuggled onto remote');
});

test('idempotent checkbox intent rebases once and drops cleanly when target deleted', async () => {
  const server = makeServer();
  server.trip = tripWithRev(1); server.rev = 1;
  const store = await makeStore(server);
  const occ = store.trip.days[0].stops[0].occurrenceId;

  // Remote checks the same occurrence — our intent already landed.
  server.trip = tripWithRev(2, { visitStatus: { [occ]: true } });
  server.rev = 2;
  const r = await store.save(
    d => { d.visitStatus[occ] = true; },
    { intent: { kind: 'visit', key: occ, value: true } });
  assert.equal(r, 'saved');
  assert.equal(store.conflict, null, 'no dialog when intent already landed');

  // Remote deleted the occurrence — the tick drops cleanly, no re-add.
  const trimmed = tripWithRev(3);
  trimmed.days[0].stops = trimmed.days[0].stops.slice(1);
  server.trip = trimmed; server.rev = 3;
  const gone = trimmed.days[0].stops[0] ? null : occ;
  const r2 = await store.save(
    d => { d.visitStatus[occ] = true; },
    { intent: { kind: 'visit', key: occ, value: true } });
  assert.equal(r2, 'saved');
  assert.ok(!(server.trip.visitStatus && server.trip.visitStatus[occ]),
    'deleted occurrence is not resurrected');
  assert.equal(gone, null); // fixture sanity: the slice actually removed it
});
