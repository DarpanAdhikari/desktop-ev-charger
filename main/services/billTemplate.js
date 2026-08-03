const path = require('path');
const fs = require('fs');

let _defaultLogoBase64 = null;
function getDefaultLogoBase64() {
  if (_defaultLogoBase64 !== null) return _defaultLogoBase64;
  try {
    const logoPath = path.join(__dirname, '../../assets/logo/logo.png');
    if (!fs.existsSync(logoPath)) { _defaultLogoBase64 = ''; return ''; }
    const data = fs.readFileSync(logoPath);
    _defaultLogoBase64 = `data:image/png;base64,${data.toString('base64')}`;
    return _defaultLogoBase64;
  } catch (e) {
    _defaultLogoBase64 = '';
    return '';
  }
}

function formatDuration(sec) {
  if (!sec || sec <= 0) return '-';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  let parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mon = months[d.getMonth()];
  const day = String(d.getDate()).padStart(2, '0');
  const year = d.getFullYear();
  let h = d.getHours();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mon} ${day}, ${year} - ${h}:${min} ${ampm}`;
}

function getPrintableWidth(settings) {
  if (settings.bill_format === 'a4') return '210mm';
  const pw = parseInt(settings.paper_width || '80', 10);
  return Math.max(pw - 4, 30) + 'mm';
}

// Cumulative meter counter at session start/end, when captured.
function meterEnergy(bill, tx) {
  const start = bill.meter_energy_start_kwh != null ? bill.meter_energy_start_kwh : tx.meter_energy_start_kwh;
  const end = bill.meter_energy_end_kwh != null ? bill.meter_energy_end_kwh : tx.meter_energy_end_kwh;
  if (start == null && end == null) return null;
  return {
    start: start != null ? Number(start).toFixed(2) : null,
    end: end != null ? Number(end).toFixed(2) : null,
  };
}

function renderBillHtmlOriginal(bill, tx, settings, forPrint = true) {
  const isThermal = settings.bill_format === 'thermal_80mm';
  const width = isThermal ? getPrintableWidth(settings) : '210mm';
  const created = new Date(bill.created_at).toLocaleString();
  const company = settings.company_name || 'Company';
  const showLogo = settings.show_logo_on_bill === '1';
  const logoData = showLogo ? (settings.invoice_logo || settings.branding_logo || getDefaultLogoBase64()) : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: ${width} auto; margin: ${isThermal ? '4mm' : '14mm'}; }
  body { font-family: 'Courier New', monospace; font-size: ${isThermal ? '11px' : '13px'};
         color: #111; width: ${width}; margin: 0; padding: 6px;}
  .bill-header {
    display: grid;
    grid-template-columns: 13% 68%;
    grid-gap: ${isThermal ? '8px' : '16px'};
    margin-bottom: 8px;
    ${logoData ? '' : 'justify-content: center;'}
    padding: ${isThermal ? '0' : '0 0 6px 0'};
  }
  .logo-side { flex-shrink: 0; }
  .logo-side img { max-width: ${isThermal ? '35mm' : '80px'}; max-height: ${isThermal ? '44px' : '60px'}; display: block; }
  .company-side { ${logoData ? 'flex: 1; min-width: 0;' : ''} text-align: center; }
  .company-name { font-weight: bold; font-size: ${isThermal ? '13px' : '18px'}; margin-bottom: 3px; letter-spacing: -0.3px; }
  .company-detail { font-size: ${isThermal ? '9px' : '11px'}; color: #555; line-height: 1.5; margin-bottom: 1px; }
  h1 { font-size: ${isThermal ? '13px' : '18px'}; margin: 0 0 4px; text-align: center; }
  .sub { text-align: center; font-size: 10px; margin-bottom: 8px; }
  hr { border: none; border-top: 1px dashed #333; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; margin: 2px 0; }
  .total { font-weight: bold; font-size: ${isThermal ? '13px' : '16px'}; }
  .foot { text-align: center; font-size: 10px; margin-top: 8px; }
</style>
</head>
<body>
  <div class="bill-header">
    ${logoData ? `<div class="logo-side"><img src="${logoData}" alt="Logo" /></div>` : ''}
    <div class="company-side">
      <div class="company-name">${company}</div>
      ${settings.company_address ? `<div class="company-detail">${settings.company_address}</div>` : ''}
      ${settings.company_phone ? `<div class="company-detail">${settings.company_phone}</div>` : ''}
      ${settings.company_email ? `<div class="company-detail">${settings.company_email}</div>` : ''}
    </div>
  </div>
  <div class="sub">Invoice ${bill.bill_number}<br>${created}</div>
  <hr>
  <div class="row"><span>Charger</span><span>${tx.charger_id}</span></div>
  <div class="row"><span>Connector</span><span>${tx.connector_id}</span></div>
  <div class="row"><span>Duration</span><span>${formatDuration(tx.duration_sec)}</span></div>
  ${bill.soc_start != null ? `<div class="row"><span>Start SoC</span><span>${bill.soc_start}%</span></div>` : ''}
  ${bill.soc_end != null ? `<div class="row"><span>End SoC</span><span>${bill.soc_end}%</span></div>` : ''}
  ${bill.soc_start != null && bill.soc_end != null ? `<div class="row"><span>SoC Change</span><span>+${bill.soc_end - bill.soc_start}%</span></div>` : ''}
  ${bill.customer_name ? `<div class="row"><span>Customer</span><span>${bill.customer_name}${bill.customer_id ? ` (${bill.customer_id})` : ''}</span></div>` : ''}
  ${bill.customer_pan ? `<div class="row"><span>PAN</span><span>${bill.customer_pan}</span></div>` : ''}
  ${bill.customer_vehicle ? `<div class="row"><span>Vehicle</span><span>${bill.customer_vehicle}</span></div>` : ''}
  <div class="row"><span>Energy</span><span>${(bill.energy_kwh ?? 0).toFixed(3)} kWh</span></div>
  ${
    (() => {
      const me = meterEnergy(bill, tx);
      if (!me) return '';
      return (
        (me.start != null ? `<div class="row"><span>Meter Start</span><span>${me.start} kWh</span></div>` : '') +
        (me.end != null ? `<div class="row"><span>Meter End</span><span>${me.end} kWh</span></div>` : '')
      );
    })()
  }
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
  <hr>
  <div class="foot">${company} — Thank you</div>
  <hr>
  ${forPrint ? `<div class="foot">${settings.company_footer || '&copy;Darpan Adhikari (https://darpanadhikari.com.np)'}</div>` : ''}
</body>
</html>`;
}

function renderBillHtmlEnhanced(bill, tx, settings, forPrint = true) {
  const isThermal = settings.bill_format === 'thermal_80mm';
  const width = isThermal ? getPrintableWidth(settings) : '210mm';

  const showLogo = settings.show_logo_on_bill === '1';
  const logoData = showLogo ? (settings.invoice_logo || settings.branding_logo || getDefaultLogoBase64()) : '';

  const company = settings.company_name || 'Company';

  const row = (label, value) =>
    `<div class="row"><span class="lbl">${label}</span><span class="val">${value}</span></div>`;

  const totalHighlight = (label, value) =>
    `<div class="total-row"><span>${label}</span><span>${value}</span></div>`;

  const hasSoC = bill.soc_start != null || bill.soc_end != null;
  const socDelta = hasSoC && bill.soc_start != null && bill.soc_end != null ? bill.soc_end - bill.soc_start : null;
  const hasCustomer = bill.customer_name || bill.customer_id;
  const hasServiceFee = bill.service_fee && parseFloat(bill.service_fee) > 0;
  const hasServiceCharge = bill.service_charge && parseFloat(bill.service_charge) > 0;
  const hasTax = bill.tax_amount && parseFloat(bill.tax_amount) > 0;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: ${width} auto; margin: ${isThermal ? '4mm' : '14mm'}; }
  body { font-family: 'Courier New', monospace; font-size: ${isThermal ? '11px' : '13px'};
         color: #111; width: ${width}; margin: 0; padding: ${isThermal ? '6px' : '10px 6px'}; }
  .bill-header {
    display: grid;
    grid-template-columns: 13% 68%;
    grid-gap: ${isThermal ? '8px' : '16px'};
    margin-bottom: 8px;
    ${logoData ? '' : 'justify-content: center;'}
    padding: ${isThermal ? '0' : '0 0 6px 0'};
  }
  .logo-side { flex-shrink: 0; }
  .logo-side img { max-width: ${isThermal ? '35mm' : '80px'}; max-height: ${isThermal ? '44px' : '60px'}; display: block; }
  .company-side { ${logoData ? 'flex: 1; min-width: 0;' : ''} text-align: center; }
  .company-name { font-weight: bold; font-size: ${isThermal ? '13px' : '18px'}; margin-bottom: 3px; letter-spacing: -0.3px; }
  .company-detail { font-size: ${isThermal ? '9px' : '11px'}; color: #555; line-height: 1.5; margin-bottom: 1px; }
  .check-wrap { text-align: center; margin-bottom: 4px; }
  .check { display: inline-block; width: ${isThermal ? '16px' : '22px'}; height: ${isThermal ? '16px' : '22px'};
           border-radius: 50%; background: #2e7d32; color: #fff; font-weight: bold;
           line-height: ${isThermal ? '16px' : '22px'}; font-size: ${isThermal ? '10px' : '13px'};
           text-align: center; }
  h1 { font-size: ${isThermal ? '13px' : '18px'}; margin: 2px 0; text-align: center; color: #2e7d32; }
  .txn-row { display: flex; justify-content: space-between; align-items: center; font-size: ${isThermal ? '9px' : '11px'}; color: #666; margin-bottom: 4px; }
  .badge { display: inline-block; background: #e8f5e9; color: #2e7d32; padding: 1px 8px;
           border-radius: 10px; font-size: ${isThermal ? '8px' : '10px'}; font-weight: bold; }
  .section-title { font-size: ${isThermal ? '11px' : '13px'}; font-weight: bold; margin: 8px 0 4px; }
  hr { border: none; border-top: 1px dashed #333; margin: 4px 0; }
  .row { display: flex; justify-content: space-between; margin: 2px 0; font-size: ${isThermal ? '10px' : '12px'}; }
  .lbl { color: #666; }
  .val { font-weight: 600; text-align: right; }
  .total-row { display: flex; justify-content: space-between; font-weight: bold;
               font-size: ${isThermal ? '13px' : '16px'}; padding: ${isThermal ? '6px' : '10px'};
               background: #e3f2fd; border-radius: ${isThermal ? '4px' : '8px'}; margin-top: 4px; }
  .foot { text-align: center; font-size: ${isThermal ? '9px' : '10px'}; margin-top: 10px; color: #666; }
</style>
</head>
<body>
  <div class="bill-header">
    ${logoData ? `<div class="logo-side"><img src="${logoData}" alt="Logo" /></div>` : ''}
    <div class="company-side">
      <div class="company-name">${company}</div>
      ${settings.company_address ? `<div class="company-detail">${settings.company_address}</div>` : ''}
      ${settings.company_phone ? `<div class="company-detail">${settings.company_phone}</div>` : ''}
      ${settings.company_email ? `<div class="company-detail">${settings.company_email}</div>` : ''}
    </div>
  </div>
  <div class="check-wrap">${bill.bill_number ? bill.bill_number : ''}</div>
  <div class="txn-row">
    <span>Transaction: ${tx.id || bill.transaction_id}</span>
    <span class="badge">Completed</span>
  </div>
  <hr>
  <div class="section-title">Session Information</div>
  ${row('Start Time', formatDate(tx.started_at))}
  ${row('End Time', formatDate(tx.stopped_at))}
  ${row('Duration', formatDuration(tx.duration_sec))}
  ${row('Charger', `${tx.charger_id} · Connector ${tx.connector_id}`)}
  ${hasSoC ? row('Initial SoC', bill.soc_start != null ? `${bill.soc_start}%` : '-') : ''}
  ${hasSoC ? row('Final SoC', bill.soc_end != null ? `${bill.soc_end}%` : '-') : ''}
  ${socDelta != null ? row('SoC Change', `+${socDelta}%`) : ''}
  ${hasCustomer ? row('Customer', `${bill.customer_name || ''}${bill.customer_id ? ` (${bill.customer_id})` : ''}`) : ''}
  ${hasCustomer && bill.customer_pan ? row('PAN', bill.customer_pan) : ''}
  ${hasCustomer && bill.customer_vehicle ? row('Vehicle', bill.customer_vehicle) : ''}
  <hr>
  <div class="section-title">Energy &amp; Rate</div>
  ${row('Energy Delivered', `${(bill.energy_kwh || 0).toFixed(3)} kWh`)}
  ${
    (() => {
      const me = meterEnergy(bill, tx);
      if (!me) return '';
      return (
        (me.start != null ? row('Meter Start', `${me.start} kWh`) : '') +
        (me.end != null ? row('Meter End', `${me.end} kWh`) : '')
      );
    })()
  }
  ${bill.rate_name ? row('Rate Type', bill.rate_name) : ''}
  ${row('Rate per kWh', `${(bill.rate_per_kwh || 0).toFixed(2)}`)}
  <hr>
  <div class="section-title">Cost Breakdown</div>
  ${row('Energy Charge', `${(bill.subtotal || 0).toFixed(2)}`)}
  ${hasServiceFee ? row('Service Fee', `${(bill.service_fee || 0).toFixed(2)}`) : ''}
  ${hasServiceCharge ? row('Service Charge', `${(bill.service_charge || 0).toFixed(2)}`) : ''}
  ${hasTax ? row(`Tax (${bill.tax_percent || 0}%)`, `${(bill.tax_amount || 0).toFixed(2)}`) : ''}
  <hr>
  ${totalHighlight('Total Amount', `${(bill.total || 0).toFixed(2)}`)}
  <hr>
  <div class="check-wrap"><span class="check">✓</span></div>
  <h1>Charging Complete!</h1>
  <hr>
  <div class="foot">${company} — Thank you</div>
  <hr>
  ${forPrint ? `<div class="foot">${settings.company_footer || '&copy;Darpan Adhikari (https://darpanadhikari.com.np)'}</div>` : ''}
</body>
</html>`;
}

let _cachedTemplate = null;

function setCachedTemplate(html) {
  _cachedTemplate = html;
}

function renderBillHtmlRemote(bill, tx, settings) {
  let html = _cachedTemplate;
  if (!html) return renderBillHtml(bill, tx, settings);
  const ctx = {
    customer_name: bill.customer_name || '',
    customer_id: bill.customer_id || '',
    customer_pan: bill.customer_pan || '',
    customer_address: bill.customer_address || '',
    customer_vehicle: bill.customer_vehicle || '',
    company_name: settings.company_name || 'Company',
    bill_number: bill.bill_number || '',
    created_at: formatDate(bill.created_at),
    charger_id: tx.charger_id || '',
    connector_id: tx.connector_id || '',
    energy_kwh: (bill.energy_kwh || 0).toFixed(3),
    rate_per_kwh: (bill.rate_per_kwh || 0).toFixed(2),
    subtotal: (bill.subtotal || 0).toFixed(2),
    tax_percent: bill.tax_percent || '0',
    tax_amount: (bill.tax_amount || 0).toFixed(2),
    service_fee: (bill.service_fee || 0).toFixed(2),
    service_charge: (bill.service_charge || 0).toFixed(2),
    total: (bill.total || 0).toFixed(2),
    soc_start: bill.soc_start != null ? String(bill.soc_start) : '',
    soc_end: bill.soc_end != null ? String(bill.soc_end) : '',
    started_at: formatDate(tx.started_at),
    stopped_at: formatDate(tx.stopped_at),
    duration: tx.duration_sec != null ? formatDuration(tx.duration_sec) : '-',
    duration_sec: tx.duration_sec != null ? formatDuration(tx.duration_sec) : '-',
    soc_delta: bill.soc_start != null && bill.soc_end != null ? String(bill.soc_end - bill.soc_start) : '',
    rate_name: bill.rate_name || '',
    max_power_kw: bill.max_power_kw != null ? Number(bill.max_power_kw).toFixed(2) : '',
    avg_power_kw: bill.avg_power_kw != null ? Number(bill.avg_power_kw).toFixed(2) : '',
    last_power_kw: bill.last_power_kw != null ? Number(bill.last_power_kw).toFixed(2) : '',
    meter_energy_start_kwh: bill.meter_energy_start_kwh != null ? Number(bill.meter_energy_start_kwh).toFixed(2) : '',
    meter_energy_end_kwh: bill.meter_energy_end_kwh != null ? Number(bill.meter_energy_end_kwh).toFixed(2) : '',
    show_logo_on_bill: settings.show_logo_on_bill || '0',
    invoice_logo: settings.invoice_logo || '',
    branding_logo: settings.branding_logo || '',
    logo_data: settings.show_logo_on_bill === '1'
      ? (settings.invoice_logo || settings.branding_logo || getDefaultLogoBase64())
      : '',
  };
  for (const [key, val] of Object.entries(ctx)) {
    html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'gi'), val);
  }
  return html;
}

function renderBillHtmlProfessional(bill, tx, settings, forPrint = true) {
  const isThermal = settings.bill_format === 'thermal_80mm';
  const width = isThermal ? getPrintableWidth(settings) : '210mm';
  const company = settings.company_name || 'Company';
  const showLogo = settings.show_logo_on_bill === '1';
  const logoData = showLogo ? (settings.invoice_logo || settings.branding_logo || getDefaultLogoBase64()) : '';

  const hasSoC = bill.soc_start != null || bill.soc_end != null;
  const socDelta = hasSoC && bill.soc_start != null && bill.soc_end != null ? bill.soc_end - bill.soc_start : null;
  const hasCustomer = bill.customer_name || bill.customer_id;
  const hasServiceFee = bill.service_fee && parseFloat(bill.service_fee) > 0;
  const hasServiceCharge = bill.service_charge && parseFloat(bill.service_charge) > 0;
  const hasTax = bill.tax_amount && parseFloat(bill.tax_amount) > 0;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: ${width} auto; margin: ${isThermal ? '4mm' : '15mm'}; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
    color: #1a1a1a; max-width: ${width}; margin: 0 auto; padding: ${isThermal ? '4px' : '0'};
    font-size: ${isThermal ? '9px' : '11px'}; line-height: 1.6;
  }
  .header {
    padding-bottom: ${isThermal ? '8px' : '20px'};
    border-bottom: ${isThermal ? '1px' : '2px'} solid #e8e8e8;
    margin-bottom: ${isThermal ? '8px' : '24px'};
  }
  .header-row {
    display: flex;
    align-items: center;
    ${logoData ? '' : 'justify-content: center;'}
  }
  .logo-side { flex-shrink: 0; margin-right: ${isThermal ? '8px' : '16px'}; }
  .logo-side img { max-width: ${isThermal ? '40px' : '64px'}; max-height: ${isThermal ? '40px' : '64px'}; display: block; }
  .company-info { ${logoData ? 'flex: 1;' : ''} text-align: center; }
  .company-name { font-size: ${isThermal ? '12px' : '18px'}; font-weight: 700; color: #1a1a2e; }
  .company-detail { font-size: ${isThermal ? '8px' : '10px'}; color: #666; line-height: 1.4; }
  .invoice-row { text-align: center; margin-top: ${isThermal ? '6px' : '12px'}; }
  .invoice-label { font-size: ${isThermal ? '12px' : '16px'}; font-weight: 800; color: #1a1a2e; letter-spacing: 0.5px; }
  .invoice-number { font-size: ${isThermal ? '9px' : '12px'}; font-weight: 600; color: #333; }
  .invoice-date { font-size: ${isThermal ? '8px' : '10px'}; color: #888; }
  .info-grid {
    display: flex; ${isThermal ? 'flex-direction: column;' : ''} justify-content: space-between;
    margin-bottom: ${isThermal ? '8px' : '24px'};
    padding: ${isThermal ? '8px' : '16px'}; background: #f8f9fa; border-radius: ${isThermal ? '4px' : '8px'};
  }
  .info-col h3 { font-size: ${isThermal ? '8px' : '10px'}; text-transform: uppercase; letter-spacing: 0.5px; color: #888; margin-bottom: ${isThermal ? '2px' : '6px'}; }
  .info-col p { font-size: ${isThermal ? '9px' : '11px'}; color: #333; margin: ${isThermal ? '1px' : '2px'} 0; }
  .section-title { font-size: ${isThermal ? '10px' : '12px'}; font-weight: 700; color: #1a1a2e; margin-bottom: ${isThermal ? '4px' : '8px'}; }
  table { width: 100%; border-collapse: collapse; margin: ${isThermal ? '4px' : '12px'} 0; }
  thead th {
    background: #1a1a2e; color: #fff; padding: ${isThermal ? '4px 6px' : '10px 14px'};
    font-size: ${isThermal ? '8px' : '10px'}; text-transform: uppercase; letter-spacing: 0.5px;
    text-align: left; font-weight: 600;
  }
  thead th.right { text-align: right; }
  tbody td { padding: ${isThermal ? '4px 6px' : '10px 14px'}; border-bottom: 1px solid #eee; font-size: ${isThermal ? '9px' : '11px'}; }
  tbody td.right { text-align: right; font-weight: 600; }
  tbody td.sub { color: #888; font-size: ${isThermal ? '8px' : '10px'}; }
  .total-row { background: #1a1a2e; }
  .total-row td { color: #fff; font-size: ${isThermal ? '12px' : '16px'}; font-weight: 700; padding: ${isThermal ? '6px 8px' : '14px 16px'}; border: none; }
  .total-row td.right { text-align: right; }
  .soc-line { margin-top: ${isThermal ? '4px' : '12px'}; font-size: ${isThermal ? '8px' : '10px'}; color: #888; }
  .footer { text-align: center; margin-top: ${isThermal ? '8px' : '32px'}; padding-top: ${isThermal ? '6px' : '16px'}; border-top: 1px solid #e8e8e8; font-size: ${isThermal ? '8px' : '10px'}; color: #888; line-height: 1.6; }
  .footer .thanks { font-size: ${isThermal ? '10px' : '13px'}; font-weight: 600; color: #1a1a2e; margin-bottom: ${isThermal ? '2px' : '4px'}; }
</style>
</head>
<body>
  <div class="header">
    <div class="header-row">
      ${logoData ? `<div class="logo-side"><img src="${logoData}" alt="Logo" /></div>` : ''}
      <div class="company-info">
        <div class="company-name">${company}</div>
        ${settings.company_address ? `<div class="company-detail">${settings.company_address}</div>` : ''}
        ${settings.company_phone ? `<div class="company-detail">${settings.company_phone}</div>` : ''}
        ${settings.company_email ? `<div class="company-detail">${settings.company_email}</div>` : ''}
      </div>
    </div>
    <div class="invoice-row">
      <div class="invoice-label">INVOICE</div>
      <div class="invoice-number">${bill.bill_number} <span class="invoice-date">${formatDate(bill.created_at)}</span></div>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-col">
      <h3>Bill To</h3>
      ${hasCustomer
        ? `<p>${bill.customer_name || ''}${bill.customer_id ? ` (${bill.customer_id})` : ''}</p>`
        : '<p>—</p>'}
      ${bill.customer_pan ? `<p>PAN: ${bill.customer_pan}</p>` : ''}
      ${bill.customer_vehicle ? `<p>Vehicle: ${bill.customer_vehicle}</p>` : ''}
    </div>
    <div class="info-col" style="${isThermal ? '' : 'text-align:right'}">
      <h3>Session</h3>
      <p>${tx.charger_id} · Connector ${tx.connector_id}</p>
      <p>Duration: ${formatDuration(tx.duration_sec)}</p>
      <p>${formatDate(tx.started_at)} — ${formatDate(tx.stopped_at)}</p>
    </div>
  </div>

  <div class="section-title">Charging Details</div>
  <table>
    <thead>
      <tr>
        <th style="width:44%">Description</th>
        <th style="width:22%">Details</th>
        <th class="right" style="width:16%">Rate</th>
        <th class="right" style="width:18%">Amount</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Energy Charged</td>
        <td>${(bill.energy_kwh || 0).toFixed(3)} kWh</td>
        <td class="right">${(bill.rate_per_kwh || 0).toFixed(2)}</td>
        <td class="right">${(bill.subtotal || 0).toFixed(2)}</td>
      </tr>
      ${
        (() => {
          const me = meterEnergy(bill, tx);
          if (!me) return '';
          return (
            (me.start != null ? `<tr><td class="sub" colspan="4">Meter Start: ${me.start} kWh</td></tr>` : '') +
            (me.end != null ? `<tr><td class="sub" colspan="4">Meter End: ${me.end} kWh</td></tr>` : '')
          );
        })()
      }
      ${bill.rate_name ? `<tr><td class="sub" colspan="4">Rate Plan: ${bill.rate_name}</td></tr>` : ''}
      ${hasServiceFee ? `<tr><td>Service Fee</td><td>—</td><td class="right">—</td><td class="right">${(bill.service_fee || 0).toFixed(2)}</td></tr>` : ''}
      ${hasServiceCharge ? `<tr><td>Service Charge</td><td>—</td><td class="right">—</td><td class="right">${(bill.service_charge || 0).toFixed(2)}</td></tr>` : ''}
      ${hasTax ? `<tr><td>Tax (${bill.tax_percent || 0}%)</td><td>—</td><td class="right">—</td><td class="right">${(bill.tax_amount || 0).toFixed(2)}</td></tr>` : ''}
    </tbody>
  </table>

  <table>
    <tbody>
      <tr class="total-row">
        <td style="width:82%">Total Amount</td>
        <td class="right" style="width:18%">${(bill.total || 0).toFixed(2)}</td>
      </tr>
    </tbody>
  </table>

  ${hasSoC ? `<div class="soc-line">SoC: ${bill.soc_start != null ? bill.soc_start + '%' : '-'} → ${bill.soc_end != null ? bill.soc_end + '%' : '-'}${socDelta != null ? ' (+' + socDelta + '%)' : ''}</div>` : ''}

  <div class="footer">
    <div class="thanks">Thank you for charging with ${company}!</div>
    ${settings.company_phone ? `<div>${settings.company_phone}</div>` : ''}
    ${settings.company_email ? `<div>${settings.company_email}</div>` : ''}
    ${forPrint ? `<div style="margin-top:4px;font-size:9px;">${settings.company_footer || '&copy; Darpan Adhikari (https://darpanadhikari.com.np)'}</div>` : ''}
  </div>
</body>
</html>`;
}

function renderBillHtml(bill, tx, settings, displayFormat, forPrint = true) {
  if (_cachedTemplate && displayFormat === 'custom') {
    return renderBillHtmlRemote(bill, tx, settings);
  }
  if (displayFormat === 'professional') {
    return renderBillHtmlProfessional(bill, tx, settings, forPrint);
  }
  if (displayFormat === 'enhanced') {
    return renderBillHtmlEnhanced(bill, tx, settings, forPrint);
  }
  if (displayFormat === 'original') {
    return renderBillHtmlOriginal(bill, tx, settings, forPrint);
  }
  // Fallback for thermal printers (no displayFormat passed)
  if (settings.use_new_bill_format === '1') {
    return renderBillHtmlEnhanced(bill, tx, settings, forPrint);
  }
  return renderBillHtmlOriginal(bill, tx, settings, forPrint);
}

module.exports = { renderBillHtml, setCachedTemplate };
