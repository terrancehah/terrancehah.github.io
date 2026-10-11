"""Direct Redis (TCP) adapter for the dedicated Biwa database.

Preferred transport when BIWA_REDIS_URL is configured: the same get/set/eval
semantics as the Upstash REST client, so the frozen CAS and rate-limit Lua
scripts run unchanged. The redis-py client connects lazily on first use —
constructing this adapter performs no network I/O. Every public command is
wrapped in a generic RuntimeError so a driver exception (which can embed the
credential-bearing URL in its message or a dev-server traceback) never leaks
into logs.
"""

import urllib.parse

# Only plain and TLS Redis schemes are accepted — anything else is a
# configuration error, never passed to the client library.
_ALLOWED_SCHEMES = ("redis", "rediss")


class RedisAdapter:
    """Minimal command surface matching how the store uses a Redis client.

    Methods mirror the Upstash signatures the store already calls
    (get / set with ex / eval with separate key and arg lists) so backends
    are interchangeable.
    """

    def __init__(self, url):
        # Fail fast on a malformed scheme — a generic error that never
        # echoes the URL (which embeds credentials).
        if not isinstance(url, str):
            raise RuntimeError("Redis configuration is invalid")
        try:
            scheme = urllib.parse.urlsplit(url).scheme.lower()
        except ValueError:
            scheme = ""
        if scheme not in _ALLOWED_SCHEMES:
            raise RuntimeError("Redis configuration is invalid")
        self._url = url
        self._client = None

    def _connect(self):
        # The import and client build are both lazy: the package may not be
        # installed until requirements are applied, and from_url performs no
        # network I/O — the first command opens the socket.
        if self._client is None:
            import redis
            self._client = redis.Redis.from_url(
                self._url,
                decode_responses=True,
                socket_connect_timeout=5,
                socket_timeout=5,
            )
        return self._client

    def get(self, key):
        try:
            return self._connect().get(key)
        except Exception:
            raise RuntimeError("Biwa Redis request failed") from None

    def set(self, key, value, ex=None):
        try:
            return self._connect().set(key, value, ex=ex)
        except Exception:
            raise RuntimeError("Biwa Redis request failed") from None

    def eval(self, script, keys, args):
        # redis-py takes numkeys positionally — the Lua scripts only see
        # KEYS/ARGV, identical to the Upstash path.
        try:
            return self._connect().eval(script, len(keys), *keys, *args)
        except Exception:
            raise RuntimeError("Biwa Redis request failed") from None
