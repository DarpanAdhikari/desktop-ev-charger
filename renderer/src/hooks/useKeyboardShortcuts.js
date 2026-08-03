import { useEffect, useRef } from 'react';

function parseKeys(spec) {
  const parts = String(spec).toLowerCase().split('+');
  return {
    ctrl: parts.includes('ctrl') || parts.includes('meta') || parts.includes('cmd'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    key: parts[parts.length - 1],
  };
}

function matches(e, spec) {
  const s = parseKeys(spec);
  if (s.ctrl !== (e.ctrlKey || e.metaKey)) return false;
  if (s.shift !== e.shiftKey) return false;
  if (s.alt !== e.altKey) return false;
  return (e.key || '').toLowerCase() === s.key;
}

const ALWAYS_ACTIVE = new Set(['esc', 'ctrl+l', 'ctrl+k']);

export default function useKeyboardShortcuts(enabled = true) {
  const registry = useRef(new Map());

  const register = (spec, handler) => {
    registry.current.set(spec.toLowerCase(), handler);
  };

  const unregister = (spec) => {
    registry.current.delete(spec.toLowerCase());
  };

  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (e) => {
      const target = e.target;
      const typing = target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      const spec = [
        e.ctrlKey || e.metaKey ? 'ctrl' : null,
        e.shiftKey ? 'shift' : null,
        e.altKey ? 'alt' : null,
        (e.key || '').toLowerCase(),
      ].filter(Boolean).join('+');
      const handler = registry.current.get(spec);
      if (!handler) return;
      if (typing && !ALWAYS_ACTIVE.has(spec)) return;
      e.preventDefault();
      handler(e);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);

  return { register, unregister };
}
