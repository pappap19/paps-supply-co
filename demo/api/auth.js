// Pap's Supply Co Publisher — OAuth start.
// Redirects the user to Pinterest's OAuth consent screen.
const crypto = require('crypto');

module.exports = (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: process.env.PINTEREST_APP_ID,
    redirect_uri: process.env.PINTEREST_REDIRECT_URI,
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
