const http = require('http');
const https = require('https');
const { validateHttpUrl } = require('../utils');
let db = require('../db/db');

let sender = null;
let loginInFlight = null;

function setDeps(custom) {
  if (custom && custom.db) db = custom.db;
  if (custom && custom.sender) sender = custom.sender;
}

function httpRequest(url, { method, headers, body, rejectUnauthorized }) {
  return new Promise((resolve, reject) => {
    const isHttps = String(url).startsWith('https:');
    const mod = isHttps ? https : http;
    const options = { method, headers };
    if (isHttps) options.rejectUnauthorized = rejectUnauthorized !== false;
    const req = mod.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function getLoginUrl(settings) {
  if (!settings.api_base_url || !settings.api_login_endpoint) return null;
  const url = settings.api_base_url.replace(/\/$/, '') + settings.api_login_endpoint;
  const err = validateHttpUrl(url);
  if (err) return null;
  return url;
}

// Credentials are only available when the operator configured them.
function hasCredentials(settings) {
  return Boolean(settings.api_username && settings.api_password);
}

// Extract a token and its expiry from a login response, whatever its shape.
function parseLoginResponse(body) {
  let parsed = null;
  try { parsed = JSON.parse(body); } catch (e) { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const root = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
  const token = root.access_token || root.token || root.jwt || null;
  if (!token) return null;
  let expiresAt = null;
  const now = Date.now();
  if (Number.isFinite(Number(root.expires_in))) {
    expiresAt = new Date(now + Number(root.expires_in) * 1000).toISOString();
  } else if (Number.isFinite(Number(root.token_lifetime))) {
    expiresAt = new Date(now + Number(root.token_lifetime) * 1000).toISOString();
  } else if (root.expires_at) {
    const t = Date.parse(root.expires_at);
    if (Number.isFinite(t)) expiresAt = new Date(t).toISOString();
  }
  return { token, expiresAt };
}

function isTokenValid(settings) {
  if (!settings.api_token) return false;
  if (!settings.api_token_expires_at) return true; // no expiry known: trust until 401
  const t = Date.parse(settings.api_token_expires_at);
  if (!Number.isFinite(t)) return true;
  // Refresh a little early so the token never expires mid-request.
  return t > Date.now() + 30000;
}

function storeToken(token, expiresAt) {
  db.setSettings({
    api_token: token || '',
    api_token_expires_at: expiresAt || ''
  });
}

function clearToken() {
  storeToken(null, null);
}

async function login() {
  const settings = db.getSettings();
  const url = getLoginUrl(settings);
  if (!url || !hasCredentials(settings)) return null;
  const send = sender || ((u, opts) => httpRequest(u, opts));
  try {
    const res = await send(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.api_key ? { Authorization: `Bearer ${settings.api_key}` } : {})
      },
      body: JSON.stringify({ username: settings.api_username, password: settings.api_password }),
      rejectUnauthorized: settings.skip_ssl_verify !== '1'
    });
    if (res.statusCode < 200 || res.statusCode >= 300) return null;
    const parsed = parseLoginResponse(res.body);
    if (!parsed) return null;
    storeToken(parsed.token, parsed.expiresAt);
    return parsed.token;
  } catch (e) {
    return null;
  }
}

// Returns a usable token: cached if still valid, otherwise a fresh login.
async function getToken() {
  const settings = db.getSettings();
  if (isTokenValid(settings)) return settings.api_token;
  if (loginInFlight) return loginInFlight;
  loginInFlight = login().finally(() => { loginInFlight = null; });
  return loginInFlight;
}

// Best-effort Authorization header: login token when present, else static key.
async function authHeaders(extra = {}) {
  const settings = db.getSettings();
  const headers = { ...extra };
  const token = await getToken();
  const secret = token || settings.api_key;
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return headers;
}

module.exports = {
  setDeps,
  getToken,
  login,
  clearToken,
  authHeaders,
  parseLoginResponse,
  isTokenValid,
  _httpRequest: httpRequest
};
