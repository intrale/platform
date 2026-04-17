#!/usr/bin/env node
// =============================================================================
// Simulador de estado de infra — issue #2306
//
// Escribe .pipeline/infra-health.json con distintos escenarios para grabar el
// video de QA que cubre los 4 estados visuales (verde/amarillo/rojo/stale)
// + inicialización + archivo ausente.
//
// Uso:
//   node simular-rebote-infra.js ok        # 🟢 Pipeline sano
//   node simular-rebote-infra.js warn      # 🟡 Retries entre 5–20%
//   node simular-rebote-infra.js alert     # 🔴 Circuit breaker abierto
//   node simular-rebote-infra.js dns-fail  # 🔴 DNS FAIL
//   node simular-rebote-infra.js stale     # ⚪ Healthcheck > 5min
//   node simular-rebote-infra.js init      # 🔄 Inicializando (todo null)
//   node simular-rebote-infra.js clear     # Eliminar el archivo (feature flag OFF)
//
// Este script NO es parte del pipeline productivo — es solo para grabar QA
// y para pruebas manuales del dashboard /monitor.
// =============================================================================

const fs = require('fs');
const path = require('path');

const PIPELINE = path.resolve(__dirname);
const TARGET = path.join(PIPELINE, 'infra-health.json');

const scenario = (process.argv[2] || 'ok').toLowerCase();

function isoNow(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function writeState(state) {
  fs.writeFileSync(TARGET, JSON.stringify(state, null, 2));
  console.log('[simular-rebote-infra] escrito ' + TARGET);
  console.log(JSON.stringify(state, null, 2));
}

switch (scenario) {
  case 'ok': {
    writeState({
      dns: { status: 'OK', lastCheck: isoNow(), latencyMs: 142 },
      retries: { lastHour: 2, previousHour: 3, ratePercent: 1.2 },
      circuitBreaker: { state: 'closed', openedAt: null, lastIssue: null, consecutiveFailures: 0 }
    });
    break;
  }
  case 'warn': {
    writeState({
      dns: { status: 'OK', lastCheck: isoNow(), latencyMs: 3200 },
      retries: { lastHour: 18, previousHour: 12, ratePercent: 12.5 },
      circuitBreaker: { state: 'closed', openedAt: null, lastIssue: null, consecutiveFailures: 0 }
    });
    break;
  }
  case 'alert':
  case 'open': {
    writeState({
      dns: { status: 'OK', lastCheck: isoNow(), latencyMs: 850 },
      retries: { lastHour: 47, previousHour: 21, ratePercent: 28.4 },
      circuitBreaker: {
        state: 'open',
        openedAt: isoNow(-240000), // abierto hace 4 minutos
        lastIssue: { number: 2296, reason: 'ENOTFOUND' },
        consecutiveFailures: 3
      }
    });
    break;
  }
  case 'dns-fail': {
    writeState({
      dns: { status: 'FAIL', lastCheck: isoNow(), latencyMs: null },
      retries: { lastHour: 35, previousHour: 9, ratePercent: 22.0 },
      circuitBreaker: {
        state: 'open',
        openedAt: isoNow(-60000),
        lastIssue: { number: 2296, reason: 'ENOTFOUND' },
        consecutiveFailures: 3
      }
    });
    break;
  }
  case 'stale': {
    // lastCheck > 5 minutos
    writeState({
      dns: { status: 'OK', lastCheck: isoNow(-600000), latencyMs: 140 },
      retries: { lastHour: 1, previousHour: 1, ratePercent: 0.5 },
      circuitBreaker: { state: 'closed', openedAt: null, lastIssue: null, consecutiveFailures: 0 }
    });
    break;
  }
  case 'init': {
    writeState({
      dns: null,
      retries: null,
      circuitBreaker: null
    });
    break;
  }
  case 'clear':
  case 'off': {
    if (fs.existsSync(TARGET)) {
      fs.unlinkSync(TARGET);
      console.log('[simular-rebote-infra] eliminado ' + TARGET + ' (sección no renderiza)');
    } else {
      console.log('[simular-rebote-infra] no existía ' + TARGET);
    }
    break;
  }
  default: {
    console.error('[simular-rebote-infra] escenario desconocido: ' + scenario);
    console.error('Opciones: ok | warn | alert | dns-fail | stale | init | clear');
    process.exit(1);
  }
}
