import { useState, useRef } from 'react';
import staticLogoUrl from '../../../assets/logo/logo.png';
import { UNLOCK_PROMPT, UNLOCK_LABEL, INCORRECT_PASSWORD, ERROR_VALIDATING_PASSWORD, PASSWORD_PLACEHOLDER, CANCEL } from '../strings';

export default function PinLock({
  onSubmit,
  onCancel,
  brandingLogo,
  prompt = UNLOCK_PROMPT,
  buttonLabel = UNLOCK_LABEL,
  incorrectText = INCORRECT_PASSWORD,
}) {
  const logoUrl = brandingLogo || staticLogoUrl;
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  const handleSubmit = () => {
    onSubmit(value)
      .then((ok) => {
        if (ok) { setValue(''); setError(''); }
        else { setError(incorrectText); setValue(''); inputRef.current?.focus(); }
      })
      .catch(() => { setError(ERROR_VALIDATING_PASSWORD); setValue(''); });
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
      <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>{prompt}</p>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
          style={{
            width: 220, textAlign: 'center', fontSize: 16, letterSpacing: 2,
            background: 'var(--bg-raised)', border: `1px solid ${error ? 'var(--red)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-sm)', padding: '12px 16px',
            color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace",
            outline: 'none',
          }}
          placeholder={PASSWORD_PLACEHOLDER}
          autoFocus
          maxLength={64}
        />
        {error && <span style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span>}
        <button className="btn primary" onClick={handleSubmit} style={{ width: 220 }}>
          {buttonLabel}
        </button>
        {onCancel && (
          <button className="btn ghost" onClick={onCancel} style={{ width: 220 }}>
            {CANCEL}
          </button>
        )}
      </div>
    </div>
  );
}
