import { useState, useRef } from 'react';
import logoUrl from '../../../assets/logo/logo.png';

export default function PinLock({ onUnlock }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  const handleSubmit = () => {
    onUnlock(value)
      .then((ok) => {
        if (ok) { setValue(''); setError(''); }
        else { setError('Incorrect PIN'); setValue(''); inputRef.current?.focus(); }
      })
      .catch(() => { setError('Error validating PIN'); setValue(''); });
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'var(--bg-primary)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 24,
    }}>
      <img src={logoUrl} alt="DRP logo" style={{ width: 64, height: 64, objectFit: 'contain' }} />
      <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 24 }}>DRP</h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: -18 }}>Dynamic Recharge Platform</p>
      <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Enter PIN to unlock</p>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => { setValue(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
          style={{
            width: 160, textAlign: 'center', fontSize: 24, letterSpacing: 8,
            background: 'var(--bg-raised)', border: `1px solid ${error ? 'var(--red)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-sm)', padding: '12px 16px',
            color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace",
            outline: 'none',
          }}
          placeholder="······"
          autoFocus
          maxLength={6}
          inputMode="numeric"
        />
        {error && <span style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span>}
        <button className="btn primary" onClick={handleSubmit} style={{ width: 160 }}>
          Unlock
        </button>
      </div>
    </div>
  );
}
