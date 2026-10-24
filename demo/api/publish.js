// Pap's Supply Co Publisher — live API action.
// GET /v5/boards, then POST /v5/pins creating a pin for a real product.
const CSS = `
body { font-family: Georgia, serif; max-width: 760px; margin: 48px auto;
       padding: 0 24px; color: #1c1c22; line-height: 1.6; background:#faf8f5; }
h1 { font-size: 2em; border-bottom: 2px solid #333; padding-bottom: 10px; }
pre { background: #14141a; color: #d8f3dc; padding: 16px; border-radius: 8px;
      overflow-x: auto; font-size: 0.85em; white-space: pre-wrap; }
.note { color: #555; font-size: 0.95em; }
code { background: #eee; padding: 1px 5px; border-radius: 4px; }`;

const DEMO = {
  image: 'https://papssupplyco.com/demo-pin.jpg',
  link: 'https://www.redbubble.com/shop/ap/184919145',
  title: 'Goth Stocking Sticker — Black Velvet Skull Christmas Decal',
  desc: "His stocking comes pre-stuffed with skulls — a black velvet " +
    'Christmas stocking overflowing with cute skulls, tiny bats and ' +
    'black roses, trimmed with spiderweb lace. Die-cut sticker from ' +
    "Pap's Supply Co.",
};

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] =
      decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

module.exports = async (req, res) => {
  const token = parseCookies(req).pin_token;
  if (!token) {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  // Trial access: everything runs on the API Sandbox host with a
  // sandbox-minted OAuth token (see api/callback.js). Production pin
  // creation is rejected for Trial apps (HTTP 403 code 29).
  const SAND = 'https://api-sandbox.pinterest.com/v5';
  const steps = [];
  async function getBoards(base, label) {
    const r = await fetch(`${base}/boards?page_size=100`, { headers });
    const t = await r.text();
    steps.push([`GET /v5/boards (${label})`, r.status, t.slice(0, 1200)]);
    if (r.status !== 200) return [];
    try { return JSON.parse(t).items || []; } catch { return []; }
  }
  let boardId = '', boardName = '';
  const sandBoards = await getBoards(SAND, 'sandbox');
  const pickS = sandBoards.find(b => b.name === 'Holiday Shop') ||
    sandBoards[0];
  if (pickS) { boardId = pickS.id; boardName = pickS.name || ''; }
  if (!boardId) {
    // No sandbox board yet — create one in the sandbox.
    const cb = await fetch(`${SAND}/boards`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Holiday Shop',
        description: "Pap's Supply Co product pins (API demo board).",
        privacy: 'PUBLIC',
      }),
    });
    const cbText = await cb.text();
    steps.push(['POST /v5/boards (sandbox)', cb.status,
      cbText.slice(0, 800)]);
    if (cb.status === 200 || cb.status === 201) {
      try {
        const b = JSON.parse(cbText);
        boardId = b.id || ''; boardName = b.name || 'Holiday Shop';
      } catch { /* fall through */ }
    }
  }
  let result = '';
  if (boardId) {
    const pinRes = await fetch(`${SAND}/pins`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        board_id: boardId,
        title: DEMO.title,
        description: DEMO.desc,
        link: DEMO.link,
        media_source: { source_type: 'image_url', url: DEMO.image },
      }),
    });
    const pinText = await pinRes.text();
    steps.push(['POST /v5/pins (sandbox)', pinRes.status,
      pinText.slice(0, 1600)]);
    if (pinRes.status === 200 || pinRes.status === 201) {
      const pid = JSON.parse(pinText).id || '';
      result = `<p>🎉 <strong>Pin created via the API</strong> on board ` +
        `“${esc(boardName)}”.<br>Pin ID: <code>${esc(pid)}</code></p>`;
    } else {
      result = '<p>⚠️ The pin call returned an error — full response ' +
        'below.</p>';
    }
  } else {
    result = '<p>⚠️ No board was returned, so no pin was created.</p>';
  }
  const log = steps.map(
    ([n, s, t]) => `--- ${n} → HTTP ${s}\n${t}`).join('\n\n');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<title>Publish result — Pap's Supply Co Publisher</title>` +
    `<style>${CSS}</style></head><body>` +
    `<h1>Live API result</h1>${result}<pre>${esc(log)}</pre>` +
    `<p class="note">This app is on Trial access, so the OAuth token ` +
    `exchange and all API calls run on Pinterest's API Sandbox ` +
    `host (api-sandbox.pinterest.com), exactly as Pinterest ` +
    `directs Trial apps. Access token is held only in a ` +
    `short-lived httpOnly session cookie and is never stored ` +
    `or logged.</p>` +
    `</body></html>`);
};
