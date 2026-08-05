// =============================================================================
// quota-setflag-config-corrupta-5172.test.js — #5172 (rebote rev-1)
//
// REGRESIÓN que reportó la fase `aprobacion`:
//   `resolveMaxDays()` se invoca DENTRO de `setFlag()`, así que el error tipado
//   del config-resolver caía en el camino de ESCRITURA del flag de cuota. Con
//   `config.yaml` corrupto, `setFlag` sin `maxDays` explícito TIRABA y el flag
//   NUNCA se persistía. El único call-site de producción
//   (`lib/agent-launcher/dispatch-with-fallback.js`) no pasa `maxDays` y traga
//   el throw en un catch best-effort => el pipeline perdía la señal de cuota
//   agotada y seguía despachando contra un proveedor en 429 (FAIL-OPEN).
//
// Lo que se resuelve en ese punto es sólo un cap de TTL cuyo default es seguro
// por construcción, así que la acción conservadora ante config ilegible es
// PERSISTIR el flag con el TTL default — no perder la señal.
//
// Cada escenario corre en un proceso hijo: `quota-exhausted` cachea la sección
// de config a nivel de módulo y el resolver cachea el documento por ruta.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { seedProductManifest } = require('./_test-helpers');

const QUOTA_MOD = path.join(__dirname, '..', 'quota-exhausted.js');

const YAML_CORRUPTO = 'foo: [1, 2\n  bar: : :\n';
// El reloj y el candidato de reset se fijan más abajo. Así el test no depende
// de cuánto falta, en el calendario real, para el próximo reset semanal.
const YAML_SANO_TTL = 'quota_detector:\n  resets_at_cap_max_days: 1\n';

/**
 * Corre `setFlag` en un proceso hijo contra un `.pipeline/` temporal con el
 * `config.yaml` indicado. Devuelve `{ threw, existe, payload }`.
 */
function correrSetFlag(configYaml, opts) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q5172-'));
    fs.writeFileSync(path.join(dir, 'config.yaml'), configYaml);
    seedProductManifest(dir);   // #5174 — la configuración vive partida: el otro lado también

    const script = `
        process.env.PIPELINE_DIR_OVERRIDE = ${JSON.stringify(dir)};
        const fs = require('fs'), path = require('path');
        const q = require(${JSON.stringify(QUOTA_MOD)});
        const flag = path.join(${JSON.stringify(dir)}, 'quota-exhausted.json');
        let threw = null;
        try { q.setFlag(${JSON.stringify(opts)}); }
        catch (e) { threw = e.name || 'Error'; }
        const existe = fs.existsSync(flag);
        process.stdout.write(JSON.stringify({
            threw,
            existe,
            payload: existe ? JSON.parse(fs.readFileSync(flag, 'utf8')) : null,
        }));
    `;
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out);
}

const BASE = { errorType: 'usage_limit_reached', provider: 'anthropic', auditLogEnabled: false };

// Para MEDIR el TTL hace falta un errorType que NO sea `usage_limit_reached`:
// ese es el cap rolling de Codex (1h fija), donde `maxDays` sólo acota y no
// define. Un `resetsAt` fijo permite comparar ambos caps con reloj hermético.
const TEST_NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const BASE_TTL = {
    errorType: 'rate_limit_error',
    provider: 'anthropic',
    auditLogEnabled: false,
    now: TEST_NOW,
    // Con config corrupta, el default de 7d acepta este candidato de 3d. Con
    // config sana, el cap de 1d lo rechaza y fija el techo configurado.
    resetsAt: TEST_NOW + 3 * 86400000,
};

test('config corrupta + setFlag SIN maxDays => el flag SE ESCRIBE (no fail-open)', () => {
    const r = correrSetFlag(YAML_CORRUPTO, BASE);
    assert.strictEqual(r.threw, null, 'setFlag no debe propagar la violación de config');
    assert.strictEqual(r.existe, true, 'el flag de cuota agotada debe quedar persistido');
    assert.ok(r.payload, 'el payload debe ser JSON legible');
});

function ttlEnDias(r, desde) {
    const slot = r.payload.providers ? r.payload.providers.anthropic : r.payload;
    return (Date.parse(slot.resets_at) - desde) / 86400000;
}

test('config corrupta => el TTL queda acotado por el default conservador de 7d', () => {
    const dias = ttlEnDias(correrSetFlag(YAML_CORRUPTO, BASE_TTL), TEST_NOW);
    // Sin config legible el techo es DEFAULT_MAX_RESETS_AT_DAYS; dentro de ese
    // techo `capResetsAt` puede elegir el reset semanal, así que se acota el
    // rango en vez de fijar un valor: lo que importa es que NO hay flag eterno.
    assert.ok(dias > 0 && dias <= 7.01, `TTL fuera del techo seguro: ${dias.toFixed(2)}d`);
});

test('config corrupta + maxDays explícito => sigue funcionando (contrato #3077 intacto)', () => {
    const r = correrSetFlag(YAML_CORRUPTO, Object.assign({}, BASE, { maxDays: 2 }));
    assert.strictEqual(r.threw, null);
    assert.strictEqual(r.existe, true);
});

test('config SANA => el TTL configurado se sigue aplicando (no se degradó a default)', () => {
    const r = correrSetFlag(YAML_SANO_TTL, BASE_TTL);
    assert.strictEqual(r.threw, null);
    const dias = ttlEnDias(r, TEST_NOW);
    assert.ok(dias > 0.95 && dias < 1.05, `TTL esperado ~1d (config), obtenido ${dias.toFixed(2)}d`);
});

test('config corrupta vs SANA => el techo difiere (prueba que la config SÍ se lee cuando es legible)', () => {
    const conCorrupta = ttlEnDias(correrSetFlag(YAML_CORRUPTO, BASE_TTL), TEST_NOW);
    const conSana = ttlEnDias(correrSetFlag(YAML_SANO_TTL, BASE_TTL), TEST_NOW);
    assert.ok(
        conCorrupta > conSana,
        `la degradación debe ser observable: corrupta=${conCorrupta.toFixed(2)}d sana=${conSana.toFixed(2)}d`
    );
});
