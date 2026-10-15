"""POST /api/biwa-pair — device pairing for the personal trip docs.

Two operations share the one endpoint:

  {"op": "create"} + X-Biwa-Owner → mint a 6-character code (10-minute TTL)
      that resolves to the caller's owner id. The source device displays
      it; the code may be claimed by several devices until it expires.
  {"op": "claim", "code": "ABC234"} → resolve a code to its owner id so the
      claiming device can adopt the same trip. Claims are rate-limited hard
      (the code space is only ~1 billion) and origin-guarded like all
      mutations; a claim changes no server state — the code survives until
      its own TTL so one code can pair a whole group.
"""

import importlib.util
import json
import os
import sys

from fastapi import Request

# Add api/ to sys.path, then load the kebab-case helpers by file path (module
# names follow the repo convention so `import` syntax cannot reach them).
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(_HERE)


def _load(module_key, path):
    if module_key in sys.modules:
        return sys.modules[module_key]
    spec = importlib.util.spec_from_file_location(module_key, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_key] = module
    spec.loader.exec_module(module)
    return module


biwa_store = _load("biwa_store", os.path.join(os.path.dirname(_HERE), "lib", "biwa", "biwa-store.py"))

app = biwa_store.create_biwa_app("biwa-pair")
store = biwa_store.BiwaStore()

# Claims get a much tighter window than ordinary writes: six characters is
# a small enough space that brute-force has to stay expensive.
PAIR_CLAIM_RATE_LIMIT = 10
PAIR_CREATE_RATE_LIMIT = 20


@app.post("/")
async def pair(request: Request):
    """Pairing-code lifecycle: 'create' mints, 'claim' resolves."""
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
