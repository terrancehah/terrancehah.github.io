#!/usr/bin/env python3
"""Generate optimized responsive derivatives for the personal site's
local raster images and rewrite the referencing markup to use them.

  --write   generate webp variants under resources/optimized/, write
            resources/optimized/manifest.json, and update <img> markup
            (src/srcset/sizes/width/height/data-full-src where a
            gallery viewer exists)
  --check   validate only: source files unchanged vs manifest, outputs
            exist with recorded bytes/dimensions, markup references
            resolve — nothing is regenerated

Originals are never modified. Sources stay byte-identical and keep
their paths (og:image, gallery data-full-src, etc. keep pointing at
them). Idempotent: a --write run skips sources whose sha256 and recipe
already produced the recorded outputs.

Context-specific `sizes` values follow the settled layout rules from
the review handoff.
"""

import argparse
import hashlib
import io
import json
import os
import re
import sys
from html.parser import HTMLParser

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(REPO)

OUT_ROOT = "resources/optimized"
MANIFEST = os.path.join(OUT_ROOT, "manifest.json")
SKIP_DIRS = {"node_modules", ".archive", ".vercel", ".git", "pacey",
             "biwa-ride", ".venv", "venv", "dist"}
LADDER = (640, 1280, 1920)          # longest-edge targets
MIN_BYTES = 250 * 1024              # candidates: >=250KB or edge>1920
MAX_EDGE = 1920
RASTER = (".jpg", ".jpeg", ".png", ".webp")
ICON_CLASSES = ("site-social-icon", "handwriting-crossout")

# sizes attribute by markup context
SIZES_HERO = "(max-width: 1536px) 100vw, 1536px"
SIZES_CARD = ("(max-width: 639px) calc(100vw - 3rem), "
              "(max-width: 1023px) calc(100vw - 4rem), 720px")
SIZES_PHOTO_ITEM = "(max-width: 767px) calc(100vw - 2rem), 560px"
SIZES_ARTICLE_HERO = "(max-width: 767px) calc(100vw - 4rem), 1200px"
SIZES_ARTICLE_PHOTO = ("(max-width: 767px) calc(100vw - 4rem), "
                       "(max-width: 1023px) 80vw, 720px")
SIZES_PROJECT_PHOTO = "(max-width: 767px) calc(100vw - 2rem), 960px"

HERO_ANCESTORS = ("article-hero-image", "project-hero-image",
                  "toy-hero-image", "hero-image")
CARD_ANCESTORS = ("article-card-image", "project-card-image",
                  "toy-card-image")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def slug(stem):
    s = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")
    return s or "image"


def resolve_local(page, src):
    if "://" in src or src.startswith(("//", "data:")):
        return None
    cand = src.lstrip("/") if src.startswith("/") else \
        os.path.normpath(os.path.join(os.path.dirname(page), src))
    while cand.startswith("../") or cand == "..":
        cand = cand[3:] if cand != ".." else ""
    return cand if os.path.isfile(cand) else None


def rel_href(page, repo_path):
    """Generated assets always get a root-absolute href — every page is
    served from the site root, so /resources/optimized/... resolves
    identically everywhere."""
    return "/" + repo_path


VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input",
             "link", "meta", "param", "source", "track", "wbr"}


class ImgScan(HTMLParser):
    """Collect <img> tags with position, attrs, and ancestor classes.

    Stack entries are (tag, classes). Void elements never open a scope
    and self-closing tags open+close atomically, so a stray close tag
    can only pop an ancestor that was actually opened — context for a
    later sibling can never inherit classes from an unrelated branch."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.imgs = []
        self.stack = []

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        classes = set(d.get("class", "").split())
        if tag == "img":
            anc = set()
            for _, cset in self.stack:
                anc |= cset
            self.imgs.append((self.getpos(), d, anc))
        if tag not in VOID_TAGS:
            self.stack.append((tag, classes))

    def handle_startendtag(self, tag, attrs):
        # self-closing tag: record if it's an img, never open a scope
        d = dict(attrs)
        if tag == "img":
            anc = set()
            for _, cset in self.stack:
                anc |= cset
            self.imgs.append((self.getpos(), d, anc))

    def handle_endtag(self, tag):
        # pop only if this tag is actually open; ignore stray closes
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                return


def tag_end(text, start):
    q = None
    i = start
    while i < len(text):
        c = text[i]
        if q:
            if c == q:
                q = None
        elif c in "\"'":
            q = c
        elif c == ">":
            return i
        i += 1
    return -1


def context_sizes(page, attrs, ancestors):
    own = set(attrs.get("class", "").split())
    if own & {"hero-image"} or ancestors & set(HERO_ANCESTORS):
        if page in ROOT_PAGES:
            return SIZES_HERO
        return SIZES_ARTICLE_HERO
    if ancestors & {"photo-item"}:
        return SIZES_PHOTO_ITEM
    if ancestors & set(CARD_ANCESTORS):
        return SIZES_CARD
    if page.startswith("./articles/"):
        return SIZES_ARTICLE_PHOTO
    if page.startswith("./projects/"):
        return SIZES_PROJECT_PHOTO
    if page in ROOT_PAGES:
        return SIZES_CARD
    return SIZES_ARTICLE_PHOTO


ROOT_PAGES = {"./index.html", "./articles.html", "./projects.html",
              "./playground.html"}


def consumers():
    for root, dirs, files in os.walk("."):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if f.endswith(".html"):
                p = os.path.join(root, f)
                if "footer.js" in open(p, errors="ignore").read():
                    yield p


def out_dir_for(source_rel):
    # mirror the source tree minus its leading resources/ — avoids the
    # redundant resources/optimized/resources/... nesting
    rel = os.path.dirname(source_rel)
    if rel.startswith("resources/"):
        rel = rel[len("resources/"):]
    return os.path.join(OUT_ROOT, rel)


def variant_name(source_rel, edge):
    """Name by the longest-edge target — 'park-gate-jpeg-1920.webp' is
    the 1920-edge variant regardless of orientation."""
    stem = os.path.splitext(os.path.basename(source_rel))[0]
    ext = os.path.splitext(source_rel)[1].lstrip(".").lower()
    return f"{slug(stem)}-{ext}-{edge}.webp"


def load_image(source):
    """Open a candidate. Returns (image, source_format) or (None, reason).

    Multi-frame files are rejected — EXCEPT iPhone MPO JPEGs, which are
    multi-picture stills (primary frame + depth/preview frames), not
    animation: those decode frame 0 like any JPEG."""
    from PIL import Image, ImageCms, ImageOps
    im = Image.open(source)
    fmt = im.format
    frames = getattr(im, "n_frames", 1)
    if frames > 1:
        if fmt in ("MPO", "JPEG"):
            im.seek(0)                      # primary still frame
        else:
            return None, "animated"
    im = ImageOps.exif_transpose(im)      # bake orientation, drop EXIF
    # palette PNGs carrying transparency must not lose alpha when the
    # mode is normalised for webp
    if im.mode == "P" and "transparency" in im.info:
        im = im.convert("RGBA")
    # ICC -> sRGB when a valid profile exists; otherwise keep as-is
    icc = im.info.get("icc_profile")
    if icc:
        try:
            im = ImageCms.profileToProfile(
                im, io.BytesIO(icc), ImageCms.createProfile("sRGB"),
                outputMode="RGBA" if "A" in im.getbands() else "RGB")
            im.info["icc_profile"] = ImageCms.ImageCmsProfile(
                ImageCms.createProfile("sRGB")).tobytes()
        except Exception:
            pass                            # keep original profile
    elif "A" not in im.getbands() and im.mode != "RGB":
        im = im.convert("RGB")
    return im, fmt


def encode_webp(im, width, is_png_source):
    """Return (bytes, (w, h)) for a longest-edge `width` variant."""
    from PIL import Image
    w, h = im.size
    if width < max(w, h):
        if w >= h:
            nh = round(h * width / w)
            im = im.resize((width, nh), Image.LANCZOS)
        else:
            nw = round(w * width / h)
            im = im.resize((nw, width), Image.LANCZOS)
    buf = io.BytesIO()
    save_kw = {"quality": 90 if is_png_source else 82, "method": 6}
    # Pillow only embeds the profile when it is passed explicitly —
    # without this the sRGB/converted (or fallback original) profile is
    # silently dropped from the webp
    if im.info.get("icc_profile"):
        save_kw["icc_profile"] = im.info["icc_profile"]
    im.save(buf, "WEBP", **save_kw)
    return buf.getvalue(), im.size


def collect_candidates(manifest):
    """All local-raster main imgs across the consumers, with context."""
    entries = []
    for page in sorted(consumers()):
        s = open(page, errors="ignore").read()
        scan = ImgScan()
        scan.feed(s)
        lines = s.split("\n")
        loff = [0]
        for l in lines:
            loff.append(loff[-1] + len(l) + 1)
        for (ln, col), attrs, anc in scan.imgs:
            src = attrs.get("src", "")
            # already-optimized srcs map back to their source via the
            # manifest — never re-optimize generated files
            gen = src.lstrip("/")
            generated = gen.startswith(OUT_ROOT + "/")
            if generated:
                local = manifest.get("by_variant", {}).get(gen)
                if local is None:
                    continue
            else:
                local = resolve_local(page, src)
            if local is None:
                continue
            cls = set(attrs.get("class", "").split())
            if cls & set(ICON_CLASSES) or attrs.get("aria-hidden") == "true" \
                    or "h-8" in cls:
                continue
            entries.append({
                "page": page, "line": ln, "col": col,
                "src": src, "local": local, "attrs": attrs,
                "ancestors": anc,
                # a srcset WE generated is not an authored one
                "has_srcset": "srcset" in attrs and not generated,
                "gallery": "cursor-pointer" in cls,
            })
    return entries


RECIPE_VERSION = 2  # v2: MPO-as-still, ICC embed, edge-named paths


def is_candidate(local, has_srcset):
    if local.startswith(OUT_ROOT + "/"):
        return False, "generated file — never a source"
    if not local.lower().endswith(RASTER):
        return False, "not raster"
    if has_srcset:
        return False, "authored srcset left untouched"
    size = os.path.getsize(local)
    from PIL import Image
    with Image.open(local) as im:
        frames = getattr(im, "n_frames", 1)
        # MPO = multi-picture JPEG (iPhone stills) — frame 0 is a normal
        # photo, not an animation; only true animated formats are out
        if frames > 1 and im.format not in ("MPO", "JPEG"):
            return False, "animated"
        edge = max(im.size)
    if size < MIN_BYTES and edge <= MAX_EDGE:
        return False, "small"
    return True, ""


def process_source(local, manifest, name_registry):
    """Generate variants for one source. Returns manifest entry."""
    orig_bytes = os.path.getsize(local)
    digest = sha256(local)
    old = manifest["sources"].get(local)
    if old and old["sha256"] == digest \
            and old.get("recipe", {}).get("version") == RECIPE_VERSION \
            and all(os.path.isfile(os.path.join(REPO, v["path"]))
                    for v in old.get("variants", [])):
        for v in old["variants"]:
            prev = name_registry.setdefault(v["path"], local)
            if prev != local:
                raise RuntimeError(
                    f"output name collision: {v['path']} "
                    f"for {local} vs {prev}")
        return old, "unchanged"
    im, fmt = load_image(local)
    if im is None:
        return None, "animated"
    w, h = im.size
    edge = max(w, h)
    targets = sorted({t for t in LADDER if t <= edge} | {min(edge, max(LADDER))})
    is_png = local.lower().endswith(".png")
    odir = out_dir_for(local)

    # encode everything into memory first — the candidate is abandoned
    # entirely if its largest variant fails to beat the original
    encoded = []
    skipped = []
    for t in targets:
        data, (vw, vh) = encode_webp(im, t, is_png)
        if len(data) >= orig_bytes:
            skipped.append({"edge": t, "reason": "not smaller"})
            continue
        encoded.append({"edge": t, "data": data, "width": vw,
                        "height": vh})
    if not encoded or encoded[-1]["edge"] != targets[-1]:
        return None, "largest variant not smaller than original"

    variants = []
    for enc in encoded:
        rel = os.path.join(odir, variant_name(local, enc["edge"]))
        prev = name_registry.setdefault(rel, local)
        if prev != local:
            raise RuntimeError(
                f"output name collision: {rel} for {local} vs {prev}")
        absout = os.path.join(REPO, rel)
        if not (os.path.isfile(absout) and old
                and digest == old["sha256"]
                and old.get("recipe", {}).get("version") == RECIPE_VERSION
                and any(v["path"] == rel for v in old["variants"])):
            os.makedirs(os.path.dirname(absout), exist_ok=True)
            with open(absout, "wb") as f:
                f.write(enc["data"])
        variants.append({"path": rel, "bytes": len(enc["data"]),
                         "width": enc["width"], "height": enc["height"],
                         "edge": enc["edge"]})
    entry = {"sha256": digest, "bytes": orig_bytes,
             "orig_width": w, "orig_height": h,
             "recipe": {"version": RECIPE_VERSION, "format": "webp",
                        "quality": 90 if is_png else 82, "method": 6,
                        "ladder": list(LADDER), "source_format": fmt,
                        "frame": 0 if fmt in ("MPO", "JPEG") else None},
             "variants": variants,
             "skipped_variants": skipped}
    return entry, "optimized"


def _set_attr(tag, name, value):
    """Replace an existing `name="..."` attribute or append it before the
    tag's tail (keeping a self-closing '/>' last). Operates on whitespace
    boundaries so 'data-width' etc. cannot false-match."""
    pattern = re.compile(r'\s' + re.escape(name) + r'="[^"]*"')
    if pattern.search(tag):
        return pattern.sub(f' {name}="{value}"', tag, count=1)
    selfclosing = tag.rstrip()[:-1].rstrip().endswith("/")
    core = tag[:-1]
    if selfclosing:
        core = core.rstrip()[:-1]  # strip the '/' too
    return core + f' {name}="{value}"' + ("/>" if selfclosing else ">")


def _insert_attrs(tag, add):
    """Append a pre-built attribute string before the tag tail."""
    selfclosing = tag.rstrip()[:-1].rstrip().endswith("/")
    core = tag[:-1]
    if selfclosing:
        core = core.rstrip()[:-1]
    return core + add + ("/>" if selfclosing else ">")


def update_img_tag(tag, attrs, entry, page):
    """Rewrite one <img> tag for an optimized source: point src at the
    largest variant, (re)build srcset/sizes from the manifest entry, set
    width/height to the fallback's real dims, and keep the original URL
    in data-full-src on gallery imgs. Pure string transform — unit-testable."""
    variants = sorted(entry["variants"], key=lambda v: v["width"])
    biggest = variants[-1]
    srcset = ", ".join(f"{rel_href(page, v['path'])} {v['width']}w"
                       for v in variants)
    sizes = context_sizes(page, attrs, attrs.get("_ancestors", set()))
    tag = re.sub(r'\ssrc="[^"]*"',
                 f' src="/{biggest["path"]}"', tag, count=1)
    tag = _set_attr(tag, "width", biggest["width"])
    tag = _set_attr(tag, "height", biggest["height"])
    # idempotent: replace srcset/sizes/data-full-src if present
    # data-full-src keeps the ORIGINAL URL for the lightbox —
    # on re-runs the current data-full-src already holds it
    orig_url = attrs.get("data-full-src") or attrs.get("src", "")
    new_full = (f' data-full-src="{orig_url}"'
                if attrs.get("class")
                and "cursor-pointer" in attrs["class"] else "")
    add = f' srcset="{srcset}" sizes="{sizes}"' + new_full
    if "srcset=" in tag:
        tag = re.sub(r'\ssrcset="[^"]*"', "", tag, count=1)
        tag = re.sub(r'\ssizes="[^"]*"', "", tag, count=1)
        tag = re.sub(r'\sdata-full-src="[^"]*"', "", tag, count=1)
    return _insert_attrs(tag, add)


def rewrite_markup(edits_by_page, manifest):
    """Position-splice src/srcset/sizes/dims into each page."""
    for page, edits in edits_by_page.items():
        s = open(page, errors="ignore").read()
        lines = s.split("\n")
        loff = [0]
        for l in lines:
            loff.append(loff[-1] + len(l) + 1)
        for (ln, col, attrs, local, entry, anc) in reversed(edits):
            start = loff[ln - 1] + col
            end = tag_end(s, start)
            tag = s[start:end + 1]
            attrs = dict(attrs)
            attrs["_ancestors"] = anc       # context for sizes lookup
            tag = update_img_tag(tag, attrs, entry, page)
            s = s[:start] + tag + s[end + 1:]
        open(page, "w").write(s)


def cmd_write():
    manifest = {"sources": {}, "by_variant": {}}
    if os.path.isfile(MANIFEST):
        manifest = json.load(open(MANIFEST))
    # the tool NEVER deletes files — outputs it no longer produces are
    # left on disk for manual cleanup; optimization must be
    # non-destructive always
    name_registry = {}      # output path -> source, collision detector
    edits_by_page = {}
    report = []
    for e in collect_candidates(manifest):
        ok, reason = is_candidate(e["local"], e["has_srcset"])
        if not ok:
            report.append((e["page"], e["line"], e["src"][:50],
                           "skip: " + reason))
            continue
        entry, status = process_source(e["local"], manifest,
                                       name_registry)
        if entry is None:
            report.append((e["page"], e["line"], e["src"][:50],
                           "skip: " + status))
            continue
        manifest["sources"][e["local"]] = entry
        for v in entry["variants"]:
            manifest["by_variant"][v["path"]] = e["local"]
        edits_by_page.setdefault(e["page"], []).append(
            (e["line"], e["col"], e["attrs"], e["local"], entry,
             e["ancestors"]))
        report.append((e["page"], e["line"], e["src"][:50], status))
    rewrite_markup(edits_by_page, manifest)
    os.makedirs(OUT_ROOT, exist_ok=True)
    # drop manifest entries whose source vanished
    manifest["sources"] = {k: v for k, v in manifest["sources"].items()
                           if os.path.isfile(k)}
    manifest["by_variant"] = {
        v["path"]: src for src, e in manifest["sources"].items()
        for v in e["variants"]}
    with open(MANIFEST, "w") as f:
        json.dump(manifest, f, indent=1, sort_keys=True)
    total_orig = sum(e["bytes"] for e in manifest["sources"].values())
    total_new = sum(v["bytes"] for e in manifest["sources"].values()
                    for v in e["variants"])
    print(f"{len(manifest['sources'])} sources optimized "
          f"({total_orig} -> {total_new} bytes across variants)")
    for r in report:
        print("  ", r)


def cmd_check():
    if not os.path.isfile(MANIFEST):
        print("no manifest — run --write first")
        return 1
    manifest = json.load(open(MANIFEST))
    fails = []
    for src, e in manifest["sources"].items():
        if not os.path.isfile(src):
            fails.append(f"missing source {src}")
            continue
        if sha256(src) != e["sha256"] or os.path.getsize(src) != e["bytes"]:
            fails.append(f"source changed since optimize: {src}")
        for v in e["variants"]:
            if not os.path.isfile(v["path"]):
                fails.append(f"missing variant {v['path']}")
                continue
            if os.path.getsize(v["path"]) != v["bytes"]:
                fails.append(f"variant bytes drifted: {v['path']}")
    # markup references resolve
    for page in consumers():
        s = open(page, errors="ignore").read()
        scan = ImgScan()
        scan.feed(s)
        for (ln, col), attrs, anc in scan.imgs:
            for key in ("src",):
                src = attrs.get(key, "")
                loc = resolve_local(page, src)
                if loc is None and not src.startswith(("http", "//",
                                                       "data:")):
                    fails.append(f"{page} L{ln}: unresolvable src {src}")
            for part in (attrs.get("srcset") or "").split(","):
                part = part.strip()
                if not part:
                    continue
                url, _, wd = part.rpartition(" ")
                loc = resolve_local(page, url)
                if loc is None:
                    fails.append(f"{page} L{ln}: srcset missing {url}")
                    continue
                try:
                    from PIL import Image
                    with Image.open(loc) as im:
                        if wd.endswith("w") and int(wd[:-1]) != im.size[0]:
                            fails.append(
                                f"{page} L{ln}: srcset {url} says {wd} "
                                f"but file is {im.size[0]}w")
                except Exception as ex:
                    fails.append(f"{page} L{ln}: cannot decode {url}")
    if fails:
        print(f"{len(fails)} FAILURES:")
        for f in fails:
            print("  -", f)
        return 1
    print(f"manifest OK: {len(manifest['sources'])} sources, all "
          "references resolve")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    if args.check:
        sys.exit(cmd_check())
    if args.write:
        cmd_write()
        return
    ap.print_help()
    sys.exit(2)


if __name__ == "__main__":
    main()
