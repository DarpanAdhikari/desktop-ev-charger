import { useState, useMemo } from 'react';
import { useBills, useLiveEvents } from '../hooks/useVoltDesk';
import { printBill, getSettings, exportCsv, generateBillPdf, generateBillImage } from '../services/ipc';
import { useContextMenu } from '../hooks/useContextMenu.jsx';
import { base64ToBlob, withTimeout } from '../utils';
import { IMAGE_GEN_TIMEOUT_MS } from '../constants';
import EmptyState from '../components/EmptyState';
import BillModal from '../components/BillModal';
import ShareModal from '../components/ShareModal';
import {
  billGeneratedWithTotalText, BILL_ERROR, PRINTED_SUCCESS, PRINT_FAILED, PRINT_ERROR,
  EXPORTED_TO, EXPORT_FAILED, EXPORT_CSV, EXPORT_CSV_FILTERS, EMPTY_BILLS,
  PDF_SAVED, PDF_FAILED, IMAGE_TIMED_OUT, IMAGE_FAILED, IMAGE_COPIED, IMAGE_COPY_FAILED,
  PRINT_LABEL, DOWNLOAD_PDF, COPY_IMAGE, SHARE_LABEL, OPEN_DETAILS,
} from '../strings';

export default function BillingPage({ refreshKey, addToast }) {
  const { bills, loading, refresh } = useBills();
  const { openMenu } = useContextMenu();
  const [selectedBill, setSelectedBill] = useState(null);
  const [shareBill, setShareBill] = useState(null);
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useLiveEvents({
    onBillingEvent: (evt) => {
      refresh();
      if (evt.type === 'bill_generated') {
        addToast(billGeneratedWithTotalText(evt.bill || evt), 'success');
      } else if (evt.type === 'bill_error') {
        addToast(BILL_ERROR(evt.error || evt.reason), 'error');
      }
    },
  });

  const filtered = useMemo(() => {
    let list = bills;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((b) =>
        (b.bill_number || '').toLowerCase().includes(q) ||
        (b.company_name || '').toLowerCase().includes(q) ||
        (b.customer_name || '').toLowerCase().includes(q)
      );
    }
    if (dateFrom) {
      const f = new Date(dateFrom);
      list = list.filter((b) => b.created_at && new Date(b.created_at) >= f);
    }
    if (dateTo) {
      const t = new Date(dateTo + 'T23:59:59');
      list = list.filter((b) => b.created_at && new Date(b.created_at) <= t);
    }
    return list;
  }, [bills, search, dateFrom, dateTo]);

  const handlePrint = async (billId) => {
    try {
      const settings = await getSettings();
      const result = await printBill({ billId, deviceName: settings.print_device_name || undefined });
      if (result.success) {
        addToast(PRINTED_SUCCESS(result.bill.bill_number || result.bill.id), 'success');
      } else {
        addToast(PRINT_FAILED(result.reason || result.failureReason), 'error');
      }
      refresh();
      if (selectedBill && selectedBill.id === billId) {
        setSelectedBill(result.bill);
      }
    } catch (e) {
      addToast(PRINT_ERROR(e.message), 'error');
    }
  };

  const handleExportCsv = async () => {
    const cols = ['id', 'bill_number', 'company_name', 'customer_name', 'energy_kwh', 'rate_per_kwh', 'subtotal', 'tax_percent', 'tax_amount', 'total', 'print_success_count', 'print_fail_count', 'created_at'];
    const result = await exportCsv({ data: filtered, columns: cols, filename: 'bills.csv' });
    if (result.success) addToast(EXPORTED_TO(result.path), 'success');
    else if (result.reason !== 'canceled') addToast(EXPORT_FAILED(result.reason), 'error');
  };

  const downloadBillPdf = async (bill) => {
    const result = await generateBillPdf(bill.id);
    if (!result.success) { addToast(PDF_FAILED(result.reason), 'error'); return; }
    const blob = base64ToBlob(result.data, 'application/pdf');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = result.name;
    a.click();
    URL.revokeObjectURL(url);
    addToast(PDF_SAVED(result.name), 'success');
  };

  const copyBillImage = async (bill) => {
    let result;
    try {
      result = await withTimeout(generateBillImage(bill.id), IMAGE_GEN_TIMEOUT_MS);
    } catch {
      addToast(IMAGE_TIMED_OUT, 'error');
      return;
    }
    if (!result.success) { addToast(IMAGE_FAILED(result.reason), 'error'); return; }
    try {
      const blob = base64ToBlob(result.data, 'image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      addToast(IMAGE_COPIED, 'success');
    } catch {
      addToast(IMAGE_COPY_FAILED, 'error');
    }
  };

  const shareBillImage = (bill) => setShareBill(bill);

  const handleBillContextMenu = (e, bill) => {
    openMenu(e, [
      { label: OPEN_DETAILS, run: () => setSelectedBill(bill) },
      { label: PRINT_LABEL, run: () => handlePrint(bill.id) },
      { label: DOWNLOAD_PDF, run: () => downloadBillPdf(bill) },
      { label: COPY_IMAGE, run: () => copyBillImage(bill) },
      { label: SHARE_LABEL, run: () => shareBillImage(bill) },
      { separator: true },
      { label: EXPORT_CSV_FILTERS, run: handleExportCsv },
    ]);
  };

  if (loading) {
    return (
      <>
        <header className="view-header">
          <h1>Billing</h1>
          <p className="muted">Every invoice generated after a session ends.</p>
        </header>
        <div className="bill-list">
          {[1,2,3,4,5].map((i) => (
            <div key={i} className="bill-row" style={{ opacity: 0.4 }}>
              <span className="skeleton" style={{ width: 100, height: 14, display: 'inline-block' }} />
              <span className="skeleton" style={{ width: 60, height: 14, display: 'inline-block' }} />
              <span className="skeleton" style={{ width: 80, height: 14, display: 'inline-block' }} />
              <span className="skeleton" style={{ width: 50, height: 14, display: 'inline-block' }} />
              <span className="skeleton" style={{ width: 120, height: 14, display: 'inline-block' }} />
              <span className="skeleton" style={{ width: 40, height: 14, display: 'inline-block' }} />
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <header className="view-header">
        <h1>Billing</h1>
        <p className="muted">Every invoice generated after a session ends.</p>
      </header>

      <div className="billing-filters">
        <div className="floating-input">
          <input
            type="text"
            placeholder=" "
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label>Search bill #, company, customer...</label>
        </div>
        <div className="floating-input" style={{ maxWidth: 160 }}>
          <input
            type="date"
            placeholder=" "
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
          <label>From</label>
        </div>
        <div className="floating-input" style={{ maxWidth: 160 }}>
          <input
            type="date"
            placeholder=" "
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
          <label>To</label>
        </div>
        <button className="btn ghost" onClick={handleExportCsv}>{EXPORT_CSV}</button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState message={EMPTY_BILLS} />
      ) : (
        <div className="bill-list">
          <div className="bill-row bill-header">
            <span>Bill #</span>
            <span>Total</span>
            <span>Customer / Company</span>
            <span>Energy</span>
            <span>Date</span>
            <span>Prints</span>
          </div>
          {filtered.map((bill) => (
            <div key={bill.id} className="bill-row" onClick={() => setSelectedBill(bill)} onContextMenu={(e) => handleBillContextMenu(e, bill)}>
              <span className="bill-num">{bill.bill_number}</span>
              <span className="bill-total">${(bill.total || 0).toFixed(2)}</span>
              <span className="bill-company">{bill.customer_name || bill.company_name || '\u2014'}</span>
              <span className="bill-energy">{(bill.energy_kwh || 0).toFixed(2)} kWh</span>
              <span className="bill-date">{bill.created_at ? new Date(bill.created_at).toLocaleString() : ''}</span>
              <span className="bill-prints">
                <span className="ok">{'\u2713'}{bill.print_success_count || 0}</span>
                {(bill.print_fail_count || 0) > 0 && (
                  <span className="fail"> {'\u2717'}{bill.print_fail_count}</span>
                )}
              </span>
            </div>
          ))}
          <div className="bill-row bill-total-row">
            <span className="bill-num"><strong>{filtered.length} bills</strong></span>
            <span className="bill-total"><strong>${filtered.reduce((s, b) => s + (b.total || 0), 0).toFixed(2)}</strong></span>
            <span />
            <span className="bill-energy"><strong>{filtered.reduce((s, b) => s + (b.energy_kwh || 0), 0).toFixed(2)} kWh</strong></span>
            <span />
            <span />
          </div>
        </div>
      )}

      {selectedBill && (
        <BillModal
          bill={selectedBill}
          onClose={() => setSelectedBill(null)}
          onPrint={handlePrint}
          addToast={addToast}
        />
      )}

      {shareBill && (
        <ShareModal
          bill={shareBill}
          onClose={() => setShareBill(null)}
          addToast={addToast}
        />
      )}
    </>
  );
}
