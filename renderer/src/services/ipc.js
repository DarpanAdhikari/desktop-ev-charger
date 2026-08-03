const api = window.voltdesk;

export function getSettings() {
  return api.getSettings();
}

export function setSettings(patch) {
  return api.setSettings(patch);
}

export function verifyPassword(password) {
  return api.verifyPassword(password);
}

export function clipboardCopy() {
  return api.clipboardCopy();
}

export function clipboardPaste() {
  return api.clipboardPaste();
}

export function clipboardCut() {
  return api.clipboardCut();
}

export function clipboardSelectAll() {
  return api.clipboardSelectAll();
}

export function shareSaveImage(opts) {
  return api.shareSaveImage(opts);
}

export function shareReveal(filePath) {
  return api.shareReveal(filePath);
}

export function getConnectionStatus() {
  return api.getConnectionStatus();
}

export function listShifts() {
  return api.listShifts();
}

export function upsertShift(shift) {
  return api.upsertShift(shift);
}

export function deleteShift(id) {
  return api.deleteShift(id);
}

export function listChargers() {
  return api.listChargers();
}

export function listLogs(opts) {
  return api.listLogs(opts);
}

export function listBills(opts) {
  return api.listBills(opts);
}

export function printBill(opts) {
  return api.printBill(opts);
}

export function generateBillPdf(billId) {
  return api.generateBillPdf(billId);
}

export function generateBillImage(billId) {
  return api.generateBillImage(billId);
}

export function getBillPreview(billId) {
  return api.getBillPreview(billId);
}

export function sendAction(payload) {
  return api.sendAction(payload);
}

export function forceCloseSession(txId) {
  return api.forceCloseSession(txId);
}

export function retryBilling(txId) {
  return api.retryBilling(txId);
}

export function listAttention() {
  return api.listAttention();
}

export function onEvent(callback) {
  return api.onEvent(callback);
}

export function listPrinters() {
  return api.listPrinters();
}

export function testPrinter(opts) {
  return api.testPrinter(opts);
}

export function bluetoothScan() { return api.bluetoothScan(); }
export function bluetoothConnect(address) { return api.bluetoothConnect(address); }
export function bluetoothDisconnect(address) { return api.bluetoothDisconnect(address); }
export function bluetoothList() { return api.bluetoothList(); }
export function bluetoothTest(address) { return api.bluetoothTest(address); }

export function listTransactions(opts) {
  return api.listTransactions(opts);
}

export function transactionsStats(opts) {
  return api.transactionsStats(opts);
}

export function transactionsDaily(opts) {
  return api.transactionsDaily(opts);
}

export function exportCsv(opts) {
  return api.exportCsv(opts);
}

export function exportAllLogs(opts) {
  return api.exportAllLogs(opts);
}

export function dbBackup() {
  return api.dbBackup();
}

export function dbRestore() {
  return api.dbRestore();
}

export function resetApp(opts) {
  return api.resetApp(opts);
}

export function getSyncStatus() {
  return api.getSyncStatus();
}

export function syncNow() {
  return api.syncNow();
}

export function checkHealth() {
  return api.checkHealth();
}

export function pickImage() {
  return api.pickImage();
}

export function searchCustomers(query) {
  return api.searchCustomers(query);
}

export function fetchCompanyInfo() {
  return api.fetchCompanyInfo();
}
