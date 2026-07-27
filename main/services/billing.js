const db = require('../db/db');

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function shiftContains(shift, minuteOfDay) {
  const start = toMinutes(shift.start_time);
  const end = toMinutes(shift.end_time);
  if (start === end) return true;
  if (start < end) return minuteOfDay >= start && minuteOfDay < end;
  return minuteOfDay >= start || minuteOfDay < end;
}

function findShiftForTime(date) {
  const raw = db.raw;
  const shifts = raw.prepare('SELECT * FROM shifts WHERE active = 1').all();
  if (shifts.length === 0) return null;
  const minuteOfDay = date.getHours() * 60 + date.getMinutes();
  return shifts.find((s) => shiftContains(s, minuteOfDay)) || shifts[0];
}

function getShiftsAtMinute(minuteOfDay, shifts) {
  return shifts.filter((s) => shiftContains(s, minuteOfDay));
}

function getShiftName(shiftId) {
  if (shiftId == null) return null;
  const shift = db.raw.prepare('SELECT name, start_time, end_time FROM shifts WHERE id = ?').get(shiftId);
  return shift ? `${shift.name} (${shift.start_time}-${shift.end_time})` : null;
}

function generateBillForTransaction(transactionId) {
  const raw = db.raw;
  const tx = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId);
  if (!tx) throw new Error(`transaction ${transactionId} not found`);

  const startedAt = tx.started_at ? new Date(tx.started_at) : new Date();
  const stoppedAt = tx.stopped_at ? new Date(tx.stopped_at) : new Date();
  const energy = tx.energy_kwh || 0;
  const settings = db.getSettings();

  const activeShifts = raw.prepare('SELECT * FROM shifts WHERE active = 1').all();

  const serviceFee = parseFloat(settings.service_fee) || 0;
  const serviceCharge = parseFloat(settings.service_charge) || 0;

  if (activeShifts.length === 0) {
    // No shifts configured — fall back to flat rate of 0
    return createBill(tx, settings, energy, 0, 0, 0, 0, 0, null, serviceFee, serviceCharge);
  }

  // For very short sessions (< 1 minute) just use the shift at start time
  const durationMs = stoppedAt.getTime() - startedAt.getTime();
  if (durationMs < 60000) {
    const shift = findShiftForTime(startedAt) || activeShifts[0];
    const rate = shift ? shift.rate_per_kwh : 0;
    const subtotal = Math.round(rate * energy * 100) / 100;
    const taxOn = shift && shift.tax_applicable === 1;
    const taxPercent = taxOn ? shift.tax_percent || 0 : 0;
    const taxAmount = Math.round(subtotal * (taxPercent / 100) * 100) / 100;
    const total = Math.round((subtotal + taxAmount + serviceFee + serviceCharge) * 100) / 100;
    return createBill(tx, settings, energy, rate, subtotal, taxPercent, taxAmount, total, shift ? shift.id : null, serviceFee, serviceCharge);
  }

  // Split energy proportionally across shifts
  const durationMinutes = Math.max(1, Math.ceil(durationMs / 60000));
  const energyPerMinute = energy / durationMinutes;

  let totalSubtotal = 0;
  let totalTaxAmount = 0;
  let weightedRateSum = 0;
  let shiftsUsed = new Set();
  let applicableShiftId = null;
  let taxPercent = 0;

  for (let i = 0; i < durationMinutes; i++) {
    const tick = new Date(startedAt.getTime() + i * 60000);
    const mod = tick.getHours() * 60 + tick.getMinutes();
    const matchingShifts = getShiftsAtMinute(mod, activeShifts);
    const shift = matchingShifts.length > 0 ? matchingShifts[0] : activeShifts[0];
    if (!shift) continue;

    shiftsUsed.add(shift.id);
    applicableShiftId = shift.id;

    const minuteEnergy = i < durationMinutes - 1
      ? energyPerMinute
      : energy - energyPerMinute * (durationMinutes - 1); // last minute takes remainder

    const minuteSubtotal = Math.round(shift.rate_per_kwh * minuteEnergy * 100) / 100;
    totalSubtotal += minuteSubtotal;
    weightedRateSum += shift.rate_per_kwh * minuteEnergy;

    const taxOn = shift.tax_applicable === 1;
    if (taxOn && shift.tax_percent > 0) {
      const minuteTax = Math.round(minuteSubtotal * (shift.tax_percent / 100) * 100) / 100;
      totalTaxAmount += minuteTax;
      if (taxPercent === 0) taxPercent = shift.tax_percent;
    }
  }

  totalSubtotal = Math.round(totalSubtotal * 100) / 100;
  totalTaxAmount = Math.round(totalTaxAmount * 100) / 100;
  const total = Math.round((totalSubtotal + totalTaxAmount + serviceFee + serviceCharge) * 100) / 100;

  // Effective blended rate for display
  const effectiveRate = energy > 0
    ? Math.round((weightedRateSum / energy) * 10000) / 10000
    : 0;

  return createBill(tx, settings, energy, effectiveRate, totalSubtotal, taxPercent, totalTaxAmount, total, applicableShiftId, serviceFee, serviceCharge);
}

function createBill(tx, settings, energy, rate, subtotal, taxPercent, taxAmount, total, shiftId, serviceFee, serviceCharge) {
  const billNumber = db.nextBillNumber();
  const createdAt = new Date().toISOString();
  const raw = db.raw;
  const rateName = shiftId ? getShiftName(shiftId) : null;

  const result = raw
    .prepare(
      `INSERT INTO bills
        (transaction_id, bill_number, company_name, shift_id, rate_per_kwh,
         energy_kwh, subtotal, tax_percent, tax_amount, service_fee, service_charge,
         soc_start, soc_end, rate_name, total, created_at,
         customer_id, customer_name, customer_pan, customer_address, customer_vehicle)
       VALUES (@transaction_id, @bill_number, @company_name, @shift_id, @rate_per_kwh,
               @energy_kwh, @subtotal, @tax_percent, @tax_amount, @service_fee, @service_charge,
               @soc_start, @soc_end, @rate_name, @total, @created_at,
               @customer_id, @customer_name, @customer_pan, @customer_address, @customer_vehicle)`
    )
    .run({
      transaction_id: tx.id,
      bill_number: billNumber,
      company_name: settings.company_name,
      shift_id: shiftId,
      rate_per_kwh: rate,
      energy_kwh: energy,
      subtotal,
      tax_percent: taxPercent,
      tax_amount: taxAmount,
      service_fee: serviceFee || 0,
      service_charge: serviceCharge || 0,
      soc_start: tx.soc_start != null ? tx.soc_start : null,
      soc_end: tx.soc_end != null ? tx.soc_end : null,
      rate_name: rateName,
      total,
      created_at: createdAt,
      customer_id: tx.customer_id || null,
      customer_name: tx.customer_name || null,
      customer_pan: tx.customer_pan || null,
      customer_address: tx.customer_address || null,
      customer_vehicle: tx.customer_vehicle || null
    });

  const bill = raw.prepare('SELECT * FROM bills WHERE id = ?').get(result.lastInsertRowid);

  raw
    .prepare(
      `INSERT INTO sync_queue (entity_type, entity_id, endpoint_key, payload, created_at)
       VALUES ('bill', ?, 'api_endpoint_bills', ?, ?)`
    )
    .run(bill.id, JSON.stringify(bill), createdAt);

  return bill;
}

module.exports = { generateBillForTransaction, findShiftForTime };
