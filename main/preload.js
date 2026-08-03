const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voltdesk', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  verifyPassword: (password) => ipcRenderer.invoke('security:verify', password),
  clipboardCopy: () => ipcRenderer.invoke('clipboard:copy'),
  clipboardPaste: () => ipcRenderer.invoke('clipboard:paste'),
  clipboardCut: () => ipcRenderer.invoke('clipboard:cut'),
  clipboardSelectAll: () => ipcRenderer.invoke('clipboard:selectAll'),
  shareSaveImage: (opts) => ipcRenderer.invoke('share:saveImage', opts),
  shareReveal: (filePath) => ipcRenderer.invoke('share:reveal', filePath),
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
  testPrinter: (opts) => ipcRenderer.invoke('printers:test', opts),

  bluetoothScan: () => ipcRenderer.invoke('bluetooth:scan'),
  bluetoothConnect: (address) => ipcRenderer.invoke('bluetooth:connect', address),
  bluetoothDisconnect: (address) => ipcRenderer.invoke('bluetooth:disconnect', address),
  bluetoothList: () => ipcRenderer.invoke('bluetooth:list'),
  bluetoothTest: (address) => ipcRenderer.invoke('bluetooth:test', address),

  sendAction: (payload) => ipcRenderer.invoke('csms:action', payload),

  forceCloseSession: (txId) => ipcRenderer.invoke('sessions:forceClose', txId),
  retryBilling: (txId) => ipcRenderer.invoke('sessions:retryBilling', txId),
  listAttention: () => ipcRenderer.invoke('sessions:attention'),

  listTransactions: (opts) => ipcRenderer.invoke('transactions:list', opts),
  transactionsStats: (opts) => ipcRenderer.invoke('transactions:stats', opts),
  transactionsDaily: (opts) => ipcRenderer.invoke('transactions:daily', opts),
  exportCsv: (opts) => ipcRenderer.invoke('export:csv', opts),
  exportAllLogs: (opts) => ipcRenderer.invoke('logs:exportAll', opts),
  dbBackup: () => ipcRenderer.invoke('db:backup'),
  dbRestore: () => ipcRenderer.invoke('db:restore'),
  resetApp: (opts) => ipcRenderer.invoke('app:reset', opts),

  getSyncStatus: () => ipcRenderer.invoke('sync:status'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  checkHealth: () => ipcRenderer.invoke('health:check'),
  pickImage: () => ipcRenderer.invoke('image:pick'),
  searchCustomers: (query) => ipcRenderer.invoke('customer:search', query),
  fetchCompanyInfo: () => ipcRenderer.invoke('company:info'),
  fetchBillDetails: (billNumber) => ipcRenderer.invoke('bill:details', billNumber),

  onEvent: (callback) => {
    const listener = (_e, evt) => callback(evt);
    ipcRenderer.on('csms:event', listener);
    return () => ipcRenderer.removeListener('csms:event', listener);
  }
});
