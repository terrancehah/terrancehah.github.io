"""Pairing-code lifecycle for the personal trip docs — handler module.

Two operations share the one handler:

  {"op": "create"} + X-Biwa-Owner → mint a 6-character code (10-minute TTL)
      that resolves to the caller's owner id. The source device displays
      it; the code may be claimed by several devices until it expires.
  {"op": "claim", "code": "ABC234"} → resolve a code to its owner id so the
      claiming device can adopt the same trip. Claims are rate-limited hard
      (the code space is only ~1 billion) and origin-guarded like all
      mutations; a claim changes no server state — the code survives until
      its own TTL so one code can pair a whole group.

This is NOT a Vercel function: it lives under lib/ so function discovery
never builds it (the Hobby plan caps functions at 12 — api/biwa-pair.py was
the 13th). api/biwa-trip.py mounts `pair` at /api/biwa-trip/pair and
vercel.json rewrites the public POST /api/biwa-pair URL (and its
/projects/biwa-ride/api alias) onto it, so the client URL is unchanged.
"""

import importlib.util
import json
import os
import sys

from fastapi import Request

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(module_key, path):
    """Same sys.modules-keyed loader the api/ modules use — biwa-store must
    resolve to the one shared module instance so the caller's store and the
    guard helpers agree."""
    if module_key in sys.modules:
        return sys.modules[module_key]
    spec = importlib.util.spec_from_file_location(module_key, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_key] = module
    spec.loader.exec_module(module)
    return module


biwa_store = _load("biwa_store", os.path.join(_HERE, "biwa-store.py"))

# Claims get a much tighter window than ordinary writes: six characters is
# a small enough space that brute-force has to stay expensive.
PAIR_CLAIM_RATE_LIMIT = 10
PAIR_CREATE_RATE_LIMIT = 20


async def pair(request: Request, store):
    """Pairing-code lifecycle: 'create' mints, 'claim' resolves.

    `store` is passed in by the mounting app (api/biwa-trip.py or the dev
    runner) so pairing codes live in the same backend as trips — including
    the shared in-memory backend used by tests and BIWA_DEV_ALLOW_MEMORY.
    """
    blocked = biwa_store.guard_mutation(request, store)
    if blocked:
        return blocked

    raw_body = await request.body()
    if len(raw_body) > 1024:
        return biwa_store.json_error(413, "too_large", "Pairing payload is too large.")
    try:
        body = json.loads(raw_body)
    except ValueError:
        return biwa_store.json_error(400, "bad_json", "Request body is not valid JSON.")
    if not isinstance(body, dict) or not isinstance(body.get("op"), str):
        return biwa_store.json_error(400, "bad_request", "Body must contain an op string.")

    scope = biwa_store.client_scope(request)
    op = body["op"]

    if op == "create":
        owner = biwa_store.owner_from_request(request)
        if not owner:
            return biwa_store.json_error(401, "owner_required",
                                         "Send X-Biwa-Owner to create a pairing code.")
        if not store.check_rate_limit("pair-create:" + scope, PAIR_CREATE_RATE_LIMIT):
            return biwa_store.json_error(429, "rate_limited", "Too many pairing codes — wait a minute.")
        code = biwa_store.create_pair_code(store, owner)
        return biwa_store.json_ok({"ok": True, "code": code,
                                   "expiresIn": biwa_store.PAIR_CODE_TTL_S})

    if op == "claim":
        if not store.check_rate_limit("pair-claim:" + scope, PAIR_CLAIM_RATE_LIMIT):
            return biwa_store.json_error(429, "rate_limited", "Too many attempts — wait a minute.")
        code = str(body.get("code") or "").strip().upper()
        if len(code) != biwa_store.PAIR_CODE_LENGTH or any(
                c not in biwa_store.PAIR_CODE_ALPHABET for c in code):
            return biwa_store.json_error(400, "bad_code",
                                         "Pairing codes are 6 letters/digits.")
        owner = biwa_store.resolve_pair_code(store, code)
        if not owner:
            # 404 deliberately conflates 'never existed' and 'expired' — the
            # claimant only needs to know the code is no good.
            return biwa_store.json_error(404, "code_expired",
                                         "That pairing code has expired — ask for a fresh one.")
        return biwa_store.json_ok({"ok": True, "ownerId": owner})

    return biwa_store.json_error(400, "bad_request", "Unknown pairing operation.")
