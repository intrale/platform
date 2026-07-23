// =============================================================================
// Tests del wire-up post-sizing en pulpo.js (#3746).
//
// El wire-up vive dentro del callback `on('exit')` de `lanzarAgenteClaude` en
// `.pipeline/pulpo.js` (~L6452-6536). Cuando el skill `planner` termina la
// fase `sizing` con `resultado: aprobado`, `dividido: true` y `hijas_creadas`
// no vacío, invoca `autoPromoteSplitChildren` del módulo
// `lib/allowlist-recursive-promote.js`.
//
// Como el wire-up está embebido en un archivo de >9000 LOC que monta el daemon
// del Pulpo al cargar, no podemos `require()`-lo directamente. Combinamos dos
// estrategias (mismo patrón que `dashboard-handoff-widget.test.js`):
//
//   1. Tests estructurales: leemos el source de `pulpo.js` y verificamos que
//      el bloque condicional existe con la forma exacta del contrato.
//
//   2. Tests de comportamiento: ejecutamos la misma llamada que hace el
//      wire-up (`autoPromoteSplitChildren({ parentIssue, childrenIssues })`)
//      con el filtrado defensivo idéntico (`.map(Number).filter(...)`) y
//      verificamos el estado resultante de `.partial-pause.json` + audit log.
//
// Cinco casos vinculantes (receta del Arquitecto, comentario #4587684423):
//   1. Happy path: padre en allowlist → hijas agregadas + audit entry.
//   2. Padre fuera de allowlist → sin mutación + sin audit nuevo.
//   3. Sin contrato YAML (dividido:false o sin hijas_creadas) → wire-up no
//      invoca al módulo.
//   4. Idempotencia ante rebote del Planner.
//   5. Input malformado (strings, negativos, inyección de comandos).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PULPO_PATH = path.join(REPO_ROOT, '.pipeline', 'pulpo.js');
const PULPO_SRC = fs.readFileSync(PULPO_PATH, 'utf8');

// -----------------------------------------------------------------------------
// Setup: aislar `.partial-pause.json` y el audit log en un TMP_DIR por test
// run. PIPELINE_DIR_OVERRIDE redirige tanto `partial-pause` como
// `partial-pause-audit` (ambos lo respetan).
// -----------------------------------------------------------------------------

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-3746-planner-promote-'));
fs.mkdirSync(path.join(TMP_DIR, 'audit'), { recursive: true });
process.env.PIPELINE_DIR_OVERRIDE = TMP_DIR;
// #3625 grace mode OFF — los tests del módulo lo activan así, mantenemos
// consistencia para que la auditoría falle-closed estrictamente. Igual el
// wire-up SOLO hace adds (no removals), así que el gate no debería rechazar.
process.env.PARTIAL_PAUSE_STRICT_AUTH = '1';

// Limpiar el cache para que los módulos lean el TMP_DIR override.
for (const key of Object.keys(require.cache)) {
    if (key.includes(path.join('.pipeline', 'lib'))) {
        delete require.cache[key];
    }
}

const pp = require(path.join(REPO_ROOT, '.pipeline', 'lib', 'partial-pause'));
const audit = require(path.join(REPO_ROOT, '.pipeline', 'lib', 'partial-pause-audit'));
const recursivePromote = require(path.join(REPO_ROOT, '.pipeline', 'lib', 'allowlist-recursive-promote'));

function resetState() {
    const { PARTIAL_FILE, PAUSE_FILE } = pp._paths();
    try { fs.unlinkSync(PARTIAL_FILE); } catch {}
    try { fs.unlinkSync(PAUSE_FILE); } catch {}
    const auditFile = path.join(TMP_DIR, 'audit', 'partial-pause-mutations.jsonl');
    try { fs.unlinkSync(auditFile); } catch {}
}

function auditFile() {
    return path.join(TMP_DIR, 'audit', 'partial-pause-mutations.jsonl');
}

function readAuditEntries() {
    try {
        const raw = fs.readFileSync(auditFile(), 'utf8');
        return raw.split('\n')
            .filter(l => l.trim().length > 0)
            .map(l => JSON.parse(l));
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

// Réplica EXACTA del bloque condicional del wire-up (pulpo.js ~L6458-6502).
// Mantenerla sincronizada con `pulpo.js` para que los tests sigan el contrato.
function runWireUpSimulation({ skill, fase, data, issue }) {
    if (
        skill === 'planner' &&
        fase === 'sizing' &&
        data.resultado === 'aprobado' &&
        data.dividido === true &&
        Array.isArray(data.hijas_creadas) &&
        data.hijas_creadas.length > 0
    ) {
        const childrenIssues = data.hijas_creadas
            .map(Number)
            .filter(n => Number.isInteger(n) && n > 0);
        return recursivePromote.autoPromoteSplitChildren({
            parentIssue: Number(issue),
            childrenIssues,
        });
    }
    return { wireUpSkipped: true };
}

// -----------------------------------------------------------------------------
// Tests estructurales (validan el contrato del wire-up dentro de pulpo.js).
// -----------------------------------------------------------------------------

test('#3746 · wire-up: el bloque condicional existe en pulpo.js con la forma del contrato', () => {
    // Marker comment del bloque (sirve de ancla estable entre revisiones).
    assert.ok(PULPO_SRC.includes('#3746 — Auto-promoción de hijas a allowlist en el camino autónomo del Planner'),
        'falta el comentario marker #3746 del wire-up');
    // Las 5 condiciones del contrato YAML.
    assert.ok(/skill === 'planner'/.test(PULPO_SRC), 'falta condición skill === planner');
    assert.ok(/fase === 'sizing'/.test(PULPO_SRC), 'falta condición fase === sizing');
    assert.ok(/data\.resultado === 'aprobado'/.test(PULPO_SRC),
        'falta condición resultado === aprobado');
    assert.ok(/data\.dividido === true/.test(PULPO_SRC),
        'falta condición dividido === true');
    assert.ok(/Array\.isArray\(data\.hijas_creadas\)/.test(PULPO_SRC),
        'falta validación Array.isArray(data.hijas_creadas)');
});

test('#3746 · wire-up: usa autoPromoteSplitChildren del módulo (no reimplementa)', () => {
    // Reuso del módulo existente, prohibido reimplementar (regla inquebrantable #1).
    assert.ok(PULPO_SRC.includes("require('./lib/allowlist-recursive-promote')"),
        'el wire-up debe require() lib/allowlist-recursive-promote');
    assert.ok(PULPO_SRC.includes('autoPromoteSplitChildren'),
        'el wire-up debe invocar autoPromoteSplitChildren');
});

test('#3746 · wire-up: filtrado defensivo de IDs (Number + isInteger > 0)', () => {
    // El filtrado defensivo blinda contra strings, negativos, null e inyecciones.
    // Es parte de la disciplina A03 Injection que pidió security.
    assert.ok(/\.map\(Number\)/.test(PULPO_SRC),
        'falta .map(Number) en el filtrado de hijas_creadas');
    assert.ok(/Number\.isInteger\(n\) && n > 0/.test(PULPO_SRC),
        'falta Number.isInteger(n) && n > 0 en el filtrado');
});

test('#3746 · wire-up: try/catch envolvente (no bloquea moveFile del lifecycle)', () => {
    // Regla inquebrantable #6 (CA-2): el bloque NO debe propagar errores.
    assert.ok(PULPO_SRC.includes('Auto-promote (planner-sizing) falló (best-effort, no bloquea)'),
        'falta el log de fallback del catch envolvente');
});

test('#3746 · wire-up: NO escribe directo a .partial-pause.json (toda mutación vía setPartialPause)', () => {
    // Regla inquebrantable #2: prohibido fs.writeFileSync('.partial-pause.json').
    // La búsqueda es laxa para no atrapar callers legítimos en otros bloques de
    // pulpo.js — limitamos al rango del wire-up (después del marker #3746 y
    // antes del próximo bloque "STOP RECORDING").
    const start = PULPO_SRC.indexOf('#3746 — Auto-promoción');
    assert.ok(start >= 0, 'falta marker de inicio del wire-up');
    const end = PULPO_SRC.indexOf('STOP RECORDING + PULL VIDEO', start);
    assert.ok(end > start, 'falta marker de fin del wire-up');
    const wireUpBlock = PULPO_SRC.slice(start, end);
    assert.ok(!/writeFileSync\s*\(\s*['"`].*partial-pause/.test(wireUpBlock),
        'el wire-up NO debe hacer writeFileSync directo de .partial-pause.json');
});

// -----------------------------------------------------------------------------
// Tests de comportamiento (ejecutan la misma llamada que el wire-up).
// -----------------------------------------------------------------------------

test('#3746 CA-2 + CA-4 · happy path: padre en allowlist → hijas agregadas + audit entry', () => {
    resetState();
    // Padre en la allowlist.
    pp.setPartialPause([3715], {
        source: 'commander:leo',
        authorizedBy: 'commander:leo',
        justification: 'Setup test',
    });
    const auditBefore = readAuditEntries().length;

    const result = runWireUpSimulation({
        skill: 'planner',
        fase: 'sizing',
        issue: 3715,
        data: {
            resultado: 'aprobado',
            sizing: 'grande',
            dividido: true,
            hijas_creadas: [3722, 3723],
        },
    });

    assert.equal(result.promoted, true, 'la promoción debe haber ocurrido');
    assert.deepEqual(result.added.sort((a, b) => a - b), [3722, 3723],
        'deben haberse agregado las 2 hijas');
    assert.ok(result.expiresAt, 'debe tener expiresAt (TTL 48h)');

    const state = pp.getPipelineMode();
    assert.equal(state.mode, 'partial_pause');
    assert.deepEqual(state.allowedIssues.sort((a, b) => a - b), [3715, 3722, 3723],
        'allowed_issues debe incluir padre + hijas');
    assert.ok(state.authorizationTtls && state.authorizationTtls['3722'],
        'debe haber TTL para hija 3722');
    assert.equal(state.authorizationTtls['3722'].authorized_by, 'recursive-deps:from-3715',
        'authorized_by debe llevar el padre');

    const auditEntries = readAuditEntries();
    assert.ok(auditEntries.length > auditBefore, 'debe haber al menos 1 entrada nueva en audit');
    const lastEntry = auditEntries[auditEntries.length - 1];
    assert.equal(lastEntry.source, 'planner-split:auto');
    assert.equal(lastEntry.authorized_by, 'recursive-deps:from-3715');
    assert.equal(lastEntry.action, 'write');
    assert.deepEqual(lastEntry.diff.added.sort((a, b) => a - b), [3722, 3723]);
});

test('#3746 CA-3 · padre NO en allowlist → sin mutación + sin entrada audit nueva', () => {
    resetState();
    // Padre #3800 NO está en la allowlist; otro issue (#9999) sí.
    pp.setPartialPause([9999], {
        source: 'commander:leo',
        authorizedBy: 'commander:leo',
        justification: 'Setup: otro issue en allowlist, no el padre del split',
    });
    const auditBefore = readAuditEntries().length;
    const allowlistBefore = pp.getPipelineMode().allowedIssues.slice();

    const result = runWireUpSimulation({
        skill: 'planner',
        fase: 'sizing',
        issue: 3800,
        data: {
            resultado: 'aprobado',
            sizing: 'grande',
            dividido: true,
            hijas_creadas: [3801, 3802, 3803],
        },
    });

    assert.equal(result.promoted, false, 'no debe promover si el padre no está en allowlist');
    assert.equal(result.reason, 'parent_not_in_allowlist');

    const state = pp.getPipelineMode();
    assert.deepEqual(state.allowedIssues, allowlistBefore,
        'allowed_issues no debe cambiar');
    const auditAfter = readAuditEntries().length;
    assert.equal(auditAfter, auditBefore,
        'audit log no debe recibir entradas nuevas');
});

test('#3746 CA-1 negativo · sin contrato YAML (dividido:false o sin hijas_creadas) → wire-up no invoca módulo', () => {
    resetState();
    pp.setPartialPause([3715], {
        source: 'commander:leo',
        authorizedBy: 'commander:leo',
        justification: 'Setup test',
    });
    const auditBefore = readAuditEntries().length;
    const allowlistBefore = pp.getPipelineMode().allowedIssues.slice();

    // Caso A: dividido: false
    const r1 = runWireUpSimulation({
        skill: 'planner',
        fase: 'sizing',
        issue: 3715,
        data: {
            resultado: 'aprobado',
            sizing: 'medio',
            dividido: false,
        },
    });
    assert.equal(r1.wireUpSkipped, true, 'dividido:false → wire-up NO se ejecuta');

    // Caso B: sin hijas_creadas
    const r2 = runWireUpSimulation({
        skill: 'planner',
        fase: 'sizing',
        issue: 3715,
        data: {
            resultado: 'aprobado',
            sizing: 'grande',
            dividido: true,
            // hijas_creadas ausente
        },
    });
    assert.equal(r2.wireUpSkipped, true, 'sin hijas_creadas → wire-up NO se ejecuta');

    // Caso C: hijas_creadas vacío
    const r3 = runWireUpSimulation({
        skill: 'planner',
        fase: 'sizing',
        issue: 3715,
        data: {
            resultado: 'aprobado',
            sizing: 'grande',
            dividido: true,
            hijas_creadas: [],
        },
    });
    assert.equal(r3.wireUpSkipped, true, 'hijas_creadas vacío → wire-up NO se ejecuta');

    // Caso D: resultado:rechazado
    const r4 = runWireUpSimulation({
        skill: 'planner',
        fase: 'sizing',
        issue: 3715,
        data: {
            resultado: 'rechazado',
            dividido: true,
            hijas_creadas: [3722],
        },
    });
    assert.equal(r4.wireUpSkipped, true, 'resultado:rechazado → wire-up NO se ejecuta');

    // Caso E: skill distinto
    const r5 = runWireUpSimulation({
        skill: 'guru',
        fase: 'sizing',
        issue: 3715,
        data: {
            resultado: 'aprobado',
            dividido: true,
            hijas_creadas: [3722],
        },
    });
    assert.equal(r5.wireUpSkipped, true, 'skill !== planner → wire-up NO se ejecuta');

    // Caso F: fase distinta
    const r6 = runWireUpSimulation({
        skill: 'planner',
        fase: 'criterios',
        issue: 3715,
        data: {
            resultado: 'aprobado',
            dividido: true,
            hijas_creadas: [3722],
        },
    });
    assert.equal(r6.wireUpSkipped, true, 'fase !== sizing → wire-up NO se ejecuta');

    const state = pp.getPipelineMode();
    assert.deepEqual(state.allowedIssues, allowlistBefore,
        'allowed_issues no debe cambiar en ningún caso');
    const auditAfter = readAuditEntries().length;
    assert.equal(auditAfter, auditBefore,
        'audit log no debe recibir entradas nuevas');
});

test('#3746 CA-5 · idempotencia ante rebote: dos corridas con misma lista no duplican', () => {
    resetState();
    pp.setPartialPause([3715], {
        source: 'commander:leo',
        authorizedBy: 'commander:leo',
        justification: 'Setup test',
    });

    // Primera corrida.
    const r1 = runWireUpSimulation({
        skill: 'planner',
        fase: 'sizing',
        issue: 3715,
        data: {
            resultado: 'aprobado',
            dividido: true,
            hijas_creadas: [3722, 3723],
        },
    });
    assert.equal(r1.promoted, true);
    const lenAfter1 = pp.getPipelineMode().allowedIssues.length;

    // Segunda corrida con los mismos IDs (simula rebote del Planner).
    const r2 = runWireUpSimulation({
        skill: 'planner',
        fase: 'sizing',
        issue: 3715,
        data: {
            resultado: 'aprobado',
            dividido: true,
            hijas_creadas: [3722, 3723],
        },
    });
    // El módulo retorna promoted:true con added:[] y reason:'all_children_already_present'.
    assert.equal(r2.promoted, true);
    assert.deepEqual(r2.added || [], [], 'segunda corrida no debe agregar nada nuevo');
    assert.equal(r2.reason, 'all_children_already_present');

    const lenAfter2 = pp.getPipelineMode().allowedIssues.length;
    assert.equal(lenAfter1, lenAfter2,
        'la cantidad de allowed_issues debe ser idéntica entre corridas');
    // Verificación adicional sin duplicados (Set tamaño = array tamaño).
    const allowed = pp.getPipelineMode().allowedIssues;
    assert.equal(new Set(allowed).size, allowed.length,
        'allowed_issues no debe tener duplicados');
});

test('#3746 · input malformado: strings, negativos, null e inyección → filtrados', () => {
    resetState();
    pp.setPartialPause([3715], {
        source: 'commander:leo',
        authorizedBy: 'commander:leo',
        justification: 'Setup test',
    });

    const result = runWireUpSimulation({
        skill: 'planner',
        fase: 'sizing',
        issue: 3715,
        data: {
            resultado: 'aprobado',
            dividido: true,
            // Mezcla maliciosa: string no numérico, negativo, null, e intento
            // de inyección de shell embebido en un string.
            hijas_creadas: ['abc', -5, null, '3722; rm -rf /', undefined, 0],
        },
    });

    // Todos los inputs son inválidos → filtrado a [].
    // El módulo retorna { promoted: false, reason: 'no_children_declared' }.
    assert.equal(result.promoted, false,
        'sin hijas válidas tras filtrado → NO promueve');
    assert.equal(result.reason, 'no_children_declared',
        'el módulo debe reportar no_children_declared');

    // La allowlist no debe haber cambiado.
    const state = pp.getPipelineMode();
    assert.deepEqual(state.allowedIssues, [3715],
        'allowed_issues no debe cambiar con input malformado');
});

test('#3746 · input mixto válido/inválido: solo los válidos se promueven', () => {
    resetState();
    pp.setPartialPause([3715], {
        source: 'commander:leo',
        authorizedBy: 'commander:leo',
        justification: 'Setup test',
    });

    const result = runWireUpSimulation({
        skill: 'planner',
        fase: 'sizing',
        issue: 3715,
        data: {
            resultado: 'aprobado',
            dividido: true,
            // Algunos válidos, algunos no.
            hijas_creadas: [3722, 'abc', -5, 3723, null, 3724],
        },
    });

    assert.equal(result.promoted, true);
    assert.deepEqual(result.added.sort((a, b) => a - b), [3722, 3723, 3724],
        'solo los IDs enteros positivos deben promoverse');
});
