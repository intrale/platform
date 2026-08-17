'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pulpoPath = path.join(__dirname, '..', 'pulpo.js');

test('#5456 cuota semanal mid-turn ejecuta fallback en el mismo turno', () => {
  const source = fs.readFileSync(pulpoPath, 'utf8');
  const detectedAt = source.indexOf('weeklyQuotaMidTurn = { provider: cmdProvider };');
  const fallbackAt = source.indexOf("_maybeExecuteInflightFallback('quota_exhausted');", detectedAt);
  const ordinaryResultAt = source.indexOf("} else if (evt.is_error !== true) {", detectedAt);

  assert.ok(detectedAt >= 0, 'debe conservar la deteccion tipada de cuota semanal');
  assert.ok(fallbackAt > detectedAt, 'debe ejecutar el fallback despues de detectar la cuota');
  assert.ok(fallbackAt < ordinaryResultAt,
    'el fallback debe ejecutarse dentro de la rama de cuota, antes del camino de exito ordinario');

  const wiring = source.slice(detectedAt, ordinaryResultAt);
  assert.match(wiring, /_emitShadowSignal\('quota_exhausted'\)/,
    'debe dejar telemetria de la decision antes de ejecutar el reemplazo');
  assert.match(wiring, /_maybeExecuteInflightFallback\('quota_exhausted'\)/,
    'debe reutilizar el ejecutor in-flight con cap y lock anti-duplicado');
});
