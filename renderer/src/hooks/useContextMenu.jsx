import { createContext, useCallback, useContext, useEffect, useState } from 'react';

const ContextMenuContext = createContext(null);

export function useContextMenu() {
  return useContext(ContextMenuContext);
}

export function ContextMenuProvider({ children }) {
  const [menu, setMenu] = useState(null);

  const openMenu = useCallback((e, items) => {
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (!menu) return undefined;
    const onGlobalClick = () => setMenu(null);
    const onScroll = () => setMenu(null);
    const onKey = (e) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('mousedown', onGlobalClick);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onGlobalClick);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  return (
    <ContextMenuContext.Provider value={{ menu, openMenu, closeMenu }}>
      {children}
    </ContextMenuContext.Provider>
  );
}
