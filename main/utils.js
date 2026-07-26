const WS_SCHEMES = ['ws:', 'wss:'];
const HTTP_SCHEMES = ['http:', 'https:'];

function checkUrlScheme(url, allowedSchemes, label) {
  if (!url || !url.trim()) return null;
  try {
    const parsed = new URL(url);
    if (!allowedSchemes.includes(parsed.protocol)) {
      return new Error(
        `${label} must use ${allowedSchemes.map((s) => s.replace(':', '')).join(' or ')} protocol, got "${parsed.protocol.replace(':', '')}"`
      );
    }
    return null;
  } catch (err) {
    return new Error(`${label} is not a valid URL: ${err.message}`);
  }
}

function validateWsUrl(url) {
  return checkUrlScheme(url, WS_SCHEMES, 'WebSocket URL');
}

function validateHttpUrl(url) {
  return checkUrlScheme(url, HTTP_SCHEMES, 'API URL');
}

module.exports = { validateWsUrl, validateHttpUrl };
