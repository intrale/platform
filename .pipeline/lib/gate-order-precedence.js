'use strict';

const fs = require('node:fs');
const path = require('node:path');

// El timestamp pertenece a la orden original, no al intento del worker.
function orderTime(name) {
  const match = /-(\d{17}|\d{13})\.json$/.exec(name);
  if (!match) throw new Error('Orden de caducidad sin timestamp original');
  const raw = match[1];
  if (raw.length === 13) return Number(raw);
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}.${raw.slice(14)}Z`;
  const time = Date.parse(iso);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== iso) {
    throw new Error('Timestamp de caducidad inválido');
  }
  return time;
}

function supersededGateOrder(data, { queueDir, name }) {
  if (data.origen !== 'gate-caducidad-sello' ||
      !['label', 'remove-label'].includes(data.action) ||
      !['qa:passed', 'qa:pending', 'qa:skipped'].includes(data.label)) return false;
  const target = data.target || 'issue';
  if (!['issue', 'pr'].includes(target) || !Number.isSafeInteger(data.issue) || data.issue <= 0) {
    throw new Error('Destino de orden de caducidad inválido');
  }
  const time = orderTime(name);
  const dir = path.join(queueDir, 'gate-order-precedence');
  const receipt = path.join(dir, `${target}-${data.issue}.json`);
  let previous;
  try { previous = JSON.parse(fs.readFileSync(receipt, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && !Number.isSafeInteger(previous.time)) throw new Error('Recibo de precedencia inválido');
  if (previous && previous.time > time) {
    data.discarded = 'superseded-gate-order';
    data.superseded_by = previous.name;
    return true;
  }
  // Persistir ANTES de la API: un fallo parcial o reinicio no habilita una
  // orden anterior. La misma generación puede completar todos sus reintentos.
  if (!previous || previous.time < time) {
    fs.mkdirSync(dir, { recursive: true });
    const temporary = `${receipt}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ time, name }));
    fs.renameSync(temporary, receipt);
  }
  return false;
}

module.exports = { supersededGateOrder };
