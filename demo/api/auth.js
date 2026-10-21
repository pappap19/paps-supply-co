// Pap's Supply Co Publisher — OAuth start.
// Redirects the user to Pinterest's OAuth consent screen.
// App ID and redirect URI are public values (not secrets), so they
// live in code with env overrides. The app SECRET is never here —
// it arrives via a one-time httpOnly cookie set by /api/setup.
const crypto = require('crypto');

const APP_ID = process.env.PINTEREST_APP_ID || '1622191';
const REDIRECT_URI = process.env.PINTEREST_REDIRECT_URI ||
  'https://paps-supply-co-demo.vercel.app/api/callback';

module.exports = (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'boards:read,boards:write,pins:read,pins:write,user_accounts:read',
    state,
  });
  res.setHeader('Set-Cookie',
    `pin_state=${state}; HttpOnly; Path=/api; Max-Age=600; SameSite=Lax; Secure`);
  res.writeHead(302, {
    Location: `https://www.pinterest.com/oauth/?${params}`,
  });
  res.end();
};
