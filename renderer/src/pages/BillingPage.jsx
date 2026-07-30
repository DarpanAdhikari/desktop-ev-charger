import { useState, useMemo } from 'react';
import { useBills, useLiveEvents } from '../hooks/useVoltDesk';
import { printBill, getSettings, exportCsv } from '../services/ipc';
import EmptyState from '../components/EmptyState';
import BillModal from '../components/BillModal';

export default function BillingPage({ refreshKey, addToast }) {
  const { bills, loading, refresh } = useBills();
  const [selectedBill, setSelectedBill] = useState(null);
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useLiveEvents({
    onBillingEvent: (evt) => {
      refresh();
      if (evt.type === 'bill_generated') {
        addToast(`Bill ${evt.bill_number} generated \u2014 $${(evt.total || 0).toFixed(2)}`, 'success');
      } else if (evt.type === 'bill_error') {
        addToast(`Bill error: ${evt.reason || 'unknown'}`, 'error');
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
        addToast(`Bill #${result.bill.bill_number} printed successfully`, 'success');
      } else {
        addToast(`Print failed: ${result.failureReason || 'unknown'}`, 'error');
      }
      refresh();
      if (selectedBill && selectedBill.id === billId) {
        setSelectedBill(result.bill);
      }
    } catch (e) {
      addToast(`Print error: ${e.message}`, 'error');
    }
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
        <button className="btn ghost" onClick={async () => {
          const cols = ['id', 'bill_number', 'company_name', 'customer_name', 'energy_kwh', 'rate_per_kwh', 'subtotal', 'tax_percent', 'tax_amount', 'total', 'print_success_count', 'print_fail_count', 'created_at'];
          const result = await exportCsv({ data: filtered, columns: cols, filename: 'bills.csv' });
          if (result.success) addToast(`Exported to ${result.path}`, 'success');
          else if (result.reason !== 'canceled') addToast(`Export failed: ${result.reason}`, 'error');
        }}>Export CSV</button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState message="No bills found. Try adjusting your filters." />
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
            <div key={bill.id} className="bill-row" onClick={() => setSelectedBill(bill)}>
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
    </>
  );
}
