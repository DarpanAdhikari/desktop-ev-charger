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
  generateBillPdf: (billId) => ipcRenderer.invoke('bill:generatePdf', { billId }),
  generateBillImage: (billId) => ipcRenderer.invoke('bill:generateImage', billId),
  getBillPreview: (billId) => ipcRenderer.invoke('bill:previewHtml', billId),
  listPrinters: () => ipcRenderer.invoke('printers:list'),
  listComPorts: () => ipcRenderer.invoke('printers:listCom'),
  testPrinter: (opts) => ipcRenderer.invoke('printers:test', opts),

  bluetoothScan: () => ipcRenderer.invoke('bluetooth:scan'),
  bluetoothConnect: (address) => ipcRenderer.invoke('bluetooth:connect', address),
  bluetoothDisconnect: (address) => ipcRenderer.invoke('bluetooth:disconnect', address),
  bluetoothList: () => ipcRenderer.invoke('bluetooth:list'),
  bluetoothTest: (address) => ipcRenderer.invoke('bluetooth:test', address),

  sendAction: (payload) => ipcRenderer.invoke('csms:action', payload),

  listTransactions: (opts) => ipcRenderer.invoke('transactions:list', opts),
  transactionsStats: (opts) => ipcRenderer.invoke('transactions:stats', opts),
  transactionsDaily: (opts) => ipcRenderer.invoke('transactions:daily', opts),
  exportCsv: (opts) => ipcRenderer.invoke('export:csv', opts),
  dbBackup: () => ipcRenderer.invoke('db:backup'),
  dbRestore: () => ipcRenderer.invoke('db:restore'),
  resetApp: (opts) => ipcRenderer.invoke('app:reset', opts),

  checkHealth: () => ipcRenderer.invoke('health:check'),
  pickImage: () => ipcRenderer.invoke('image:pick'),
  searchCustomers: (query) => ipcRenderer.invoke('customer:search', query),
  fetchCompanyInfo: () => ipcRenderer.invoke('company:info'),
  fetchBillTemplate: () => ipcRenderer.invoke('bill:fetchTemplate'),

  onEvent: (callback) => {
    const listener = (_e, evt) => callback(evt);
    ipcRenderer.on('csms:event', listener);
    return () => ipcRenderer.removeListener('csms:event', listener);
  }
});
