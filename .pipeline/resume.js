#!/usr/bin/env node
// =============================================================================
// resume.js — Comando manual para reanudar el pipeline tras un corte de red
//
// Uso:   node .pipeline/resume.js
//
// Comportamiento (issue #2305):
//   - Si el CB está `open`: lo cierra, resetea contadores y encola un mensaje
//     Telegram `🟢 Pipeline reanudado`. Exit 0.
//   - Si el CB está `closed`: imprime "nada que hacer" y exit 0 (idempotente).
//   - Sin prompts interactivos — es un comando de emergencia.
//   - Exit codes: 0 OK, 1 estado corrupto, 2 archivo no existe.
//   - Sólo corre desde el host del pipeline (no hay listener HTTP).
// =============================================================================

const fs = require('fs');
const path = require('path');

const cb = require('./circuit-breaker-infra');
const { redact } = require('./redact');

const PIPELINE = path.resolve(__dirname);
const TELEGRAM_QUEUE = path.join(PIPELINE, 'servicios', 'telegram', 'pendiente');

function encolarTelegram(text) {
  try {
    fs.mkdirSync(TELEGRAM_QUEUE, { recursive: true });
    const filename = `${Date.now()}-resume.json`;
    const safeText = redact(text);
    fs.writeFileSync(
      path.join(TELEGRAM_QUEUE, filename),
      JSON.stringify({ text: safeText, parse_mode: 'Markdown' })
    );
    return true;
  } catch (e) {
    console.error(`No se pudo encolar mensaje Telegram: ${e.message}`);
    return false;
  }
}

function main() {
  // Verificación 1: el archivo está corrupto → exit 1
  if (fs.existsSync(cb.STATE_FILE)) {
    try {
      JSON.parse(fs.readFileSync(cb.STATE_FILE, 'utf8'));
    } catch {
      console.error(`⚠️  Archivo de estado corrupto: ${path.basename(cb.STATE_FILE)}`);
      console.error('    Eliminá el archivo manualmente y volvé a ejecutar.');
      process.exit(1);
    }
  }

  const result = cb.resume();

  if (!result.changed) {
    console.log('Circuit breaker ya está cerrado. Nada que hacer.');
    process.exit(0);
  }

  // CB recién reanudado — confirmar al operador y notificar por Telegram.
  const prev = result.previous;
  const trigger = prev.last_issue_trigger ? `#${prev.last_issue_trigger}` : 'desconocido';
  const errCode = prev.last_error_code || 'sin código';

  console.log(`✅ Circuit breaker reanudado. Último error: ${redact(errCode)} (${trigger})`);

  const encolado = encolarTelegram('🟢 Pipeline reanudado\nTomando issues pendientes.');
  if (encolado) {
    console.log('Mensaje de reanudación enviado.');
  } else {
    console.log('⚠️  No se pudo encolar el mensaje Telegram, pero el CB quedó cerrado.');
  }

  process.exit(0);
}

try {
  main();
} catch (e) {
  console.error(`Error inesperado: ${redact(e.message || String(e))}`);
  process.exit(1);
}
