const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voltdesk', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getConnectionStatus: () => ipcRenderer.invoke('connection:getStatus'),

  listShifts: () => ipcRenderer.invoke('shifts:list'),
  upsertShift: (shift) => ipcRenderer.invoke('shifts:upsert', shift),
  deleteShift: (id) => ipcRenderer.invoke('shifts:delete', id),

  listChargers: () => ipcRenderer.invoke('chargers:list'),
  listLogs: (opts) => ipcRenderer.invoke('logs:list', opts),
  listBills: (opts) => ipcRenderer.invoke('bills:list', opts),
  printBill: (opts) => ipcRenderer.invoke('bills:print', opts),
  listPrinters: () => ipcRenderer.invoke('printers:list'),

  sendAction: (payload) => ipcRenderer.invoke('csms:action', payload),

  listTransactions: (opts) => ipcRenderer.invoke('transactions:list', opts),
  transactionsStats: (opts) => ipcRenderer.invoke('transactions:stats', opts),
  transactionsDaily: (opts) => ipcRenderer.invoke('transactions:daily', opts),
  exportCsv: (opts) => ipcRenderer.invoke('export:csv', opts),
  dbBackup: () => ipcRenderer.invoke('db:backup'),
  dbRestore: () => ipcRenderer.invoke('db:restore'),
  resetApp: (opts) => ipcRenderer.invoke('app:reset', opts),

  checkHealth: () => ipcRenderer.invoke('health:check'),

  onEvent: (callback) => {
    const listener = (_e, evt) => callback(evt);
    ipcRenderer.on('csms:event', listener);
    return () => ipcRenderer.removeListener('csms:event', listener);
  }
});
