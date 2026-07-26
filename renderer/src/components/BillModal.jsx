export default function BillModal({ bill, onClose, onPrint }) {
  if (!bill) return null;

  return (
    <div className="modal-backdrop open" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{bill.bill_number}</h2>
        <dl className="bill-detail">
          <dt>Company</dt>
          <dd>{bill.company_name || '—'}</dd>
          <dt>Energy</dt>
          <dd>{(bill.energy_kwh || 0).toFixed(2)} kWh</dd>
          <dt>Rate</dt>
          <dd>${(bill.rate_per_kwh || 0).toFixed(4)}/kWh</dd>
          <dt>Subtotal</dt>
          <dd>${(bill.subtotal || 0).toFixed(2)}</dd>
          {(bill.tax_applicable && bill.tax_percent > 0) ? (
            <>
              <dt>Tax ({bill.tax_percent}%)</dt>
              <dd>${(bill.tax_amount || 0).toFixed(2)}</dd>
            </>
          ) : null}
          <dt style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }}>Total</dt>
          <dd className="total" style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }}>
            ${(bill.total || 0).toFixed(2)}
          </dd>
          <dt>Prints</dt>
          <dd>
            <span className="ok">✓{bill.print_success_count || 0}</span>
            {(bill.print_fail_count || 0) > 0 && (
              <span className="fail"> ✗{bill.print_fail_count}</span>
            )}
          </dd>
          <dt>Date</dt>
          <dd>{bill.created_at ? new Date(bill.created_at).toLocaleString() : '—'}</dd>
        </dl>
        <div className="modal-actions">
          <button className="btn primary" onClick={() => onPrint(bill.id)}>Print</button>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
