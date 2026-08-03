import { useEffect, useMemo, useRef, useState } from 'react';
import { TYPE_COMMAND_PLACEHOLDER, NO_MATCHING_COMMANDS } from '../strings';

export default function CommandPalette({ open, onClose, actions }) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => `${a.label} ${a.keywords || ''}`.toLowerCase().includes(q));
  }, [actions, query]);

  useEffect(() => { setSel(0); }, [query]);

  const run = (action) => {
    onClose();
    if (action.run) action.run();
  };

  if (!open) return null;

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      const action = filtered[sel];
      if (action) run(action);
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={TYPE_COMMAND_PLACEHOLDER}
        />
        <div className="palette-list">
          {filtered.length === 0 && <div className="palette-empty">{NO_MATCHING_COMMANDS}</div>}
          {filtered.map((action, i) => (
            <button
              key={action.id}
              className={`palette-item${i === sel ? ' selected' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(action)}
            >
              <span className="palette-label">{action.label}</span>
              {action.shortcut && <span className="palette-shortcut">{action.shortcut}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
