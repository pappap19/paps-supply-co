#!/usr/bin/env python3
"""Regenerate the Pap's Supply Co. storefront from Printify.

Source of truth = Printify (shop 29269079). This script pulls every product
through the Printify connector CLI and rewrites, in /home/hatch/workspace/paps-site:
  - data/products.js   (the catalog the site renders)
  - data/config.js     (hero/about text, from site-config.json)
  - index.html         (from index.template.html: prerendered cards, SEO head,
                        ItemList JSON-LD, page title/meta from site-config.json)
  - products/<slug>.html (one static page per product)
  - sitemap.xml, robots.txt, 404.html

The Cloudflare Worker (webhook-worker/worker.js) is the PRIMARY writer and
mirrors this generator byte-for-byte; this script is the nightly reconcile /
manual route. Byte parity between the two generators is a hard requirement
(B-28) — change output format in BOTH or neither.

Rules:
  - Only products with visible=True and an external (published) id.
  - Products whose external id is in site-config.json excludedIds are kept
    OUT of the storefront (B-35, political SKUs).
  - Category comes from the Printify blueprint. An unknown blueprint is
    SKIPPED and flagged in the printed summary (never guessed).
  - Price = lowest enabled variant price.
  - Title/note split on " — " in the Printify title.
  - Buy links point at shop.papssupplyco.com (external.handle host swap).
  - Featured flags come from site-config.json featuredIds (external ids).
  - Catalog order interleaves categories (sticker, candle, drinkware,
    apparel rotation) so no single category walls off the grid (B-36).
  - Safety (B-01): the fetch must return exactly the API-reported total,
    and the new catalog may not drop >20% vs the current data/products.js
    without --force. Any failure exits non-zero and writes NOTHING (B-33).

Run:  python3 sync_from_printify.py [--force]   (writes files, prints summary)
"""
import hashlib
import html
import json
import os
import re
import subprocess
import sys

SHOP = "29269079"
BIN = "/opt/hatch/bin/printify"
BASE = "/home/hatch/workspace/paps-site"
CATEGORIES = {600: "stickers", 400: "stickers", 479: "drinkware", 1943: "candles", 77: "apparel", 380: "stockings", 413: "backpacks", 269: "phone-cases"}
# Google product taxonomy paths (verified against Google's official taxonomy
# file, 2021-09-21): stickers 4054, mugs 2169, candles 588, shirts & tops 212
# (no hoodie leaf exists — hoodies map to Shirts & Tops). Feeds carry this as
# google_product_category; Pinterest warns (157) when it is missing.
GOOGLE_PRODUCT_CATEGORY = {
    "stickers": "Arts & Entertainment > Hobbies & Creative Arts > Arts & Crafts > Art & Crafting Materials > Embellishments & Trims > Decorative Stickers",
    "drinkware": "Home & Garden > Kitchen & Dining > Tableware > Drinkware > Mugs",
    "candles": "Home & Garden > Decor > Home Fragrances > Candles",
    "apparel": "Apparel & Accessories > Clothing > Shirts & Tops",
    "stockings": "Home & Garden > Holiday & Seasonal Decor > Christmas Decorations > Christmas Stockings",
    "backpacks": "Luggage & Bags > Backpacks",
    "phone-cases": "Electronics > Communications > Telephony > Mobile Phone Accessories > Mobile Phone Cases",
}
CATEGORY_ORDER = ["stickers", "candles", "drinkware", "apparel", "stockings", "backpacks", "phone-cases"]
SITE = "https://papssupplyco.com"
STICKER_SIZE_NOTE = '2" · 3" · 4" die-cut vinyl'
PREFERRED_MOCKUP_SEGMENT = "72006"  # B-47: normalize sticker mockup variant


class SyncError(Exception):
    pass


# ---------------------------------------------------------------- fetch
def cli(args):
    r = subprocess.run([BIN] + args, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise SyncError(f"printify CLI failed ({' '.join(args)}): {r.stderr.strip()[:300]}")
    try:
        out = json.loads(r.stdout)
    except ValueError:
        raise SyncError(f"printify CLI returned non-JSON ({' '.join(args)})")
    if isinstance(out, dict) and out.get("ok") is False:
        raise SyncError(f"printify CLI error ({' '.join(args)}): {str(out)[:300]}")
    return out


def fetch_all():
    first = cli(["products", "--shop-id", SHOP])["body"]
    if not isinstance(first.get("data"), list):
        raise SyncError("page 1: body.data is not a list")
    total = first.get("total")
    products = list(first["data"])
    for page in range(2, int(first.get("last_page", 1)) + 1):
        body = cli(["request", "--method", "GET",
                    "--path", f"/shops/{SHOP}/products.json?page={page}"])["body"]
        if not isinstance(body.get("data"), list):
            raise SyncError(f"page {page}: body.data is not a list")
        products += body["data"]
    if total is not None and len(products) != int(total):
        raise SyncError(f"fetched {len(products)} products but API total is {total}")
    return products


# ---------------------------------------------------------------- helpers
def slugify(text):
    s = text.lower().replace("'", "").replace("\u2019", "")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def _mockup_segment(src):
    parts = src.split("/")
    return parts[5] if len(parts) > 6 else ""


def pick_image(images):
    """B-47: prefer the default front mockup; among defaults prefer the
    normalized mockup segment so one category doesn't mix two variants."""
    if not images:
        return ""
    cands = list(enumerate(images))

    def key(item):
        idx, img = item
        return (0 if img.get("is_default") else 1,
                0 if img.get("position") == "front" else 1,
                0 if _mockup_segment(img.get("src", "")) == PREFERRED_MOCKUP_SEGMENT else 1,
                idx)

    return sorted(cands, key=key)[0][1]["src"]


def esc(text):
    return html.escape(str(text), quote=True)


def price_str(price):
    return f"${price:.2f}"


def build_entries(products, featured_ids, excluded_ids):
    featured_ids = {str(x) for x in featured_ids}  # B-50: coerce like the Worker
    excluded_ids = {str(x) for x in excluded_ids}
    entries, flagged = [], []
    seen = set()
    overlap = 0
    for p in products:
        if not p.get("visible"):
            continue
        bp = p["blueprint_id"]
        if bp not in CATEGORIES:
            flagged.append(f"unknown blueprint {bp}: {p['title']}")
            continue
        ext = p.get("external") or {}
        ext_id = str(ext.get("id", ""))
        if not ext_id:
            flagged.append(f"unpublished draft (no external id), skipped: {p['title']}")
            continue
        if ext_id in excluded_ids:
            continue  # B-35: policy exclusion, silent by design
        if ext_id in seen:
            overlap += 1  # B-49: page overlap from a mid-sync edit
            continue
        seen.add(ext_id)
        full_title = p["title"]
        if " \u2014 " in full_title:
            title, note = full_title.split(" \u2014 ", 1)
        else:
            title, note = full_title, ""
        enabled = [v for v in p["variants"] if v.get("is_enabled")]
        if not enabled:
            flagged.append(f"no enabled variants: {full_title}")
            continue
        price = min(v["price"] for v in enabled) / 100.0
        handle = ext.get("handle") or f"https://paps-supply-co.printify.me/product/{ext_id}"
        buy_url = handle.replace("https://paps-supply-co.printify.me",
                                 "https://shop.papssupplyco.com")
        entries.append({
            "id": ext_id,
            "slug": slugify(full_title),
            "title": title,
            "note": note,
            "category": CATEGORIES[bp],
            "price": round(price, 2),
            "buyUrl": buy_url,
            "featured": ext_id in featured_ids,
            "image": pick_image(p.get("images") or []),
        })
    if overlap:
        flagged.append(f"page overlap: {overlap} duplicate product(s) skipped (B-49)")
    for fid in featured_ids:  # B-50: featured picks must resolve
        if not any(e["id"] == fid for e in entries):
            flagged.append(f"featuredId {fid} has no matching catalog entry")
    return interleave(entries), flagged


def interleave(entries):
    """B-36: rotate categories so the grid never walls off behind one kind."""
    groups = {c: [e for e in entries if e["category"] == c] for c in CATEGORY_ORDER}
    out = []
    idx = {c: 0 for c in CATEGORY_ORDER}
    remaining = len(entries)
    while remaining:
        for c in CATEGORY_ORDER:
            if idx[c] < len(groups[c]):
                out.append(groups[c][idx[c]])
                idx[c] += 1
                remaining -= 1
    return out


# ---------------------------------------------------------------- data files
def js_products(entries):
    lines = ["// Pap's Supply Co. — product data, GENERATED from Printify by sync_from_printify.py.",
             "// Do not hand-edit: change the product or price in Printify, then re-run the sync.",
             "",
             "const PRODUCTS = ["]
    for e in entries:
        lines.append("  " + json.dumps(e, ensure_ascii=False) + ",")
    lines.append("];")
    lines.append("")
    return "\n".join(lines)


def js_config(cfg):
    # B-53: featuredIds/excludedIds are generator inputs, not site config.
    out = {k: v for k, v in cfg.items() if k not in ("featuredIds", "excludedIds")}
    return ("// Pap's Supply Co. — site text + featured picks, generated from site-config.json\n"
            "// by sync_from_printify.py. Edit site-config.json (or ask Muse), then re-run the sync.\n\n"
            "const SITE_CONFIG = " + json.dumps(out, ensure_ascii=False, indent=2) + ";\n")


# ---------------------------------------------------------------- HTML
def page_url(entry):
    return f"{SITE}/products/{entry['slug']}.html"


def pin_save_url(entry):
    from urllib.parse import quote
    return ("https://www.pinterest.com/pin/create/button/?url=" + quote(page_url(entry), safe="")
            + "&media=" + quote(entry["image"], safe="")
            + "&description=" + quote(entry["title"] + " — " + entry["note"], safe=""))


def card_html(entry, indent="        "):
    title = esc(entry["title"])
    note = esc(entry["note"])
    price = price_str(entry["price"])
    size = ""
    if entry["category"] == "stickers":
        size = f'\n{indent}    <p class="card-size">{STICKER_SIZE_NOTE}</p>'
    return (
        f'{indent}<article class="product-card" data-category="{entry["category"]}">\n'
        f'{indent}  <a class="card-media" href="products/{entry["slug"]}.html">'
        f'<img src="{esc(entry["image"])}" alt="{title}" loading="lazy" decoding="async" width="600" height="600"></a>\n'
        f'{indent}  <div class="card-body">\n'
        f'{indent}    <h3 class="card-title"><a href="products/{entry["slug"]}.html">{title}</a></h3>\n'
        f'{indent}    <p class="card-note">{note}</p>\n'
        f'{indent}    <p class="card-price">{price}</p>{size}\n'
        f'{indent}  </div>\n'
        f'{indent}  <a class="btn btn-gold" href="{esc(entry["buyUrl"])}" target="_blank" rel="noopener" '
        f'aria-label="Buy Now — {title}, {price}">Buy Now</a>\n'
        f'{indent}</article>'
    )


def featured_card_html(entry, first=False):
    title = esc(entry["title"])
    fp = ' fetchpriority="high"' if first else ""
    return (
        f'        <div class="featured-card">\n'
        f'          <a href="products/{entry["slug"]}.html">'
        f'<img src="{esc(entry["image"])}" alt="" loading="lazy" decoding="async" width="280" height="280"{fp}>'
        f'<span class="featured-card-title">{title}</span>'
        f'<span class="featured-card-price">{price_str(entry["price"])}</span></a>\n'
        f'        </div>'
    )


def py_json(obj):
    return json.dumps(obj, ensure_ascii=False)


def product_jsonld(entry):
    meta = meta_description(entry)
    return py_json({
        "@context": "https://schema.org",
        "@type": "Product",
        "name": entry["title"],
        "description": meta,
        "image": entry["image"],
        "url": page_url(entry),
        # Google's Merchant-listings report (2026-10-30) asked for a global
        # identifier and a return policy in the structured data. Brand is
        # the honest identifier for made-to-order goods with no GTIN, and
        # MerchantReturnNotPermitted matches the published policy and the
        # Merchant Center account setting exactly. shippingDetails is
        # deliberately NOT added: it requires publishing a shipping rate,
        # which the owner has vetoed (no shipping-cost disclosure), and
        # review/aggregateRating stay out until real reviews exist.
        "brand": {"@type": "Brand", "name": "Pap's Supply Co."},
        "offers": {
            "@type": "Offer",
            "url": entry["buyUrl"],
            "priceCurrency": "USD",
            "price": f"{entry['price']:.2f}",
            "availability": "https://schema.org/InStock",
            "hasMerchantReturnPolicy": {
                "@type": "MerchantReturnPolicy",
                "applicableCountry": "US",
                "returnPolicyCategory":
                    "https://schema.org/MerchantReturnNotPermitted",
            },
        },
    })


def meta_description(entry):
    base = entry["title"] + (f" — {entry['note']}" if entry["note"] else "")
    return f"{base} · {price_str(entry['price'])} · Printed to order by Pap's Supply Co."


PRODUCT_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>__TITLE__ · Pap's Supply Co.</title>
  <meta name="description" content="__META__">
  <link rel="canonical" href="__URL__">
  <meta property="og:type" content="product">
  <meta property="og:title" content="__TITLE__">
  <meta property="og:description" content="__META__">
  <meta property="og:image" content="__IMAGE__">
  <meta property="og:url" content="__URL__">
  <meta property="product:price:amount" content="__PRICEAMT__">
  <meta property="product:price:currency" content="USD">
  <meta property="product:availability" content="in stock">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="theme-color" content="#171310">
  <link rel="icon" type="image/svg+xml" href="../assets/favicon.svg">
  <link rel="stylesheet" href="../styles.css">
  <script type="application/ld+json">__JSONLD__</script>
</head>
<body id="top">
  <header class="site-header">
    <a class="wordmark" href="../index.html">PAP'S SUPPLY CO.</a>
    <nav class="site-nav" aria-label="Primary">
      <a href="../index.html#catalog">Catalog</a>
      <a href="../index.html#about">About</a>
      <a class="printify-link" href="https://shop.papssupplyco.com" target="_blank" rel="noopener">Shop</a>
    </nav>
  </header>
  <main class="product-page">
    <p class="breadcrumb"><a href="../index.html#catalog">&larr; All goods</a></p>
    <div class="product-hero">
      <div class="card-media product-media"><img src="__IMAGE__" alt="__TITLE__" width="600" height="600"></div>
      <div class="product-info">
        <h1 class="product-title">__TITLE__</h1>
        <p class="card-note">__NOTE__</p>
        <p class="card-price">__PRICE__</p>
__SIZE__
        <a class="btn btn-gold" href="__BUYURL__" target="_blank" rel="noopener" data-buy="__ID__" aria-label="Buy Now — __TITLE__, __PRICE__">Buy Now</a>
        <p class="buy-note">Checkout happens on our shop — printed to order, allow 2–7 business days for production plus shipping time.</p>
      </div>
    </div>
  </main>
  <footer class="site-footer">
    <p class="footer-copyright">© 2026 Pap's Supply Co.</p>
    <a class="footer-link" href="https://www.instagram.com/paps.supply.co/" target="_blank" rel="noopener">Instagram</a>
    <a class="footer-link" href="https://www.pinterest.com/papssupplyco/" target="_blank" rel="noopener">Pinterest</a>
    <a class="footer-link" href="../shipping-policy.html">Shipping</a>
    <a class="footer-link" href="../returns-policy.html">Returns</a>
    <a class="footer-link" href="mailto:support@papssupplyco.com">Contact: support@papssupplyco.com</a>
    <a class="footer-link" href="../index.html">Back to the shop</a>
  </footer>
  <script>
    // B-26 instrumentation hooks: no-op transport until an analytics
    // beacon is configured. Events: buy_click {id, placement}.
    window.PAPS_ANALYTICS = { transport: null, track: function (n, d) { if (this.transport) this.transport(n, d); } };
    document.querySelectorAll("[data-buy]").forEach(function (a) {
      a.addEventListener("click", function () {
        window.PAPS_ANALYTICS.track("buy_click", { id: a.getAttribute("data-buy"), placement: "product-page" });
      });
    });
  </script>
</body>
</html>
"""


def product_page(entry):
    size = ""
    if entry["category"] == "stickers":
        size = f'        <p class="card-size">{STICKER_SIZE_NOTE}</p>'
    out = PRODUCT_PAGE
    out = out.replace("__TITLE__", esc(entry["title"]))
    out = out.replace("__META__", esc(meta_description(entry)))
    out = out.replace("__URL__", page_url(entry))
    out = out.replace("__IMAGE__", esc(entry["image"]))
    out = out.replace("__JSONLD__", product_jsonld(entry))
    out = out.replace("__NOTE__", esc(entry["note"]))
    out = out.replace("__PRICE__", price_str(entry["price"]))
    out = out.replace("__PRICEAMT__", f"{entry['price']:.2f}")
    out = out.replace("__SIZE__", size)
    out = out.replace("__BUYURL__", esc(entry["buyUrl"]))
    out = out.replace("__ID__", entry["id"])
    out = out.replace("__SAVEURL__", esc(pin_save_url(entry)))
    return out


NOT_FOUND_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Not Found · Pap's Supply Co.</title>
  <meta name="robots" content="noindex">
  <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
  <link rel="stylesheet" href="/styles.css">
</head>
<body id="top">
  <main class="product-page">
    <h1 class="product-title">This haunt is empty.</h1>
    <p class="about-text">Whatever was here has moved on. The goods live <a href="/">on the main page</a>.</p>
  </main>
</body>
</html>
"""

ROBOTS_TXT = "User-agent: Googlebot\nAllow: /\n\nUser-agent: Googlebot-Image\nAllow: /\n\nUser-agent: AdsBot-Google\nAllow: /\n\nUser-agent: *\nAllow: /\n\nSitemap: https://papssupplyco.com/sitemap.xml\n"


STATIC_URLS = [f"{SITE}/gothic-christmas-stickers.html",
               f"{SITE}/shipping-policy.html",
               f"{SITE}/returns-policy.html"]


def sitemap_xml(entries):
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
             f"<url><loc>{SITE}/</loc></url>"]
    for u in STATIC_URLS:
        lines.append(f"<url><loc>{u}</loc></url>")
    for e in entries:
        lines.append(f"<url><loc>{page_url(e)}</loc></url>")
    lines.append("</urlset>")
    lines.append("")
    return "\n".join(lines)


def itemlist_jsonld(entries):
    return py_json({
        "@context": "https://schema.org",
        "@type": "ItemList",
        "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "name": e["title"], "url": page_url(e)}
            for i, e in enumerate(entries)
        ],
    })


def build_index(template, entries, cfg):
    out = template
    page_title = cfg.get("pageTitle") or "Pap's Supply Co. — Dark Goods for Daily Rituals"
    meta_desc = cfg.get("metaDescription") or ""
    out = re.sub(r"<title>.*?</title>", f"<title>{esc(page_title)}</title>", out, count=1)
    out = re.sub(r'(<meta name="description" content=")[^"]*(")',
                 lambda m: m.group(1) + esc(meta_desc) + m.group(2), out, count=1)
    for prop in ("og:title", "twitter:title"):
        out = re.sub(rf'(<meta property="{prop}" content=")[^"]*(")',
                     lambda m: m.group(1) + esc(page_title) + m.group(2), out, count=1)
    for prop in ("og:description", "twitter:description"):
        out = re.sub(rf'(<meta property="{prop}" content=")[^"]*(")',
                     lambda m: m.group(1) + esc(meta_desc) + m.group(2), out, count=1)
    featured = [e for e in entries if e["featured"]]
    og_image = featured[0]["image"] if featured else (entries[0]["image"] if entries else "")
    for prop in ("og:image", "twitter:image"):
        out = re.sub(rf'(<meta property="{prop}" content=")[^"]*(")',
                     lambda m: m.group(1) + esc(og_image) + m.group(2), out, count=1)
    # og:title/og:description use property=, twitter uses name= — handled above
    # for property; twitter:title/description actually use name= in the template:
    for name in ("twitter:title",):
        out = re.sub(rf'(<meta name="{name}" content=")[^"]*(")',
                     lambda m: m.group(1) + esc(page_title) + m.group(2), out, count=1)
    for name in ("twitter:description",):
        out = re.sub(rf'(<meta name="{name}" content=")[^"]*(")',
                     lambda m: m.group(1) + esc(meta_desc) + m.group(2), out, count=1)
    for name in ("twitter:image",):
        out = re.sub(rf'(<meta name="{name}" content=")[^"]*(")',
                     lambda m: m.group(1) + esc(og_image) + m.group(2), out, count=1)
    itemlist = ('<script type="application/ld+json">' + itemlist_jsonld(entries) + "</script>")
    out = re.sub(r"<!--ITEMLIST:START-->.*?<!--ITEMLIST:END-->",
                 lambda m: "<!--ITEMLIST:START-->" + itemlist + "<!--ITEMLIST:END-->",
                 out, count=1, flags=re.S)
    feat_html = "\n" + "\n".join(featured_card_html(e, i == 0) for i, e in enumerate(featured)) + "\n      "
    out = re.sub(r"<!--PRERENDER:FEATURED-->.*?<!--/PRERENDER:FEATURED-->",
                 lambda m: "<!--PRERENDER:FEATURED-->" + feat_html + "<!--/PRERENDER:FEATURED-->",
                 out, count=1, flags=re.S)
    grid_html = "\n" + "\n".join(card_html(e) for e in entries) + "\n      "
    out = re.sub(r"<!--PRERENDER:GRID-->.*?<!--/PRERENDER:GRID-->",
                 lambda m: "<!--PRERENDER:GRID-->" + grid_html + "<!--/PRERENDER:GRID-->",
                 out, count=1, flags=re.S)
    out = out.replace("KIT_FORM_ACTION_URL", cfg.get("kitFormAction") or "#")
    return out


def generate_files(entries, cfg):
    """Return {relative_path: content} for every generated file."""
    template = open(f"{BASE}/index.template.html").read()
    files = {
        "data/products.js": js_products(entries),
        "data/config.js": js_config(cfg),
        "index.html": build_index(template, entries, cfg),
        "sitemap.xml": sitemap_xml(entries),
        "robots.txt": ROBOTS_TXT,
        "404.html": NOT_FOUND_PAGE,
    }
    for e in entries:
        files[f"products/{e['slug']}.html"] = product_page(e)
    files["pinterest-feed.tsv"] = pinterest_feed(entries)
    files["google-feed.tsv"] = google_feed(entries)
    return files


def _tsv_clean(s):
    return str(s).replace("\t", " ").replace("\r", " ").replace("\n", " ").strip()


def google_feed(entries):
    """Google Merchant Center data source (TSV): one row per product.

    Custom print-on-demand goods carry no GTIN/MPN, so identifier_exists
    is 'no'. Shipping/tax are configured once at the account level.
    """
    cols = ["id", "title", "description", "link", "image_link", "price",
            "availability", "brand", "condition", "identifier_exists",
            "google_product_category"]
    lines = ["\t".join(cols)]
    for e in entries:
        desc = meta_description(e)
        lines.append("\t".join(_tsv_clean(v) for v in [
            e["id"],
            e["title"] + (" — " + e["note"] if e["note"] else ""),
            desc,
            page_url(e),
            e["image"],
            f"{e['price']:.2f} USD",
            "in_stock",
            "Pap's Supply Co.",
            "new",
            "no",
            GOOGLE_PRODUCT_CATEGORY[e["category"]],
        ]))
    return "\n".join(lines) + "\n"


PRINTIFY_IMAGE_HOST = "https://images-api.printify.com/"
FEED_IMAGE_BASE = ("https://paps-printify-sync.lezamamanuell19.workers.dev"
                   "/feed-img/")


def feed_image(url):
    """Route Pinterest feed images through the sync Worker's edge cache.

    2026-10-29: Printify's image CDN fails Pinterest's parallel catalog
    fetcher (Error 1300, "Unable to retrieve the image") — the same 6
    products failed every ingestion while their URLs test fine one by
    one. The Worker proxies /mockup/ paths with a 24h edge cache, so
    Pinterest fetches from Cloudflare instead. Product pages and the
    Google feed keep the direct Printify URL.
    """
    if url.startswith(PRINTIFY_IMAGE_HOST):
        return FEED_IMAGE_BASE + url[len(PRINTIFY_IMAGE_HOST):]
    return url


def pinterest_feed(entries):
    """Pinterest Catalogs data source (TSV): one row per published product.

    Pinterest re-reads the hosted file daily and auto-creates Product Pins
    with live price/availability. Columns follow Pinterest's catalog spec.
    """
    cols = ["id", "title", "description", "link", "image_link", "price",
            "availability", "brand", "condition", "google_product_category"]
    lines = ["\t".join(cols)]
    for e in entries:
        desc = meta_description(e)
        lines.append("\t".join(_tsv_clean(v) for v in [
            e["id"],
            e["title"] + (" — " + e["note"] if e["note"] else ""),
            desc,
            page_url(e),
            feed_image(e["image"]),
            f"{e['price']:.2f} USD",
            "in stock",
            "Pap's Supply Co.",
            "new",
            GOOGLE_PRODUCT_CATEGORY[e["category"]],
        ]))
    return "\n".join(lines) + "\n"


def git_blob_sha(content):
    data = content.encode("utf-8")
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


# ---------------------------------------------------------------- diff vs old
def read_old_prices():
    try:
        text = open(f"{BASE}/data/products.js").read()
    except FileNotFoundError:
        return {}
    old = {}
    pat = re.compile(
        r'"?title"?\s*:\s*"([^"]*)"[\s\S]{0,500}?"?price"?\s*:\s*([0-9.]+)'
        r'[\s\S]{0,500}?"?buyUrl"?\s*:\s*"([^"]+)"')
    for m in pat.finditer(text):
        old[m.group(3)] = (m.group(1), float(m.group(2)))
    return old


def current_count():
    try:
        text = open(f"{BASE}/data/products.js").read()
    except FileNotFoundError:
        return 0
    return text.count('"id":')


def atomic_write(path, content):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(content)
    os.replace(tmp, path)


def main():
    force = "--force" in sys.argv
    cfg = json.load(open(f"{BASE}/site-config.json"))
    try:
        products = fetch_all()
    except SyncError as e:
        print(f"SYNC ABORTED: {e}")
        return 1
    entries, flagged = build_entries(products, cfg.get("featuredIds", []),
                                      cfg.get("excludedIds", []))

    # B-01: refuse a catastrophic shrink without an explicit override.
    prev = current_count()
    if prev and len(entries) < 0.8 * prev and not force:
        print(f"SYNC ABORTED: new catalog has {len(entries)} entries vs {prev} current "
              f"(>20% drop). Re-run with --force only if the shrink is intended.")
        return 1

    old = read_old_prices()
    new = {e["buyUrl"]: (e["title"], e["price"]) for e in entries}
    added = [t for u, (t, _) in new.items() if u not in old]
    removed = [t for u, (t, _) in old.items() if u not in new]
    changed = [(t, old[u][1], pr) for u, (t, pr) in new.items()
               if u in old and old[u][1] != pr]

    files = generate_files(entries, cfg)
    for rel, content in files.items():
        path = os.path.join(BASE, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        atomic_write(path, content)
    # Remove stale product pages (B-10 hygiene; also drops excluded SKUs).
    keep = {f"products/{e['slug']}.html" for e in entries}
    pdir = os.path.join(BASE, "products")
    if os.path.isdir(pdir):
        for name in os.listdir(pdir):
            rel = f"products/{name}"
            if name.endswith(".html") and rel not in keep:
                os.remove(os.path.join(pdir, name))

    print(f"products written: {len(entries)}")
    print(f"added ({len(added)}): {added}")
    print(f"removed ({len(removed)}): {removed}")
    print(f"price changes ({len(changed)}):")
    for t, o, n in changed:
        print(f"  {t}: {o} -> {n}")
    if flagged:
        print(f"FLAGGED ({len(flagged)}):")
        for f in flagged:
            print("  " + f)
    if not (added or removed or changed or flagged):
        print("no changes vs previous data file")
    return 0


if __name__ == "__main__":
    sys.exit(main())
