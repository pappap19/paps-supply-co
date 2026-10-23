// Pap's Supply Co Publisher — OAuth callback.
// Exchanges the authorization code for an access token (HTTP Basic auth
// with App ID + App secret, per Pinterest docs), looks up the account,
// and hands off to the connected page. The app secret comes from the
// one-time httpOnly cookie set by /api/setup (or env if configured);
// the access token lives only in a short-lived httpOnly cookie.
// Nothing is stored in a database or logged.
const APP_ID = process.env.PINTEREST_APP_ID || '1622191';
const REDIRECT_URI = process.env.PINTEREST_REDIRECT_URI ||
  'https://paps-supply-co-demo.vercel.app/api/callback';

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
  const url = new URL(req.url, 'https://placeholder.local');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookies = parseCookies(req);
  if (!code || !state || state !== cookies.pin_state) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<h1>OAuth error</h1><p>Missing or mismatched ' +
      'authorization response.</p>');
  }
  const appSecret = cookies.pin_secret || process.env.PINTEREST_APP_SECRET;
  if (!appSecret) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<h1>Setup needed</h1><p>The app secret has not ' +
      'been provided in this browser session. Go back to the home ' +
      'page and complete the one-time setup first.</p>');
  }
  const basic = Buffer.from(`${APP_ID}:${appSecret}`).toString('base64');
  const r = await fetch('https://api.pinterest.com/v5/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  const text = await r.text();
  if (r.status !== 200) {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<h1>Token exchange failed</h1><pre>' +
      esc(text) + '</pre>');
  }
  const token = JSON.parse(text).access_token;
  let username = '';
  const me = await fetch('https://api.pinterest.com/v5/user_account', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (me.status === 200) username = (await me.json()).username || '';
  res.setHeader('Set-Cookie', [
    `pin_token=${encodeURIComponent(token)}; HttpOnly; Path=/api; ` +
      'Max-Age=3600; SameSite=Lax; Secure',
    `pin_user=${encodeURIComponent(username)}; Path=/; Max-Age=3600; ` +
      'SameSite=Lax; Secure',
    // Clear the secret cookie — it has done its job. Also clear the
    // "ready" flag so the home page honestly shows the setup form again
    // on the next run instead of a stale "saved" banner.
    'pin_secret=; HttpOnly; Path=/api; Max-Age=0; SameSite=None; Secure',
    'pin_ready=; Path=/; Max-Age=0; SameSite=Lax; Secure',
  ]);
  res.writeHead(302, { Location: '/connected.html' });
  res.end();
};
