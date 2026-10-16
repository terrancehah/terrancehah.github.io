"""Local development entry point — `uvicorn api.index:app`.

Each api/*.py file is an independent Vercel serverless function exposing a
FastAPI app whose routes sit at "/" (the per-function middleware strips the
"/<name>" suffix from whatever path Vercel forwarded). For local development
this module mounts every function app under the same prefixes that
proxy-server.js rewrites onto port 8000, so one process serves them all:

    /pacey/api/<fn>                          -> /race-goal/<fn>
    /projects/biwa-ride/api/<fn>             -> /api/<fn>
    /projects/running-posture-analyser/analyse -> /analyse
    /api/<fn>                                -> /api/<fn>  (direct convention)

A function that fails to import is skipped with a warning, so one broken
endpoint does not take down the whole local backend.
"""

import importlib.util
import sys
from pathlib import Path

from fastapi import FastAPI

app = FastAPI(title="terrancehah-local-api")

API_DIR = Path(__file__).resolve().parent

for path in sorted(API_DIR.glob("*.py")):
    name = path.stem
    if name == "index":
        continue

    # Kebab-case filenames cannot be imported by dotted name — load by path.
    spec = importlib.util.spec_from_file_location(
        f"api_fn_{name.replace('-', '_')}", path
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        print(f"[api.index] skipped {name}: {exc}")
        continue

    app.mount(f"/api/{name}", module.app)
    # The dev proxy rewrites Pacey's /pacey/api/* calls onto this prefix.
    app.mount(f"/race-goal/{name}", module.app)
    # The running-posture analyser posts to a bare /analyse route.
    if name == "analyse":
        app.mount("/analyse", module.app)
