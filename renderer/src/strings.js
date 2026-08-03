// Single source of truth for user-facing copy. Import from here instead of
// inlining strings so every surface stays identical.

// ---------- Attention / force-close ----------
export const ATTENTION_ACTION = 'Verify the connector, then close the session using recent log data if needed.';
export const ATTENTION_HEADING = 'Sessions needing attention';
export const ATTENTION_BANNER_TITLE = 'Attention';
export const FORCE_CLOSE_LABEL = 'Force Close';
export const FORCE_CLOSE_TITLE = 'Force Close Session';
export const CLOSE_SESSION_LABEL = 'Close session';
export const CLOSING_LABEL = 'Closing...';
export const CANCEL_LABEL = 'Cancel';

export function humanReason(reason) {
  switch (reason) {
    case 'connector_offline': return 'the connector seems offline';
    case 'connector_fault': return 'the connector reported a fault';
    case 'resumed_after_outage': return 'the session resumed after a power loss';
    case 'missing_soc': return 'the stop summary was missing SoC data';
    case 'server_session_closed': return 'the server closed the session';
    case 'force_closed': return 'closed by operator';
    default: return reason || 'unknown reason';
  }
}

export function attentionMessage(reason) {
  return `${humanReason(reason)} \u2014 ${ATTENTION_ACTION}`;
}

export const ATTENTION_MODAL_COPY =
  'The connector of this charger seems to be having issues (offline / fault / power loss). ' +
  'Close the session using the most recent log data? A bill will be generated from the ' +
  'last known readings, and a STOP command will be sent in case the charger is still live.';

export function sessionAttentionText(reason) {
  return attentionMessage(reason);
}

export function sessionNeedsAttentionItem(tx) {
  return tx.status === 'active'
    ? `Session ${tx.ocpp_tx_id || tx.id} \u2014 ${humanReason(tx.flag_reason)}`
    : `Session ${tx.ocpp_tx_id || tx.id} stopped but not billed${tx.flag_reason ? ` \u2014 ${humanReason(tx.flag_reason)}` : ''}`;
}

export function sessionClosedToast(tx) {
  return `Session ${tx.ocpp_tx_id || tx.id} closed using recent log data`;
}

export const FORCE_CLOSE_FAILED = (reason) => `Force close failed: ${reasonText(reason)}`;
export const FORCE_CLOSE_ERROR = (message) => `Force close error: ${message}`;
export const BILLING_RETRY_FAILED = (reason) => `Billing retry failed: ${reasonText(reason)}`;
export const BILLING_RETRY_ERROR = (message) => `Billing retry error: ${message}`;
export const RETRY_BILLING_LABEL = 'Retry billing';

// ---------- Reason codes -> human text ----------
const REASON_TEXT = {
  bill_not_found: 'bill not found',
  no_active_transaction: 'no active transaction on this connector',
  transaction_active: 'a transaction is already active on this connector',
  unknown_connector: 'unknown connector',
  already_billed: 'already billed',
  not_active: 'the session is not active',
  not_stopped: 'the session has not been stopped',
  already_closed: 'the session is already closed',
  transaction_not_found: 'transaction not found',
  pin_not_configured: 'no password is set',
  invalid_pin: 'incorrect password',
  not_configured: 'not configured',
  no_data: 'no data available',
  canceled: 'canceled',
};

export function reasonText(reason) {
  if (reason == null) return 'unknown';
  if (typeof reason !== 'string') return String(reason);
  const known = REASON_TEXT[reason];
  if (known) return known;
  const connectorMatch = reason.match(/^connector_(.+)$/i);
  if (connectorMatch) return `the connector is ${connectorMatch[1].toLowerCase()}`;
  return reason;
}

// ---------- Commands ----------
export const START_LABEL = 'Start';
export const STOP_LABEL = 'Stop';
export const SENDING_LABEL = 'Sending...';
export const SELECT_CUSTOMER_FIRST = 'Select customer first';
export const START_CHARGING = 'Start charging';
export const STOP_CHARGING = 'Stop charging';
export const NO_ACTIONS_AVAILABLE = 'No actions available';
export const CONNECTOR_START = (n) => `Connector ${n}: Start`;
export const CONNECTOR_STOP = (n) => `Connector ${n}: Stop`;
export const OPEN_CHARGER = (id) => `Open ${id}`;
export const COMMAND_ACKNOWLEDGED = (command) => `${command} acknowledged by server`;
export const REMOTE_COMMAND_SENT = (command) => `Remote ${command} command sent to charger`;
export const COMMAND_ACCEPTED = (command, chargerId, connectorId) => `${command} Accepted for charger ${chargerId} connector ${connectorId}`;
export const COMMAND_RESULT = (command, status) => `${command} result: ${status}`;

export function commandSentText(command, chargerId, connectorId) {
  return `${command} command sent to ${chargerId} connector ${connectorId}`;
}

export function commandQueuedText(command) {
  return `${command} queued \u2014 will send when the connection is back`;
}

export function commandQueuedDeliveredText(command) {
  return `Queued ${command} command delivered`;
}

export function commandRejectedText(command, reason) {
  return `${command} rejected: ${reasonText(reason)}`;
}

export function failedToSendText(action, message) {
  return `Failed to send ${action}: ${message}`;
}

export function chargeCompleteText(chargerId, connectorId) {
  return `Charger ${chargerId} connector ${connectorId} finished charging`;
}

export function chargerFaultText(chargerId, error) {
  return `Charger ${chargerId} fault${error ? ': ' + error : ''}`;
}

export function connectorChargeCompleteText(connectorId) {
  return `Connector ${connectorId} finished charging`;
}

export function connectorFaultText(connectorId, error) {
  return `Connector ${connectorId} fault${error ? ': ' + error : ''}`;
}

export function offlineConnectorsText(count) {
  return `${count} connector(s) offline`;
}

// ---------- Session events ----------
export function attentionToastText(chargerId, connectorId, reason) {
  return `Attention: charger ${chargerId} connector ${connectorId} \u2014 ${attentionMessage(reason)}`;
}

export function sessionRecoveredText(chargerId, reason, bill) {
  return `Session on charger ${chargerId} was closed while the app was offline (${humanReason(reason)})${bill ? ` \u2014 ${billGeneratedText(bill)}` : ''}`;
}

export function sessionClosedText(chargerId, connectorId, bill) {
  return `Session closed on charger ${chargerId} connector ${connectorId}${bill ? ` \u2014 ${billGeneratedText(bill)}` : ''}`;
}

// ---------- Bills ----------
export function billGeneratedText(bill) {
  return `Bill #${bill?.bill_number || bill?.id} generated`;
}

export function billGeneratedWithTotalText(bill) {
  return `${billGeneratedText(bill)} \u2014 $${(bill?.total || 0).toFixed(2)}`;
}

export const BILL_GENERATION_FAILED = (error) => `Bill generation failed: ${error}`;
export const BILL_ERROR = (reason) => `Bill error: ${reasonText(reason)}`;

export function billEventDetailText(p) {
  return `${billGeneratedText(p.bill || {})} ($${(p.bill?.total || 0).toFixed(2)})`;
}

// ---------- Printing ----------
export const PRINTED_SUCCESS = (billNumber) => `Bill #${billNumber} printed successfully`;
export const PRINT_FAILED = (reason) => `Print failed: ${reasonText(reason)}`;
export const PRINT_ERROR = (message) => `Print error: ${message}`;
export const TEST_PAGE_SENT = 'Test page sent to printer';
export const TEST_FAILED = (result) => `Test failed: ${reasonText(result?.reason || result?.failureReason)}`;
export const PRINT_LABEL = 'Print';
export const TEST_PRINT_LABEL = 'Test Print';
export const DEFAULT_PRINTER_LABEL = '\u2014 Default printer \u2014';

// ---------- PDF / image / share ----------
export const IMAGE_TIMED_OUT = 'Image generation timed out';
export const IMAGE_FAILED = (reason) => `Image failed: ${reasonText(reason)}`;
export const IMAGE_COPIED = 'Invoice image copied to clipboard';
export const IMAGE_COPY_FAILED = 'Failed to copy image to clipboard';
export const PDF_SAVED = (name) => `PDF saved as ${name}`;
export const PDF_FAILED = (reason) => `PDF failed: ${reasonText(reason)}`;
export const SAVE_FAILED = (reason) => `Save failed: ${reasonText(reason)}`;
export const SAVED_TO = (path) => `Saved to ${path}`;
export const SHARE_TITLE = 'Share Invoice';
export const SHARE_HINT = 'Desktop Electron has no OS share sheet \u2014 share the invoice image via clipboard or file.';
export const PREPARING_IMAGE = 'Preparing image...';
export const COPY_IMAGE = 'Copy image';
export const SHOW_IN_FOLDER = 'Show in folder';
export const CLOSE_LABEL = 'Close';
export const DOWNLOAD_PDF = 'Download PDF';
export const COPY_LABEL = 'Copy';
export const SHARE_LABEL = 'Share';
export const OPEN_DETAILS = 'Open details';

// ---------- CSV export ----------
export const EXPORT_CSV = 'Export CSV';
export const EXPORT_CSV_FILTERS = 'Export CSV (current filters)';
export const EXPORT_ALL_LOGS = 'Export All';
export const EXPORTED_TO = (path) => `Exported to ${path}`;
export const EXPORT_FAILED = (reason) => `Export failed: ${reasonText(reason)}`;

// ---------- Empty states ----------
export const EMPTY_DEFAULT = 'No data yet.';
export const EMPTY_BILLS = 'No bills found. Try adjusting your filters.';
export const EMPTY_TRANSACTIONS = 'No transactions match your filters.';
export const EMPTY_CHARGERS = 'No chargers found. Ensure the CSMS WebSocket is connected in Settings.';
export const EMPTY_LOGS = 'No logs yet. Events appear here when the CSMS is connected.';
export const LIVE_LABEL = 'Live';
export const PAUSED_LABEL = 'Paused';
export const LOGS_SEARCH_PLACEHOLDER = 'Search charger, type, payload...';
export const ROWS_PER_PAGE = 'Per page';
export const EMPTY_ENERGY_CHART = 'No data yet.';
export const EMPTY_RECENT_SESSIONS = 'No completed sessions yet.';
export const CHARGER_NOT_FOUND = 'Charger not found.';
export const LOADING_LOGS = 'Loading logs...';
export const LOADING_CHARGERS = 'Loading chargers...';
export const LOADING_PREVIEW = 'Loading preview...';

// ---------- Settings ----------
export const SAVING_LABEL = 'Saving...';
export const SAVE_CONNECTION = 'Save Connection';
export const SAVE_BRANDING = 'Save Branding';
export const SAVE_RATE_SHIFTS = 'Save Rate & Shifts';
export const SAVE_BACKEND_SYNC = 'Save Backend Sync';
export const SAVE_PRINTERS = 'Save Printers';
export const SAVE_SECURITY = 'Save Security';
export const SAVED_SECTION = (section) => `${section} saved.`;
export const SAVE_SECTION_FAILED = (section, message) => `Failed to save ${section.toLowerCase()}: ${message}`;
export const VALIDATION_ERROR = 'Please fix validation errors before saving.';
export const SHIFT_ADDED = 'Shift added.';
export const COMPANY_INFO_FETCH_FAILED = 'Failed to fetch company info';
export const COMPANY_INFO_UPDATED = 'Company info updated from API';
export const FOUND_DEVICES = (n) => `Found ${n} device(s)`;
export const SCAN_FAILED = (message) => `Scan failed: ${message}`;
export const CONNECT_FAILED = (message) => `Connect failed: ${message}`;
export const DISCONNECT_FAILED = (message) => `Disconnect failed: ${message}`;
export const CONNECTED_TO = (name) => `Connected to ${name}`;
export const DISCONNECTED_LABEL = 'Disconnected';
export const BT_SCAN_HINT = 'Click <strong>Scan</strong> to discover nearby Bluetooth printers.';

// ---------- Security / reset / backup ----------
export const PASSWORD_REQUIRED_PROMPT = 'Set a password (min 4 characters) before resetting the app.';
export const PASSWORD_ENTER_PROMPT = 'Enter password to reset the app.';
export const PASSWORD_TOO_SHORT = 'Password must be at least 4 characters.';
export const PASSWORD_SAVED_REENTER = 'Password saved. Enter it again to reset the app.';
export const PASSWORD_REMOVED = 'Password removed. App security disabled.';
export const REMOVE_PASSWORD_CONFIRM = 'Remove the password and disable app locking?';
export const RESET_CONFIRM = 'Reset App will clear settings, shifts, chargers, logs, transactions, bills, and local sync queue. Continue?';
export const RESET_SCOPE_HELP = 'Clears local settings, shifts, chargers, logs, transactions, bills, and local sync queue.';
export const RESET_SUCCESS = 'App reset successfully.';
export const RESET_CANCELED = 'Incorrect password. Reset canceled.';
export const RESET_FAILED = (reason) => `Reset failed: ${reasonText(reason)}`;
export const RESTORE_CONFIRM = 'Restore will replace all current data. Continue?';
export const RESTORE_SUCCESS = 'Database restored successfully.';
export const RESTORE_FAILED = (reason) => `Restore failed: ${reasonText(reason)}`;
export const BACKUP_SAVED = (path) => `Backup saved to ${path}`;
export const BACKUP_FAILED = (reason) => `Backup failed: ${reasonText(reason)}`;
export const BACKUP_DATABASE = 'Backup Database';
export const RESTORE_DATABASE = 'Restore Database';
export const RESET_APP = 'Reset App';

// ---------- Sync ----------
export const SYNC_RUN_COMPLETE = 'Sync run complete.';
export const SYNC_FAILED = (message) => `Sync failed: ${message}`;
export const SYNC_NOW = 'Sync now';
export const SYNC_QUEUE_LABEL = 'Sync queue';
export const SYNCING = 'Syncing...';
export const REFRESH_LABEL = 'Refresh';

// ---------- Generic busy labels ----------
export const SEARCHING = 'Searching...';
export const SCANNING_LABEL = 'Scanning...';
export const APPLY_LABEL = 'Apply';
export const CLEAR_LABEL = 'Clear';

// ---------- Lock screen / command palette ----------
export const UNLOCK_PROMPT = 'Enter password to unlock';
export const UNLOCK_LABEL = 'Unlock';
export const INCORRECT_PASSWORD = 'Incorrect password';
export const ERROR_VALIDATING_PASSWORD = 'Error validating password';
export const PASSWORD_PLACEHOLDER = 'Password';
export const CANCEL = 'Cancel';
export const TYPE_COMMAND_PLACEHOLDER = 'Type a command...';
export const NO_MATCHING_COMMANDS = 'No matching commands';
