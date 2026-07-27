import { useState } from 'react';
import { useBills, useLiveEvents } from '../hooks/useVoltDesk';
import { printBill, getSettings, exportCsv } from '../services/ipc';
import EmptyState from '../components/EmptyState';
import BillModal from '../components/BillModal';

export default function BillingPage({ refreshKey, addToast }) {
  const { bills, loading, refresh } = useBills();
  const [selectedBill, setSelectedBill] = useState(null);

  useLiveEvents({
    onBillingEvent: (evt) => {
      refresh();
      if (evt.type === 'bill_generated') {
        addToast(`Bill ${evt.bill_number} generated — $${(evt.total || 0).toFixed(2)}`, 'success');
      } else if (evt.type === 'bill_error') {
        addToast(`Bill error: ${evt.reason || 'unknown'}`, 'error');
      }
    },
  });

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
    return <div className="empty-state"><p>Loading bills...</p></div>;
  }

  return (
    <>
      <header className="view-header">
        <h1>Billing</h1>
        <p className="muted">Every invoice generated after a session ends.</p>
      </header>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        {bills.length > 0 && (
          <button className="btn ghost" onClick={async () => {
            const cols = ['id', 'bill_number', 'company_name', 'energy_kwh', 'rate_per_kwh', 'subtotal', 'tax_percent', 'tax_amount', 'total', 'print_success_count', 'print_fail_count', 'created_at'];
            const result = await exportCsv({ data: bills, columns: cols, filename: 'bills.csv' });
            if (result.success) addToast(`Exported to ${result.path}`, 'success');
            else if (result.reason !== 'canceled') addToast(`Export failed: ${result.reason}`, 'error');
          }}>Export CSV</button>
        )}
      </div>

      {bills.length === 0 ? (
        <EmptyState message="No bills yet. Invoices are auto-generated when a charging session ends." />
      ) : (
        <div className="bill-list">
          {bills.map((bill) => (
            <div key={bill.id} className="bill-row" onClick={() => setSelectedBill(bill)}>
              <span className="bill-num">{bill.bill_number}</span>
              <span className="bill-total">${(bill.total || 0).toFixed(2)}</span>
              <span className="bill-company">{bill.company_name || '—'}</span>
              <span className="bill-energy">{(bill.energy_kwh || 0).toFixed(2)} kWh</span>
              <span className="bill-date">{bill.created_at ? new Date(bill.created_at).toLocaleString() : ''}</span>
              <span className="bill-prints">
                <span className="ok">✓{bill.print_success_count || 0}</span>
                {(bill.print_fail_count || 0) > 0 && (
                  <span className="fail"> ✗{bill.print_fail_count}</span>
                )}
              </span>
            </div>
          ))}
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
