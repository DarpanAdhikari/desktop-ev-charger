export function formatDuration(sec) {
  const s = Number(sec) || 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatMin(min) {
  const n = Number(min) || 0;
  if (n < 60) return `${n}m`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return `${h}h ${m}m`;
}

export function formatRate(value, unit) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return `${num.toFixed(unit === 'kW' ? 1 : 2)} ${unit}`;
}

export function formatCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return `$${num.toFixed(2)}`;
}

export function formatNullable(value, unit) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  const precision = unit === '%' ? 0 : 2;
  return `${num.toFixed(precision)} ${unit}`;
}

export function formatTimeAgo(ts) {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))
  ]);
}

export function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: mime });
}

export function statusColor(status) {
  switch ((status || '').toLowerCase()) {
    case 'charging': return 'var(--amber)';
    case 'available': return 'var(--teal)';
    case 'faulted':
    case 'error': return 'var(--red)';
    case 'preparing':
    case 'finishing': return 'var(--blue)';
    default: return 'var(--slate)';
  }
}

export function statusDotClass(status, meter) {
  const isLiveCharging = Number(meter?.power_kw ?? meter?.rate_kw) > 0;
  switch (isLiveCharging ? 'charging' : (status || '').toLowerCase()) {
    case 'charging': return 'dot-charging';
    case 'available': return 'dot-available';
    case 'faulted':
    case 'error': return 'dot-faulted';
    default: return 'dot-other';
  }
}
