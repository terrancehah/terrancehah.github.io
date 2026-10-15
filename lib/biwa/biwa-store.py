"""Isolated storage/access helpers for the Lake Biwa ride endpoints.

This module deliberately does NOT import api/lib/_shared.py — that module is
Pacey's session store and pulls in Garmin/OpenAI. The Biwa trip uses its own
dedicated Redis database:

    BIWA_REDIS_URL                               — preferred: direct Redis URI
    BIWA_REDIS_REST_URL / BIWA_REDIS_REST_TOKEN  — dedicated Upstash database
    BIWA_GOOGLE_SERVER_KEY                       — Routes/Elevation (server-only)
    BIWA_GOOGLE_PLACES_KEY                       — Places details/photos (server-only; falls back to the server key)
    BIWA_GOOGLE_BROWSER_KEY                      — Maps JS (referrer-restricted)
    BIWA_DEV_ALLOW_MEMORY=1                      — local-dev-only in-memory store

Access model (schema v2): the trip is PUBLIC — no invite token. Reads are
open; mutations/provider calls are abuse-guarded (same-origin check, bounded
bodies, global + per-IP rate limits) and still go through atomic CAS so two
riders can never silently overwrite each other.

Fail-closed rule: without a configured backend (Redis, or the local
BIWA_DEV_ALLOW_MEMORY=1 opt-in — never under VERCEL) writes and provider
calls answer 503 {"error": "not_configured"}; the public GET still returns
capabilities/browserMapsKey so the static seed and map can load. There is no
silent fallback to Pacey's store and no in-memory production storage.
"""

import hashlib
import importlib.util
import json
import os
import re
import secrets
import threading
import time
import urllib.parse

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

HERE = os.path.dirname(os.path.abspath(__file__))


def load_biwa_module(name):
    """Import a kebab-case sibling module (e.g. 'biwa-models') by file path.

    Filenames follow the repo's kebab-case convention, which Python's import
    statement cannot express, so sibling helpers are loaded explicitly.
    """
    module_name = "biwa_" + name.replace("-", "_")
    if module_name in globals():
        return globals()[module_name]
    path = os.path.join(HERE, name + ".py")
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    globals()[module_name] = module
    return module


# --- Configuration -----------------------------------------------------------

REDIS_URL = os.getenv("BIWA_REDIS_REST_URL")
REDIS_TOKEN = os.getenv("BIWA_REDIS_REST_TOKEN")
# Preferred transport: a direct Redis URI to the same dedicated database.
# The Upstash REST pair above remains fully supported as the fallback.
DIRECT_REDIS_URL = os.getenv("BIWA_REDIS_URL")
GOOGLE_SERVER_KEY = os.getenv("BIWA_GOOGLE_SERVER_KEY")
GOOGLE_BROWSER_KEY = os.getenv("BIWA_GOOGLE_BROWSER_KEY")
# Places gets its own key so the (API-restricted) Routes/Elevation key and the
# Places key can be rotated/scoped independently; falls back to the shared
# server key when only one is provisioned.
GOOGLE_PLACES_KEY = os.getenv("BIWA_GOOGLE_PLACES_KEY") or GOOGLE_SERVER_KEY
DEV_ALLOW_MEMORY = os.getenv("BIWA_DEV_ALLOW_MEMORY") == "1"

# v2 namespace: the shared state key changed with the schema so the new app
# never touches the retired invite-gated snapshot (biwa:trip:state is left
# untouched in Redis).
TRIP_KEY = "biwa:v2:trip:state"
# Personal trip docs are keyed per owner identity: 'dev:<uuid>' today, a
# provider subject ('google:<sub>', ...) once real auth lands — the layout
# never needs to change. TRIP_KEY stays readable for the shared-doc era
# but new writes always target an owner key.
OWNER_KEY_PREFIX = "biwa:v2:owner:"
# Device-pairing grants live briefly under their own prefix — six base32-ish
# characters resolve to an ownerId the claiming device then adopts.
PAIR_KEY_PREFIX = "biwa:v2:pair:"
PAIR_CODE_TTL_S = 600
# Unambiguous alphabet — no 0/O, 1/I/L — so codes read aloud across a
# table or typed off a tiny screen never confuse glyphs.
PAIR_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
PAIR_CODE_LENGTH = 6
# '<scheme>:<id>' — scheme is a short lowercase word so future auth
# providers slot in beside 'dev'; the id part allows the common subject
# shapes (uuid, base64url, apple/google subs).
OWNER_ID_RE = re.compile(r"^[a-z][a-z0-9]{0,15}:[A-Za-z0-9._~+-]{8,128}$")
RATE_PREFIX = "biwa:rl:"
WRITE_RATE_LIMIT = 30          # trip writes per window (per IP)
ROUTE_RATE_LIMIT = 20          # route provider calls per window (per IP)
PLACES_RATE_LIMIT = 20         # Places detail calls — global AND per IP
PHOTO_RATE_LIMIT = 20          # photo media calls — global AND per IP
RATE_WINDOW_S = 60
MAX_BODY_BYTES = 200 * 1024    # bounded request bodies


class BiwaStore:
    """Trip-state persistence with atomic compare-and-set.

    Production uses the dedicated Redis database (direct URI preferred,
    Upstash REST supported) and a Lua script so revision checks and writes
    happen as one atomic operation — no silent last-write-wins. Local
    development may opt into an in-memory dict with a lock that mirrors the
    same semantics.
    """

    # Local-dev memory is shared at class level: every endpoint module
    # builds its own BiwaStore, and per-instance dicts would hide writes
    # made through a different endpoint in the same dev process. Records
    # are never reset between instances — only an explicitly injected
    # memory dict opts out of the shared pool.
    _SHARED_MEMORY = {}
    _SHARED_LOCK = threading.Lock()

    # Fixed-window rate counter as one atomic Lua call — INCR plus
    # first-write EXPIRE cannot race across concurrent invocations.
    _RATE_SCRIPT = """
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then
      redis.call('EXPIRE', KEYS[1], ARGV[1])
    end
    return count
    """

    # Compare stored revision with ARGV[1]; on match write ARGV[2] (which the
    # caller has already stamped with revision = expected + 1). Returns
    # {1, ""} on success or {0, <current raw json>} on conflict.
    _CAS_SCRIPT = """
    local current = redis.call('GET', KEYS[1])
    local current_rev = 0
    if current then
      local ok, decoded = pcall(cjson.decode, current)
      if ok and decoded and decoded['revision'] then
        current_rev = tonumber(decoded['revision']) or 0
      end
    end
    if current_rev ~= tonumber(ARGV[1]) then
      return {0, current or ''}
    end
    redis.call('SET', KEYS[1], ARGV[2])
    return {1, ''}
    """

    def __init__(self, redis_client=None, memory=None):
        # A caller (tests, dev runner) may inject a backend explicitly.
        if redis_client is not None:
            self._redis = redis_client
            self._memory = None
        elif memory is not None:
            self._redis = None
            self._memory = memory
            self._lock = threading.Lock()
        elif DIRECT_REDIS_URL or (REDIS_URL and REDIS_TOKEN):
            # Backend precedence: direct Redis URI first, Upstash REST as
            # fallback — including when a malformed direct URI fails
            # construction (generic error, the URL is never logged).
            self._redis = None
            self._memory = None
            if DIRECT_REDIS_URL:
                try:
                    adapter = load_biwa_module("biwa-redis")
                    self._redis = adapter.RedisAdapter(DIRECT_REDIS_URL)
                except Exception:
                    self._redis = None
            if self._redis is None and REDIS_URL and REDIS_TOKEN:
                from upstash_redis import Redis
                self._redis = Redis(url=REDIS_URL, token=REDIS_TOKEN)
        elif DEV_ALLOW_MEMORY and not os.getenv("VERCEL"):
            # The in-memory backend can never run on Vercel — the dev flag is
            # honoured for local processes only, keeping production
            # fail-closed even if the flag is set there by mistake.
            self._redis = None
            self._memory = BiwaStore._SHARED_MEMORY
            self._lock = BiwaStore._SHARED_LOCK
        else:
            self._redis = None
            self._memory = None

    @property
    def configured(self):
        return self._redis is not None or self._memory is not None

    def get_trip(self, key=TRIP_KEY):
        """Return (trip dict or None, raw json or None)."""
        raw = None
        if self._redis is not None:
            raw = self._redis.get(key)
        elif self._memory is not None:
            raw = self._memory.get(key)
        if not raw:
            return None, None
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        try:
            return json.loads(raw), raw
        except (ValueError, TypeError):
            return None, raw

    def cas_trip(self, expected_revision, payload_json, key=TRIP_KEY):
        """Atomically write payload_json iff stored revision == expected.

        Returns (ok, current_raw_json_or_none). A False result is a real 409:
        the caller must surface the latest state, never overwrite it.
        """
        if self._redis is not None:
            result = self._redis.eval(
                self._CAS_SCRIPT, [key], [str(expected_revision), payload_json]
            )
            ok = bool(result[0])
            current = result[1] if len(result) > 1 and result[1] else None
            if isinstance(current, bytes):
                current = current.decode("utf-8")
            return ok, current
        if self._memory is not None:
            with self._lock:
                current = self._memory.get(key)
                current_rev = 0
                if current:
                    try:
                        current_rev = int(json.loads(current).get("revision") or 0)
                    except (ValueError, TypeError, AttributeError):
                        current_rev = 0
                if current_rev != expected_revision:
                    return False, current
                self._memory[key] = payload_json
                return True, None
        raise RuntimeError("Biwa store is not configured")

    def check_rate_limit(self, scope, limit, window_s=RATE_WINDOW_S):
        """Fixed-window counter. Returns True when the call is allowed."""
        key = RATE_PREFIX + scope
        if self._redis is not None:
            count = self._redis.eval(self._RATE_SCRIPT, [key], [str(window_s)])
            if isinstance(count, (list, tuple)):
                count = count[0]
            return int(count) <= limit
        if self._memory is not None:
            with self._lock:
                entry = self._memory.get(key)
                now = time.time()
                if not entry or entry["reset"] <= now:
                    entry = {"count": 0, "reset": now + window_s}
                entry["count"] += 1
                self._memory[key] = entry
                return entry["count"] <= limit
        # Fail closed: no backend, no allowance.
        return False

    def get_cached_json(self, key):
        """Read a small JSON cache payload.

        Returns None when the key is absent, expired or unreadable — cache
        misses must never raise. Memory entries store an expiry beside the
        payload so TTLs behave like Redis EX.
        """
        raw = None
        try:
            if self._redis is not None:
                raw = self._redis.get(key)
            elif self._memory is not None:
                with self._lock:
                    entry = self._memory.get(key)
                    if isinstance(entry, dict) and "expires" in entry:
                        if (entry["expires"] is not None
                                and entry["expires"] <= time.time()):
                            del self._memory[key]
                            return None
                        raw = entry["value"]
                    else:
                        raw = entry
        except Exception:
            return None
        if not raw:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return None

    def set_cached_json(self, key, value, ex=None):
        """Write a small JSON cache payload with optional TTL seconds.

        Fails open: a backend hiccup must not break the live request the
        cache was meant to accelerate. Never used for the trip state itself
        (TRIP_KEY keeps its durable no-TTL CAS write).
        """
        try:
            raw = json.dumps(value)
            if self._redis is not None:
                self._redis.set(key, raw, ex=ex)
            elif self._memory is not None:
                with self._lock:
                    self._memory[key] = {
                        "value": raw,
                        "expires": (time.time() + ex) if ex else None,
                    }
        except Exception:
            pass


def client_scope(request):
    """Rate-limit bucket key for a public endpoint: the client IP.

    Hashed so the raw address never lands in a Redis key name (or a log line
    that might echo keys).
    """
    host = request.client.host if request.client else "unknown"
    return "ip:" + hashlib.sha256(host.encode()).hexdigest()[:16]


def owner_from_request(request):
    """Read the X-Biwa-Owner identity header, or None when absent/malformed.

    Every personal trip lives behind an owner id; today the only issuer is
    the client itself ('dev:<uuid>' minted once into localStorage), so the
    header is trusted as-is — the same trust level the public shared doc
    had. A future auth layer simply swaps the scheme ('google:<sub>') and
    verifies the token before this point; the key layout already fits.
    """
    owner = (request.headers.get("x-biwa-owner") or "").strip()
    return owner if OWNER_ID_RE.match(owner) else None


def owner_trip_key(owner_id):
    """Redis key for one owner's personal trip doc — durable, no TTL."""
    return OWNER_KEY_PREFIX + owner_id + ":trip"


def create_pair_code(store, owner_id):
    """Mint a short-lived code another device can claim this owner with.

    Stored through the small-JSON cache so both backends get the same
    expiry semantics; the code stays claimable until the TTL lapses so
    several of the group's devices can pair off one display.
    """
    code = "".join(
        secrets.choice(PAIR_CODE_ALPHABET) for _ in range(PAIR_CODE_LENGTH)
    )
    store.set_cached_json(PAIR_KEY_PREFIX + code, {"owner": owner_id},
                          ex=PAIR_CODE_TTL_S)
    return code


def resolve_pair_code(store, code):
    """Resolve a pairing code to its owner id, or None when unknown/expired."""
    data = store.get_cached_json(PAIR_KEY_PREFIX + code)
    if isinstance(data, dict):
        owner = data.get("owner")
        if isinstance(owner, str) and OWNER_ID_RE.match(owner):
            return owner
    return None


# Origins allowed to mutate/call providers through a browser. Anything not on
# this list may read the public trip but cannot write or spend API calls.
MUTATION_ORIGINS = {
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://terrancehah.com",
    "https://www.terrancehah.com",
}


def origin_allowed(request):
    """Cross-origin write guard for the public API.

    The trip is publicly readable, but mutations and provider calls must come
    from our own pages. Requests carrying an Origin header from anywhere else
    are rejected; requests with no Origin at all (curl, server-to-server)
    pass — abuse from them is still bounded by the rate limits.
    """
    origin = request.headers.get("origin")
    if not origin:
        return True
    host = urllib.parse.urlsplit(origin).netloc.lower()
    if host == request.headers.get("host", "").lower():
        return True
    if origin in MUTATION_ORIGINS:
        return True
    # Vercel preview deployments serve the app from *.vercel.app.
    return host.endswith(".vercel.app")


# Trip state is private to invite holders: intermediaries and browsers must
# not store or share it. Applied to every state/mutation response.
PRIVATE_CACHE_HEADERS = {"Cache-Control": "private, no-store"}


def json_error(status, code, message):
    return JSONResponse(status_code=status, headers=PRIVATE_CACHE_HEADERS,
                        content={"ok": False, "error": code, "message": message})


def json_ok(content, status=200):
    return JSONResponse(status_code=status, headers=PRIVATE_CACHE_HEADERS,
                        content=content)


class _BiwaStripPrefixMiddleware:
    """Mirror of _shared._StripPrefixMiddleware, kept independent so the Biwa
    endpoints never import Pacey's module (which pulls Garmin/OpenAI).

    Vercel file-based functions receive the full original path; strip any
    prefix ending with /<function_name> down to "/" so routes match whether
    the request came via /api/<name> or a rewritten /projects/.../api/<name>.
    """

    def __init__(self, app, function_name):
        self.app = app
        self.suffix = f"/{function_name}"

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            path = scope.get("path", "")
            if path.endswith(self.suffix):
                scope["path"] = "/"
                scope["raw_path"] = b"/"
        await self.app(scope, receive, send)


def create_biwa_app(function_name):
    """FastAPI app configured like Pacey's create_app but self-contained."""
    app = FastAPI()
    app.add_middleware(_BiwaStripPrefixMiddleware, function_name=function_name)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "https://*.vercel.app",
            "https://terrancehah.com",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(Exception)
    async def _unhandled_exception(request, exc):
        # Log the traceback server-side but answer with JSON the client can
        # parse — never Vercel's opaque non-JSON 500 page.
        # NOTE: exception text and tracebacks can embed backend details
        # (e.g. a Redis connection URL carrying its token), so only the
        # exception class name is logged — enough to triage, nothing secret.
        print(f"biwa endpoint unhandled exception: {type(exc).__name__}")
        return json_error(500, "internal", "Unexpected server error")

    return app


def guard_mutation(request, store):
    """Precondition check for writes and provider calls on the public API.

    Returns a JSONResponse describing the failure, or None when the request
    may proceed. Cross-origin mutations are rejected first, then missing
    backend config (rate limiting and CAS both need it — in production that
    means fail closed; locally BIWA_DEV_ALLOW_MEMORY=1 opts in).
    """
    if not origin_allowed(request):
        return json_error(403, "forbidden_origin",
                        "Cross-origin mutations are not allowed.")
    if not store.configured:
        return json_error(503, "not_configured",
                        "Trip sharing is not configured on this deployment.")
    return None


def check_dual_rate_limit(request, store, scope_name, limit):
    """Global AND per-IP fixed-window check for billable provider calls."""
    if not store.check_rate_limit(scope_name, limit):
        return False
    return store.check_rate_limit(scope_name + ":" + client_scope(request), limit)
