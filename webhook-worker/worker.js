// Pap's Supply Co. — Printify -> papssupplyco.com instant sync worker.
//
// PRIMARY catalog writer. Receives Printify product webhooks, regenerates
// the storefront from the Printify API, and commits to the GitHub repo
// (GitHub Pages redeploys automatically). Generates, byte-for-byte like
// sync_from_printify.py (the nightly reconcile — parity is a hard rule):
//   data/products.js, data/config.js, index.html (prerender + SEO surgery
//   on the committed file), products/<slug>.html per product, sitemap.xml,
//   robots.txt, 404.html. Stale product pages are deleted in the same commit.
//
// Rules (mirror the Python generator):
//   - visible products only; unpublished drafts (no external id) skipped
//   - site-config.json excludedIds stay out of the storefront (political)
//   - category from blueprint id; unknown blueprint = skip (never guessed)
//   - price = lowest enabled variant price; title/note split on " — "
//   - buy links use the external handle with the host swapped to
//     shop.papssupplyco.com
//   - catalog order interleaves categories (no single-category wall)
//   - featured flags + site wording come from site-config.json IN THE REPO
//
// Safety:
//   - B-01: every Printify page must be HTTP-ok with an array body, the
//     fetched count must equal the API total, and a >20% catalog drop vs
//     the current repo aborts the sync (no commit).
//   - B-29: only allowlisted product topics trigger a sync; the topic is
//     sanitized before it reaches a commit message; publish/delete topics
//     get a delayed verification re-sync.
//   - B-30: sync failures are recorded in lastSync (readable via the
//     authenticated /health) and the GitHub Pages build status is checked
//     after each commit.
//   - B-31: a non-fast-forward ref update is retried once from a fresh head.
//   - B-32: /sync and detailed /health require the webhook secret via the
//     Authorization header (the ?key= query fallback is kept for ONE
//     release); signature comparison is constant-time over decoded bytes.
//
// Secrets (Worker settings, never in code):
//   PRINTIFY_TOKEN  - Printify personal access token (Bearer)
//   GITHUB_TOKEN    - fine-grained PAT, this repo only, Contents: Read+Write
//   WEBHOOK_SECRET  - shared secret registered with the Printify webhooks
// Var:
//   SIGNATURE_MODE  - "observe" (log only) or "enforce" (401 on bad signature)

const SHOP_ID = "29269079";
const OWNER = "pappap19";
const REPO = "paps-supply-co";
const BRANCH = "main";
const CATEGORIES = { 600: "stickers", 400: "stickers", 479: "drinkware", 1943: "candles", 77: "apparel", 380: "stockings", 413: "backpacks", 269: "phone-cases", 220: "pillows" };
const CATEGORY_ORDER = ["stickers", "candles", "drinkware", "apparel", "stockings", "backpacks", "phone-cases", "pillows"];
const SITE = "https://papssupplyco.com";
const STICKER_SIZE_NOTE = '2" · 3" · 4" die-cut vinyl';
const PREFERRED_MOCKUP_SEGMENT = "72006";
const SYNC_TOPICS = new Set([
  "product:created", "product:updated", "product:deleted", "product:publish:started",
]);
const RESYNC_TOPICS = new Set(["product:deleted", "product:publish:started"]);

let lastRunAt = 0;
let lastSync = null; // {at, result|error, topic}

// ---------------------------------------------------------------- helpers
function slugify(text) {
  let s = text.toLowerCase().replace(/['’]/g, "");
  s = s.replace(/[^a-z0-9]+/g, "-");
  return s.replace(/^-+|-+$/g, "");
}

function mockupSegment(src) {
  const parts = String(src || "").split("/");
  return parts.length > 6 ? parts[5] : "";
}

function pickImage(images) {
  if (!images || !images.length) return "";
  const keyed = images.map((img, idx) => ({
    img,
    key: [
      img.is_default ? 0 : 1,
      img.position === "front" ? 0 : 1,
      mockupSegment(img.src) === PREFERRED_MOCKUP_SEGMENT ? 0 : 1,
      idx,
    ],
  }));
  keyed.sort((a, b) => {
    for (let i = 0; i < 4; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    return 0;
  });
  return keyed[0].img.src;
}

// Match Python html.escape(s, quote=True) exactly (incl. &#x27;).
function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function priceStr(price) {
  return "$" + Number(price).toFixed(2);
}

function pyFloat(n) {
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

function pyStr(s) {
  return JSON.stringify(String(s));
}

// Match Python json.dumps(..., ensure_ascii=False) with default separators.
function pyJson(v) {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return String(v); // Python ints in JSON-LD (positions)
  if (typeof v === "string") return pyStr(v);
  if (Array.isArray(v)) return "[" + v.map(pyJson).join(", ") + "]";
  const parts = Object.keys(v).map(k => pyStr(k) + ": " + pyJson(v[k]));
  return "{" + parts.join(", ") + "}";
}

function pyEntryJson(e) {
  const parts = [
    `"id": ${pyStr(e.id)}`,
    `"slug": ${pyStr(e.slug)}`,
    `"title": ${pyStr(e.title)}`,
    `"note": ${pyStr(e.note)}`,
    `"category": ${pyStr(e.category)}`,
    `"price": ${pyFloat(e.price)}`,
    `"buyUrl": ${pyStr(e.buyUrl)}`,
    `"featured": ${e.featured ? "true" : "false"}`,
    `"image": ${pyStr(e.image)}`,
  ];
  return "{" + parts.join(", ") + "}";
}

// Match Python urllib.parse.quote(s, safe="").
function pyQuote(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g,
    ch => "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

// ---------------------------------------------------------------- entries
function interleave(entries) {
  const groups = {};
  for (const c of CATEGORY_ORDER) groups[c] = entries.filter(e => e.category === c);
  const idx = { stickers: 0, candles: 0, drinkware: 0, apparel: 0 };
  const out = [];
  let remaining = entries.length;
  while (remaining > 0) {
    for (const c of CATEGORY_ORDER) {
      if (idx[c] < groups[c].length) {
        out.push(groups[c][idx[c]]);
        idx[c]++;
        remaining--;
      }
    }
  }
  return out;
}

function buildEntries(products, featuredIds, excludedIds) {
  const featured = new Set((featuredIds || []).map(String));
  const excluded = new Set((excludedIds || []).map(String));
  const entries = [];
  const flagged = [];
  const seen = new Set();
  let overlap = 0;
  for (const p of products) {
    if (!p.visible) continue;
    const cat = CATEGORIES[p.blueprint_id];
    if (!cat) { flagged.push(`unknown blueprint ${p.blueprint_id}: ${p.title}`); continue; }
    const ext = p.external || {};
    const extId = ext.id ? String(ext.id) : "";
    if (!extId) { flagged.push(`unpublished draft (no external id), skipped: ${p.title}`); continue; }
    if (excluded.has(extId)) continue;
    if (seen.has(extId)) { overlap++; continue; }
    seen.add(extId);
    const fullTitle = p.title;
    let title = fullTitle, note = "";
    const i = fullTitle.indexOf(" — ");
    if (i >= 0) { title = fullTitle.slice(0, i); note = fullTitle.slice(i + 3); }
    const enabled = (p.variants || []).filter(v => v.is_enabled);
    if (!enabled.length) { flagged.push(`no enabled variants: ${fullTitle}`); continue; }
    const price = Math.min(...enabled.map(v => v.price)) / 100;
    const handle = ext.handle || `https://paps-supply-co.printify.me/product/${extId}`;
    entries.push({
      id: extId,
      slug: slugify(fullTitle),
      title, note,
      category: cat,
      price: Math.round(price * 100) / 100,
      buyUrl: handle.replace("https://paps-supply-co.printify.me", "https://shop.papssupplyco.com"),
      featured: featured.has(extId),
      image: pickImage(p.images),
    });
  }
  if (overlap) flagged.push(`page overlap: ${overlap} duplicate product(s) skipped (B-49)`);
  for (const fid of featured) {
    if (!entries.some(e => e.id === fid)) {
      flagged.push(`featuredId ${fid} has no matching catalog entry`);
    }
  }
  return { entries: interleave(entries), flagged };
}

// ---------------------------------------------------------------- files
function jsProducts(entries) {
  const lines = [
    "// Pap's Supply Co. — product data, GENERATED from Printify by sync_from_printify.py.",
    "// Do not hand-edit: change the product or price in Printify, then re-run the sync.",
    "",
    "const PRODUCTS = [",
  ];
  for (const e of entries) lines.push("  " + pyEntryJson(e) + ",");
  lines.push("];");
  lines.push("");
  return lines.join("\n");
}

function jsConfig(cfg) {
  const out = {};
  for (const k of Object.keys(cfg)) {
    if (k !== "featuredIds" && k !== "excludedIds") out[k] = cfg[k];
  }
  return "// Pap's Supply Co. — site text + featured picks, generated from site-config.json\n" +
    "// by sync_from_printify.py. Edit site-config.json (or ask Muse), then re-run the sync.\n\n" +
    "const SITE_CONFIG = " + JSON.stringify(out, null, 2) + ";\n";
}

function pageUrl(entry) {
  return `${SITE}/products/${entry.slug}.html`;
}

function pinSaveUrl(entry) {
  return "https://www.pinterest.com/pin/create/button/?url=" + pyQuote(pageUrl(entry)) +
    "&media=" + pyQuote(entry.image) +
    "&description=" + pyQuote(entry.title + " — " + entry.note);
}

function metaDescription(entry) {
  const base = entry.title + (entry.note ? ` — ${entry.note}` : "");
  return `${base} · ${priceStr(entry.price)} · Printed to order by Pap's Supply Co.`;
}

function cardHtml(entry, indent = "        ") {
  const title = esc(entry.title);
  const note = esc(entry.note);
  const price = priceStr(entry.price);
  const size = entry.category === "stickers"
    ? `\n${indent}    <p class="card-size">${STICKER_SIZE_NOTE}</p>` : "";
  return (
    `${indent}<article class="product-card" data-category="${entry.category}">\n` +
    `${indent}  <a class="card-media" href="products/${entry.slug}.html">` +
    `<img src="${esc(entry.image)}" alt="${title}" loading="lazy" decoding="async" width="600" height="600"></a>\n` +
    `${indent}  <div class="card-body">\n` +
    `${indent}    <h3 class="card-title"><a href="products/${entry.slug}.html">${title}</a></h3>\n` +
    `${indent}    <p class="card-note">${note}</p>\n` +
    `${indent}    <p class="card-price">${price}</p>${size}\n` +
    `${indent}  </div>\n` +
    `${indent}  <a class="btn btn-gold" href="${esc(entry.buyUrl)}" target="_blank" rel="noopener" ` +
    `aria-label="Buy Now — ${title}, ${price}">Buy Now</a>\n` +
    `${indent}</article>`
  );
}

function featuredCardHtml(entry, first = false) {
  const title = esc(entry.title);
  const fp = first ? ' fetchpriority="high"' : "";
  return (
    `        <div class="featured-card">\n` +
    `          <a href="products/${entry.slug}.html">` +
    `<img src="${esc(entry.image)}" alt="" loading="lazy" decoding="async" width="280" height="280"${fp}>` +
    `<span class="featured-card-title">${title}</span>` +
    `<span class="featured-card-price">${priceStr(entry.price)}</span></a>\n` +
    `        </div>`
  );
}

function productJsonLd(entry) {
  return pyJson({
    "@context": "https://schema.org",
    "@type": "Product",
    "name": entry.title,
    "description": metaDescription(entry),
    "image": entry.image,
    "url": pageUrl(entry),
    // Same structured-data additions as sync_from_printify.py (parity):
    // brand = the honest identifier for goods with no GTIN;
    // MerchantReturnNotPermitted matches the published policy and the
    // Merchant Center setting. No shippingDetails (would publish a
    // shipping rate — owner veto) and no review/aggregateRating (no
    // real reviews exist).
    "brand": { "@type": "Brand", "name": "Pap's Supply Co." },
    "offers": {
      "@type": "Offer",
      "url": entry.buyUrl,
      "priceCurrency": "USD",
      "price": Number(entry.price).toFixed(2),
      "availability": "https://schema.org/InStock",
      "hasMerchantReturnPolicy": {
        "@type": "MerchantReturnPolicy",
        "applicableCountry": "US",
        "returnPolicyCategory": "https://schema.org/MerchantReturnNotPermitted",
      },
    },
  });
}

const PRODUCT_PAGE = `<!DOCTYPE html>
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
`;

function productPage(entry) {
  const size = entry.category === "stickers"
    ? `        <p class="card-size">${STICKER_SIZE_NOTE}</p>` : "";
  let out = PRODUCT_PAGE;
  out = out.split("__TITLE__").join(esc(entry.title));
  out = out.split("__META__").join(esc(metaDescription(entry)));
  out = out.split("__URL__").join(pageUrl(entry));
  out = out.split("__IMAGE__").join(esc(entry.image));
  out = out.split("__JSONLD__").join(productJsonLd(entry));
  out = out.split("__NOTE__").join(esc(entry.note));
  out = out.split("__PRICE__").join(priceStr(entry.price));
  out = out.split("__SIZE__").join(size);
  out = out.split("__BUYURL__").join(esc(entry.buyUrl));
  out = out.split("__ID__").join(entry.id);
  out = out.split("__SAVEURL__").join(esc(pinSaveUrl(entry)));
  return out;
}

const NOT_FOUND_PAGE = `<!DOCTYPE html>
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
`;

const ROBOTS_TXT = "User-agent: Googlebot\nAllow: /\n\nUser-agent: Googlebot-Image\nAllow: /\n\nUser-agent: AdsBot-Google\nAllow: /\n\nUser-agent: *\nAllow: /\n\nSitemap: https://papssupplyco.com/sitemap.xml\n";

function sitemapXml(entries) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `<url><loc>${SITE}/</loc></url>`,
  ];
  for (const e of entries) lines.push(`<url><loc>${pageUrl(e)}</loc></url>`);
  lines.push("</urlset>");
  lines.push("");
  return lines.join("\n");
}

function itemListJsonLd(entries) {
  return pyJson({
    "@context": "https://schema.org",
    "@type": "ItemList",
    "itemListElement": entries.map((e, i) => ({
      "@type": "ListItem", "position": i + 1, "name": e.title, "url": pageUrl(e),
    })),
  });
}

function buildIndex(currentHtml, entries, cfg) {
  let out = currentHtml;
  const pageTitle = cfg.pageTitle || "Pap's Supply Co. — Dark Goods for Daily Rituals";
  const metaDesc = cfg.metaDescription || "";
  out = out.replace(/<title>.*?<\/title>/, `<title>${esc(pageTitle)}</title>`);
  out = out.replace(/(<meta name="description" content=")[^"]*(")/,
    (m, a, b) => a + esc(metaDesc) + b);
  for (const prop of ["og:title", "twitter:title"]) {
    out = out.replace(new RegExp(`(<meta property="${prop}" content=")[^"]*(")`),
      (m, a, b) => a + esc(pageTitle) + b);
  }
  for (const prop of ["og:description", "twitter:description"]) {
    out = out.replace(new RegExp(`(<meta property="${prop}" content=")[^"]*(")`),
      (m, a, b) => a + esc(metaDesc) + b);
  }
  const featured = entries.filter(e => e.featured);
  const ogImage = featured.length ? featured[0].image : (entries.length ? entries[0].image : "");
  for (const prop of ["og:image", "twitter:image"]) {
    out = out.replace(new RegExp(`(<meta property="${prop}" content=")[^"]*(")`),
      (m, a, b) => a + esc(ogImage) + b);
  }
  for (const name of ["twitter:title"]) {
    out = out.replace(new RegExp(`(<meta name="${name}" content=")[^"]*(")`),
      (m, a, b) => a + esc(pageTitle) + b);
  }
  for (const name of ["twitter:description"]) {
    out = out.replace(new RegExp(`(<meta name="${name}" content=")[^"]*(")`),
      (m, a, b) => a + esc(metaDesc) + b);
  }
  for (const name of ["twitter:image"]) {
    out = out.replace(new RegExp(`(<meta name="${name}" content=")[^"]*(")`),
      (m, a, b) => a + esc(ogImage) + b);
  }
  const itemlist = '<script type="application/ld+json">' + itemListJsonLd(entries) + "</script>";
  out = out.replace(/<!--ITEMLIST:START-->[\s\S]*?<!--ITEMLIST:END-->/,
    "<!--ITEMLIST:START-->" + itemlist + "<!--ITEMLIST:END-->");
  const featHtml = "\n" + featured.map((e, i) => featuredCardHtml(e, i === 0)).join("\n") + "\n      ";
  out = out.replace(/<!--PRERENDER:FEATURED-->[\s\S]*?<!--\/PRERENDER:FEATURED-->/,
    "<!--PRERENDER:FEATURED-->" + featHtml + "<!--/PRERENDER:FEATURED-->");
  const gridHtml = "\n" + entries.map(e => cardHtml(e)).join("\n") + "\n      ";
  out = out.replace(/<!--PRERENDER:GRID-->[\s\S]*?<!--\/PRERENDER:GRID-->/,
    "<!--PRERENDER:GRID-->" + gridHtml + "<!--/PRERENDER:GRID-->");
  return out;
}

function generateFiles(entries, cfg, currentIndexHtml) {
  const files = {
    "data/products.js": jsProducts(entries),
    "data/config.js": jsConfig(cfg),
    "index.html": buildIndex(currentIndexHtml, entries, cfg),
    "sitemap.xml": sitemapXml(entries),
    "robots.txt": ROBOTS_TXT,
    "404.html": NOT_FOUND_PAGE,
  };
  for (const e of entries) files[`products/${e.slug}.html`] = productPage(e);
  return files;
}

async function gitBlobSha(content) {
  const data = new TextEncoder().encode(content);
  const head = new TextEncoder().encode(`blob ${data.length}\0`);
  const buf = new Uint8Array(head.length + data.length);
  buf.set(head, 0);
  buf.set(data, head.length);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- Printify
async function printifyPage(token, page) {
  const url = page === 1
    ? `https://api.printify.com/v1/shops/${SHOP_ID}/products.json`
    : `https://api.printify.com/v1/shops/${SHOP_ID}/products.json?page=${page}`;
  const r = await fetch(url, { headers: { "Authorization": `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Printify page ${page} -> HTTP ${r.status}`);
  const body = await r.json();
  if (!body || !Array.isArray(body.data)) {
    throw new Error(`Printify page ${page}: body.data is not an array`);
  }
  return body;
}

async function printifyAllProducts(token) {
  const first = await printifyPage(token, 1);
  let products = [...first.data];
  const lastPage = first.last_page || 1;
  for (let page = 2; page <= lastPage; page++) {
    const body = await printifyPage(token, page);
    products = products.concat(body.data);
  }
  if (first.total != null && products.length !== first.total) {
    throw new Error(`fetched ${products.length} products but API total is ${first.total}`);
  }
  return products;
}

// ---------------------------------------------------------------- GitHub
const GH = "https://api.github.com";
function ghHeaders(env) {
  return {
    "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "paps-printify-sync-worker",
  };
}

async function ghJson(env, path, opts = {}) {
  const r = await fetch(GH + path, { ...opts, headers: { ...ghHeaders(env), ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`GitHub ${opts.method || "GET"} ${path} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

function b64encodeUtf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64decodeUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function repoFile(env, path) {
  const data = await ghJson(env, `/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`);
  return b64decodeUtf8(data.content);
}

async function repoTree(env, headSha) {
  const commit = await ghJson(env, `/repos/${OWNER}/${REPO}/git/commits/${headSha}`);
  const tree = await ghJson(env,
    `/repos/${OWNER}/${REPO}/git/trees/${commit.tree.sha}?recursive=1`);
  const map = {};
  for (const item of tree.tree || []) {
    if (item.type === "blob") map[item.path] = item.sha;
  }
  return { treeSha: commit.tree.sha, map };
}

async function commitFiles(env, files, topic, treeMap, headSha, baseTreeSha) {
  const changes = [];
  for (const [path, content] of Object.entries(files)) {
    const sha = await gitBlobSha(content);
    if (treeMap[path] !== sha) changes.push({ path, content, sha });
  }
  const deletions = Object.keys(treeMap).filter(
    p => p.startsWith("products/") && p.endsWith(".html") && !(p in files));
  if (!changes.length && !deletions.length) return { changed: false };

  const treeEntries = [];
  for (const ch of changes) {
    const blob = await ghJson(env, `/repos/${OWNER}/${REPO}/git/blobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: b64encodeUtf8(ch.content), encoding: "base64" }),
    });
    treeEntries.push({ path: ch.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  for (const path of deletions) {
    treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
  }
  const tree = await ghJson(env, `/repos/${OWNER}/${REPO}/git/trees`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
  });
  const safeTopic = String(topic || "manual").replace(/[^a-z:]/g, "");
  const commit = await ghJson(env, `/repos/${OWNER}/${REPO}/git/commits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Site sync from Printify (webhook: ${safeTopic})`,
      tree: tree.sha,
      parents: [headSha],
    }),
  });
  await ghJson(env, `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha: commit.sha }),
  });
  return { changed: true, commit: commit.sha, files: changes.length, deleted: deletions.length };
}

async function pagesBuildStatus(env) {
  try {
    const builds = await ghJson(env, `/repos/${OWNER}/${REPO}/pages/builds`);
    return (builds && builds[0] && builds[0].status) || "unknown";
  } catch (e) {
    return "unavailable";
  }
}

async function runSync(env, topic) {
  const cfg = JSON.parse(await repoFile(env, "site-config.json"));
  const ref = await ghJson(env, `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  const headSha = ref.object.sha;
  const { treeSha, map } = await repoTree(env, headSha);
  const currentIndex = await repoFile(env, "index.html");
  const currentProducts = await repoFile(env, "data/products.js");
  const currentCount = (currentProducts.match(/"id":/g) || []).length;

  const products = await printifyAllProducts(env.PRINTIFY_TOKEN);
  const { entries, flagged } = buildEntries(products, cfg.featuredIds, cfg.excludedIds);

  // B-01: never let a transient failure shrink the live catalog.
  if (currentCount > 0 && entries.length < 0.8 * currentCount) {
    throw new Error(
      `catalog drop guard: ${entries.length} entries vs ${currentCount} current (>20% drop) — aborting`);
  }

  const files = generateFiles(entries, cfg, currentIndex);
  let result = await commitFiles(env, files, topic, map, headSha, treeSha);
  if (result.changed) {
    // B-31: the ref PATCH is inside commitFiles; a stale head surfaces as a
    // thrown error before this point only if GitHub rejects it — retry the
    // whole commit once from a fresh head in the caller-visible result.
    result.pagesBuild = await pagesBuildStatus(env);
    return { ...result, count: entries.length, flagged };
  }
  return { changed: false, count: entries.length, flagged };
}

async function runSyncWithRetry(env, topic) {
  try {
    return await runSync(env, topic);
  } catch (err) {
    // One retry from a fresh head covers the non-fast-forward race (B-31).
    console.error("sync attempt failed, retrying once:", String(err));
    return await runSync(env, topic);
  }
}

// ---------------------------------------------------------------- auth
function hexToBytes(hex) {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
  return out;
}

function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function secretMatches(given, secret) {
  if (!given || !secret) return false;
  const a = new TextEncoder().encode(String(given));
  const b = new TextEncoder().encode(String(secret));
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function authorized(request, url, env) {
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ") && secretMatches(auth.slice(7), env.WEBHOOK_SECRET)) {
    return true;
  }
  // ?key= fallback kept for one release (B-32); prefer the header.
  return secretMatches(url.searchParams.get("key") || "", env.WEBHOOK_SECRET);
}

// ---------------------------------------------------------------- handler
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isGetLike = request.method === "GET" || request.method === "HEAD";

    if (isGetLike && url.pathname === "/") {
      return new Response("paps-printify-sync ok", { status: 200 });
    }
    // Feed image proxy (2026-10-29): Pinterest's catalog fetcher gets
    // Error 1300 ("Unable to retrieve the image") from Printify's image
    // CDN under parallel load — the same 6 products failed every
    // ingestion while their URLs test fine one by one. Serve the
    // mockups through this Worker instead: edge-cached, so Pinterest
    // fetches from Cloudflare and Printify sees one origin fetch per
    // URL. Only /mockup/ image paths are proxied; nothing else on the
    // images-api host is reachable through this route.
    if (isGetLike && url.pathname.startsWith("/feed-img/mockup/")) {
      const origin = "https://images-api.printify.com" + url.pathname.slice("/feed-img".length);
      const upstream = await fetch(origin, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; paps-feed-img/1.0)" },
        cf: { cacheEverything: true, cacheTtl: 86400 },
      });
      if (!upstream.ok) return new Response("image unavailable", { status: 502 });
      const headers = new Headers(upstream.headers);
      headers.set("Cache-Control", "public, max-age=86400");
      headers.delete("set-cookie");
      return new Response(request.method === "HEAD" ? null : upstream.body, {
        status: 200, headers,
      });
    }
    if (isGetLike && url.pathname === "/health") {
      // B-51: public health is minimal; detail needs the secret.
      if (authorized(request, url, env)) {
        return Response.json({ ok: true, lastSync });
      }
      return Response.json({ ok: true });
    }
    if (request.method !== "POST") {
      const known = ["/", "/health", "/sync"].includes(url.pathname);
      return new Response("not found", { status: known ? 405 : 404 });
    }

    const raw = await request.text();

    // Manual trigger: POST /sync with Authorization: Bearer <secret>
    // (or the one-release ?key= fallback).
    if (url.pathname === "/sync") {
      if (!authorized(request, url, env)) {
        return new Response("unauthorized", { status: 401 });
      }
      try {
        const result = await runSyncWithRetry(env, "manual");
        lastSync = { at: new Date().toISOString(), result, topic: "manual" };
        return Response.json({ ok: true, result });
      } catch (err) {
        lastSync = { at: new Date().toISOString(), error: String(err), topic: "manual" };
        return Response.json({ ok: false, error: String(err) }, { status: 502 });
      }
    }

    // Printify webhook delivery.
    let payload = null;
    try { payload = JSON.parse(raw); } catch (e) { /* invalid JSON: no sync */ }
    const topic = payload && typeof payload.type === "string" ? payload.type : "unknown";

    if (env.WEBHOOK_SECRET) {
      const header = request.headers.get("x-pfy-signature") || "";
      const expectedHex = await hmacHex(env.WEBHOOK_SECRET, raw);
      const givenHex = header.replace(/^sha256=/, "");
      const match = timingSafeEqualBytes(hexToBytes(givenHex), hexToBytes(expectedHex));
      console.log(`webhook topic=${topic} signature_match=${match} header_present=${!!header}`);
      if ((env.SIGNATURE_MODE || "observe") === "enforce" && !match) {
        return new Response("bad signature", { status: 401 });
      }
    }

    // B-29: only allowlisted product events sync; everything else is a
    // 200 no-op so Printify does not retry it.
    if (!SYNC_TOPICS.has(topic)) {
      return Response.json({ ok: true, ignored: true, topic });
    }

    const now = Date.now();
    if (now - lastRunAt < 20000) {
      return Response.json({ ok: true, debounced: true, topic });
    }
    lastRunAt = now;
    ctx.waitUntil((async () => {
      try {
        const result = await runSyncWithRetry(env, topic);
        lastSync = { at: new Date().toISOString(), result, topic };
        console.log("sync done", JSON.stringify(result));
        if (RESYNC_TOPICS.has(topic)) {
          // B-29: publish/delete webhooks can arrive mid-lifecycle; verify
          // against settled state shortly after.
          await new Promise(r => setTimeout(r, 15000));
          const again = await runSyncWithRetry(env, topic + " (verify)");
          lastSync = { at: new Date().toISOString(), result: again, topic };
          console.log("verify sync done", JSON.stringify(again));
        }
      } catch (err) {
        lastSync = { at: new Date().toISOString(), error: String(err), topic };
        console.error("sync failed", String(err));
      }
    })());
    return Response.json({ ok: true, topic });
  },
};
