// Pap's Supply Co Publisher — one-time secret setup.
// Stores the app secret ONLY in a short-lived httpOnly cookie in the
// owner's own browser (15 minutes), so the OAuth callback can use it.
// The secret is never written to disk, a database, or a log anywhere.
module.exports = (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    return res.end('Method not allowed');
  }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const secret = (new URLSearchParams(body).get('app_secret') || '').trim();
    if (!secret) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>Missing secret</h1><p>Go back and paste ' +
        'the app secret key.</p>');
    }
    res.setHeader('Set-Cookie', [
      `pin_secret=${encodeURIComponent(secret)}; HttpOnly; Path=/api; ` +
        'Max-Age=900; SameSite=Lax; Secure',
      'pin_ready=1; Path=/; Max-Age=900; SameSite=Lax; Secure',
    ]);
    res.writeHead(302, { Location: '/' });
    res.end();
  });
};
