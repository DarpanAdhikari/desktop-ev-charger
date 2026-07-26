const { BrowserWindow } = require('electron');
const db = require('../db/db');

// Renders a bill to a hidden window and prints it. `deviceName` lets the
// user pick a specific system printer from Settings; omit for the OS default.
function printBill(bill, html, deviceName) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    win.webContents.on('did-finish-load', () => {
      win.webContents.print(
        {
          silent: true,
          printBackground: true,
          deviceName: deviceName || undefined
        },
        (success, failureReason) => {
          const raw = db.raw;
          raw
            .prepare(
              success
                ? 'UPDATE bills SET print_success_count = print_success_count + 1 WHERE id = ?'
                : 'UPDATE bills SET print_fail_count = print_fail_count + 1 WHERE id = ?'
            )
            .run(bill.id);
          win.destroy();
          resolve({ success, failureReason: failureReason || null });
        }
      );
    });
  });
}

module.exports = { printBill };
