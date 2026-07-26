function renderBillHtml(bill, tx, settings) {
  const isThermal = settings.bill_format === 'thermal_80mm';
  const width = isThermal ? '80mm' : '210mm';
  const created = new Date(bill.created_at).toLocaleString();

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: ${width} auto; margin: ${isThermal ? '4mm' : '14mm'}; }
  body { font-family: 'Courier New', monospace; font-size: ${isThermal ? '11px' : '13px'};
         color: #111; width: ${width}; margin: 0; }
  h1 { font-size: ${isThermal ? '13px' : '18px'}; margin: 0 0 4px; text-align: center; }
  .sub { text-align: center; font-size: 10px; margin-bottom: 8px; }
  hr { border: none; border-top: 1px dashed #333; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; margin: 2px 0; }
  .total { font-weight: bold; font-size: ${isThermal ? '13px' : '16px'}; }
  .foot { text-align: center; font-size: 10px; margin-top: 8px; }
</style>
</head>
<body>
  <h1>${settings.company_name || 'Company'}</h1>
  <div class="sub">Invoice ${bill.bill_number}<br>${created}</div>
  <hr>
  <div class="row"><span>Charger</span><span>${tx.charger_id}</span></div>
  <div class="row"><span>Connector</span><span>${tx.connector_id}</span></div>
  <div class="row"><span>Duration</span><span>${tx.duration_sec ?? '-'} s</span></div>
  <div class="row"><span>Energy</span><span>${(bill.energy_kwh ?? 0).toFixed(3)} kWh</span></div>
  <div class="row"><span>Rate</span><span>${(bill.rate_per_kwh ?? 0).toFixed(2)} / kWh</span></div>
  <hr>
  <div class="row"><span>Subtotal</span><span>${bill.subtotal.toFixed(2)}</span></div>
  ${
    bill.tax_amount
      ? `<div class="row"><span>Tax (${bill.tax_percent}%)</span><span>${bill.tax_amount.toFixed(2)}</span></div>`
      : ''
  }
  <hr>
  <div class="row total"><span>Total</span><span>${bill.total.toFixed(2)}</span></div>
  <div class="foot">Thank you</div>
</body>
</html>`;
}

module.exports = { renderBillHtml };
