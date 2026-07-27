import { useState, useEffect, useCallback, useRef } from 'react';
import * as ipc from '../services/ipc';

export function useChargers() {
  const [chargers, setChargers] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await ipc.listChargers();
      setChargers(data);
    } catch (e) {
      console.error('Failed to load chargers:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  return { chargers, loading, refresh };
}

export function useBills() {
  const [bills, setBills] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (limit) => {
    try {
      const data = await ipc.listBills({ limit });
      setBills(data);
    } catch (e) {
      console.error('Failed to load bills:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  return { bills, loading, refresh };
}

export function useLogs() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (opts) => {
    setLoading(true);
    try {
      const data = await ipc.listLogs(opts);
      setLogs(data.rows || []);
      setTotal(data.total || 0);
    } catch (e) {
      console.error('Failed to load logs:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  return { logs, total, loading, refresh };
}

export function useSettings() {
  const [settings, setSettings] = useState(null);
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [s, sh] = await Promise.all([ipc.getSettings(), ipc.listShifts()]);
      setSettings(s);
      setShifts(sh);
    } catch (e) {
      console.error('Failed to load settings:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const saveSettings = useCallback(async (patch) => {
    const updated = await ipc.setSettings(patch);
    setSettings(updated);
    return updated;
  }, []);

  const saveShift = useCallback(async (shift) => {
    const updated = await ipc.upsertShift(shift);
    setShifts(updated);
    return updated;
  }, []);

  const removeShift = useCallback(async (id) => {
    const updated = await ipc.deleteShift(id);
    setShifts(updated);
    return updated;
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  return { settings, shifts, loading, refresh, saveSettings, saveShift, removeShift };
}

export function useConnectionStatus() {
  const [status, setStatus] = useState({ connected: false, connecting: false, url: '', health: null });

  useEffect(() => {
    let alive = true;
    ipc.getConnectionStatus()
      .then((current) => {
        if (alive && current) setStatus((prev) => ({ ...prev, ...current }));
      })
      .catch((e) => console.error('Failed to load connection status:', e));

    const unsub = ipc.onEvent((evt) => {
      if (evt.type === 'connection_status') {
        setStatus((prev) => ({
          ...prev,
          connected: evt.status === 'connected',
          connecting: evt.status === 'connecting',
          url: evt.url || '',
          error: evt.status === 'error' ? evt.error : null,
        }));
      }
      if (evt.type === 'health_status') {
        setStatus((prev) => ({ ...prev, health: evt }));
      }
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  return status;
}

export function useToast() {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const addToast = useCallback((message, type = 'info') => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  return { toasts, addToast };
}

export function useLiveEvents({ onChargerEvent, onBillingEvent, onLogEvent } = {}) {
  useEffect(() => {
    const unsub = ipc.onEvent((evt) => {
      if (evt.type === 'connection_status') return;
      if (onChargerEvent) onChargerEvent(evt);
      if (onBillingEvent && (evt.type === 'bill_generated' || evt.type === 'bill_error')) {
        onBillingEvent(evt);
      }
      if (onLogEvent) onLogEvent(evt);
    });
    return unsub;
  }, [onChargerEvent, onBillingEvent, onLogEvent]);
}
