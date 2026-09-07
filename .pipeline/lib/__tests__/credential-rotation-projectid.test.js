// =============================================================================
// credential-rotation-projectid.test.js — Issue #5901 · CA-5..CA-10
//
// El eje `(projectId, env_var)` de la rotación. Cada bloque corresponde a un CA:
//
//   CA-5  · estado indexado por el PAR, con clave ESTRUCTURADA (nunca concatenada).
//   CA-6  · el estado vive FUERA del árbol del repo.
//   CA-7  · migración del estado legacy FAIL-SAFE: se descarta y avisa, nunca silencio.
//   CA-8  · `project_id` obligatorio en el inventario, sin default silencioso a `kernel`.
//   CA-9  · el recordatorio nombra `Proyecto:` primero; `kernel` → `Kernel (plataforma)`.
//   CA-10 · una alerta por `(env_var, threshold)` que lista los proyectos; el
//           ESTADO se sigue escribiendo por cada `(projectId, env_var)`.
//
// Higiene (REQ-SEC-6): ningún test imprime valores de credenciales. Sólo
// nombres de variable, presencia y forma. Datos sintéticos `FAKE-*`.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cron = require('../credential-rotation-cron');
const { KERNEL_PROJECT_ID } = require('../safe-project-id');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function dateUTC(iso) {
    return new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
}

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rot-5901-'));
}

/** Fila de inventario ya parseada, del proyecto que se pida. */
function fila({ projectId, envVar = 'SHARED_API_KEY', provider = 'p', owner = 'leo',
                lastRotated = '2026-04-01', expiresAt = '2026-06-30' } = {}) {
    return {
        project_id: projectId,
        provider,
        env_var: envVar,
        owner,
        last_rotated: dateUTC(lastRotated),
        expires_at: dateUTC(expiresAt),
        runbook_url: 'https://example.test/runbook',
    };
}

// =============================================================================
// CA-5 — Estado indexado por (projectId, env_var), clave estructurada
// =============================================================================

test('CA-5: rotar el secreto del proyecto A NO marca como rotado el de B', () => {
    const filas = [
        fila({ projectId: 'proyecto-a' }),
        fila({ projectId: 'proyecto-b' }),
    ];

    // Tick 1: ambos en T-14, ambos alertan y ambos quedan con su propio slot.
    const r1 = cron.evaluateRotationState({ now: dateUTC('2026-06-16'), inventoryRows: filas, state: {} });
    assert.equal(r1.alerts.length, 2, 'cada proyecto genera su alerta');
    assert.ok(r1.nextState['proyecto-a'].SHARED_API_KEY.thresholds_sent['T-14']);
    assert.ok(r1.nextState['proyecto-b'].SHARED_API_KEY.thresholds_sent['T-14']);

    // El bug que cierra el issue: con estado plano, marcar A silenciaba a B.
    // Simulamos que SOLO A tiene estado y verificamos que B sigue alertando.
    const soloA = { 'proyecto-a': { SHARED_API_KEY: { last_rotated: '2026-04-01', thresholds_sent: { 'T-14': '2026-06-16' } } } };
    const r2 = cron.evaluateRotationState({ now: dateUTC('2026-06-16'), inventoryRows: filas, state: soloA });
    assert.equal(r2.alerts.length, 1, 'B no puede quedar silenciado por el estado de A');
    assert.equal(r2.alerts[0].project_id, 'proyecto-b');
});

test('CA-5: el mismo env_var en dos proyectos ocupa DOS casilleros distintos', () => {
    const filas = [fila({ projectId: 'proyecto-a' }), fila({ projectId: 'proyecto-b' })];
    const r = cron.evaluateRotationState({ now: dateUTC('2026-06-16'), inventoryRows: filas, state: {} });
    assert.deepEqual(Object.keys(r.nextState).sort(), ['proyecto-a', 'proyecto-b']);
    assert.notEqual(r.nextState['proyecto-a'].SHARED_API_KEY,
        r.nextState['proyecto-b'].SHARED_API_KEY,
        'los slots no pueden ser el MISMO objeto: mutar uno mutaria el otro');
});

test('CA-5: la clave es ESTRUCTURADA — el estado NO contiene claves concatenadas', () => {
    const filas = [fila({ projectId: 'proyecto-a' })];
    const r = cron.evaluateRotationState({ now: dateUTC('2026-06-16'), inventoryRows: filas, state: {} });
    for (const clave of Object.keys(r.nextState)) {
        assert.doesNotMatch(clave, /[:|\s]/,
            `'${clave}' parece una clave concatenada; el eje debe ser anidado (REQ-SEC-2)`);
    }
    assert.equal(typeof r.nextState['proyecto-a'], 'object');
    assert.equal(typeof r.nextState['proyecto-a'].SHARED_API_KEY, 'object');
});

test('CA-5: los contenedores del estado no tienen prototipo (anti-pollution)', () => {
    const filas = [fila({ projectId: 'proyecto-a' })];
    const r = cron.evaluateRotationState({ now: dateUTC('2026-06-16'), inventoryRows: filas, state: {} });
    assert.equal(Object.getPrototypeOf(r.nextState), null);
    assert.equal(Object.getPrototypeOf(r.nextState['proyecto-a']), null);
});

test('CA-5: writeSlot rechaza un projectId reservado de prototipo (fail-closed)', () => {
    const estado = Object.create(null);
    for (const malo of ['__proto__', 'constructor', 'prototype', '', 'A/B', undefined]) {
        assert.throws(() => cron.writeSlot(estado, malo, 'KEY', { x: 1 }),
            /projectId invalido/, `deberia rechazar '${String(malo)}'`);
    }
    assert.deepEqual(Object.keys(estado), []);
    assert.equal(({}).x, undefined, 'ningun objeto literal quedo contaminado');
});

test('CA-5: readSlot no lee propiedades heredadas del prototipo', () => {
    const estado = { kernel: { KEY: { last_rotated: '2026-04-01' } } };
    assert.ok(cron.readSlot(estado, 'kernel', 'KEY'));
    assert.equal(cron.readSlot(estado, 'constructor', 'KEY'), undefined);
    assert.equal(cron.readSlot(estado, 'kernel', 'toString'), undefined);
    assert.equal(cron.readSlot(estado, 'kernel', 'hasOwnProperty'), undefined);
});

test('CA-5: evaluateRotationState no MUTA el estado que le pasa el caller', () => {
    const filas = [fila({ projectId: 'proyecto-a' })];
    const original = { 'proyecto-a': { SHARED_API_KEY: { last_rotated: '2026-04-01', thresholds_sent: {} } } };
    const copia = JSON.parse(JSON.stringify(original));
    cron.evaluateRotationState({ now: dateUTC('2026-06-16'), inventoryRows: filas, state: original });
    assert.deepEqual(original, copia, 'el estado de entrada debe quedar intacto');
});

// =============================================================================
// CA-6 — El estado vive FUERA del árbol del repo
// =============================================================================

test('CA-6: defaultStateFilePath resuelve FUERA del arbol del repo', () => {
    const resuelto = cron.defaultStateFilePath(path.join(REPO_ROOT, '.pipeline'));
    const rel = path.relative(REPO_ROOT, resuelto);
    assert.ok(rel.startsWith('..') || path.isAbsolute(rel),
        `el estado no puede vivir dentro del repo; resolvio a ${rel}`);
    assert.ok(resuelto.startsWith(cron.EXTERNAL_STATE_DIR));
    assert.match(resuelto, /credential-reminder-state\.json$/);
});

test('CA-6: el path resuelto ignora el pipelineDir (no depende del checkout)', () => {
    assert.equal(
        cron.defaultStateFilePath('/repo-uno/.pipeline'),
        cron.defaultStateFilePath('/repo-dos/.pipeline'),
        'dos worktrees distintos comparten el mismo estado externo',
    );
    assert.equal(cron.defaultStateFilePath(undefined), cron.defaultStateFilePath(null));
});

test('CA-6: el path LEGACY dentro del repo se conserva solo para detectarlo', () => {
    const legacy = cron.legacyStateFilePath(path.join(REPO_ROOT, '.pipeline'));
    assert.ok(legacy.startsWith(path.join(REPO_ROOT, '.pipeline')));
    assert.notEqual(legacy, cron.defaultStateFilePath(path.join(REPO_ROOT, '.pipeline')));
});

test('CA-6: el archivo de estado NO esta trackeado y esta cubierto por el guard', () => {
    const inventario = require('../sensitive-paths');
    const clasificacion = inventario.clasificarPath('.pipeline/credential-reminder-state.json');
    assert.ok(clasificacion, 'el path debe estar en el inventario de paths sensibles');
    assert.equal(clasificacion.requiereIgnore, true);
    assert.equal(clasificacion.id, 'pipeline-credential-reminder-state');
});

test('CA-6: runRotationTick crea el directorio externo si no existe', () => {
    const dir = tmpDir();
    try {
        const inventoryFile = path.join(dir, 'inv.md');
        fs.writeFileSync(inventoryFile, [
            '| project_id | provider | env_var | owner | last_rotated | expires_at |',
            '|------------|----------|---------|-------|--------------|------------|',
            '| kernel | p | `KEY` | leo | 2026-04-01 | 2026-06-30 |',
        ].join('\n'));
        // Directorio inexistente a propósito (host recién provisionado).
        const stateFile = path.join(dir, 'no', 'existe', 'state.json');
        const r = cron.runRotationTick({
            pipelineDir: dir,
            now: dateUTC('2026-06-16'),
            sendTelegramFn: () => {},
            inventoryPath: inventoryFile,
            statePath: stateFile,
        });
        assert.equal(r.errors.filter((e) => e.stage === 'persist-state').length, 0);
        assert.ok(fs.existsSync(stateFile), 'el estado debe haberse escrito');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// =============================================================================
// CA-7 — Migración del estado legacy FAIL-SAFE
// =============================================================================

test('CA-7: el estado legacy plano se DESCARTA (no se hereda a todos los proyectos)', () => {
    const legacy = {
        ANTHROPIC_API_KEY: { last_rotated: '2026-04-01', thresholds_sent: { 'T-14': '2026-06-16' } },
        OPENAI_API_KEY: { last_rotated: '2026-04-01', last_expired_alert: '2026-06-30' },
    };
    const r = cron.migrateLegacyState(legacy);
    assert.equal(r.migrated, true);
    assert.equal(r.discarded, 2);
    assert.deepEqual(Object.keys(r.state), [], 'heredarlo silenciaria secretos vencidos');
});

test('CA-7: descartar el legacy DISPARA recordatorio, nunca silencio', () => {
    const dir = tmpDir();
    try {
        const inventoryFile = path.join(dir, 'inv.md');
        const stateFile = path.join(dir, 'state.json');
        fs.writeFileSync(inventoryFile, [
            '| project_id | provider | env_var | owner | last_rotated | expires_at |',
            '|------------|----------|---------|-------|--------------|------------|',
            '| kernel | p | `KEY` | leo | 2026-04-01 | 2026-06-30 |',
        ].join('\n'));
        // Estado legacy que, si se heredara, silenciaría T-14.
        fs.writeFileSync(stateFile, JSON.stringify({
            KEY: { last_rotated: '2026-04-01', thresholds_sent: { 'T-14': '2026-06-16' } },
        }));

        const enviados = [];
        const logs = [];
        const r = cron.runRotationTick({
            pipelineDir: dir,
            now: dateUTC('2026-06-16'),
            sendTelegramFn: (m) => enviados.push(m),
            inventoryPath: inventoryFile,
            statePath: stateFile,
            log: (m) => logs.push(m),
        });
        assert.equal(r.alerts.length, 1, 'el descarte re-evalua thresholds: alerta, no silencio');
        assert.equal(enviados.length, 1);
        assert.equal(r.legacyStateDiscarded, 1);
        assert.ok(logs.some((l) => /legacy plano descartado/.test(l)),
            'el descarte deja rastro en el log');
        assert.ok(r.errors.some((e) => e.stage === 'migrate-state'),
            'el operador lo ve en errors[], no solo en el log');
        // El estado reescrito ya es anidado.
        const guardado = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        assert.ok(guardado.kernel && guardado.kernel.KEY);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('CA-7: un estado YA anidado se adopta sin descartar', () => {
    const anidado = { kernel: { KEY: { last_rotated: '2026-04-01', thresholds_sent: { 'T-14': '2026-06-16' } } } };
    const r = cron.migrateLegacyState(anidado);
    assert.equal(r.migrated, false);
    assert.equal(r.discarded, 0);
    assert.ok(r.state.kernel.KEY.thresholds_sent['T-14']);
});

test('CA-7: la migracion filtra slugs invalidos de un estado manipulado', () => {
    const hostil = {
        kernel: { KEY: { last_rotated: '2026-04-01' } },
        '__proto__': { KEY: { polluted: true } },
        'CON/BARRA': { KEY: {} },
        'MAYUS': { KEY: {} },
    };
    const r = cron.migrateLegacyState(hostil);
    assert.deepEqual(Object.keys(r.state), ['kernel']);
    assert.equal(({}).polluted, undefined);
});

test('CA-7: entradas no-objeto o basura no rompen la migracion', () => {
    for (const basura of [null, undefined, 42, 'texto', [], { a: 1 }, { a: null }]) {
        const r = cron.migrateLegacyState(basura);
        assert.equal(typeof r.state, 'object');
        assert.equal(Object.getPrototypeOf(r.state), null);
    }
});

// =============================================================================
// CA-8 — `project_id` obligatorio, sin default silencioso
// =============================================================================

test('CA-8: el parser lee la columna project_id', () => {
    const rows = cron.parseInventoryMarkdown([
        '| project_id | provider | env_var | owner | last_rotated | expires_at |',
        '|------------|----------|---------|-------|--------------|------------|',
        '| acme-corp | p | `KEY` | leo | 2026-04-01 | 2026-06-30 |',
    ].join('\n'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].project_id, 'acme-corp');
});

test('CA-8: celda ausente/vacia/invalida => applies:false CON rastro, NUNCA default a kernel', () => {
    const casos = ['', '   ', 'MAYUS', 'con espacio', '../x', 'a/b', '__proto__', 'constructor'];
    for (const celda of casos) {
        const rows = cron.parseInventoryMarkdown([
            '| project_id | provider | env_var | owner | last_rotated | expires_at |',
            '|------------|----------|---------|-------|--------------|------------|',
            `| ${celda} | p | \`KEY\` | leo | 2026-04-01 | 2026-06-30 |`,
        ].join('\n'));
        assert.equal(rows.length, 1, `la fila no puede desaparecer en silencio ('${celda}')`);
        assert.equal(rows[0].applies, false);
        assert.equal(rows[0].invalid_project_id, true);
        assert.notEqual(rows[0].project_id, KERNEL_PROJECT_ID,
            `'${celda}' no puede defaultear a kernel: reintroduce el casillero compartido`);
        assert.match(rows[0].exclusion_reason, /project_id/);
    }
});

test('CA-8: una fila sin project_id valido NO genera alerta y SI genera error visible', () => {
    const dir = tmpDir();
    try {
        const inventoryFile = path.join(dir, 'inv.md');
        fs.writeFileSync(inventoryFile, [
            '| project_id | provider | env_var | owner | last_rotated | expires_at |',
            '|------------|----------|---------|-------|--------------|------------|',
            '|  | p | `HUERFANA` | leo | 2026-04-01 | 2026-06-30 |',
            '| kernel | p | `SANA` | leo | 2026-04-01 | 2026-06-30 |',
        ].join('\n'));
        const enviados = [];
        const r = cron.runRotationTick({
            pipelineDir: dir,
            now: dateUTC('2026-06-16'),
            sendTelegramFn: (m) => enviados.push(m),
            inventoryPath: inventoryFile,
            statePath: path.join(dir, 'state.json'),
        });
        assert.equal(r.alerts.length, 1, 'solo alerta la fila con proyecto resuelto');
        assert.equal(r.alerts[0].env_var, 'SANA');
        const errores = r.errors.filter((e) => e.env_var === 'HUERFANA');
        assert.equal(errores.length, 1, 'la fila huerfana debe verse en errors[]');
        assert.match(errores[0].message, /project_id/);
        // Ningún mensaje enviado menciona la huérfana: no se alerta sin proyecto.
        assert.ok(enviados.every((m) => !/HUERFANA/.test(m)));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('CA-8 · INVENTARIO REAL: ninguna fila resuelve a project_id vacio/undefined/invalido', () => {
    const md = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'secrets-inventory.md'), 'utf8');
    const rows = cron.parseInventoryMarkdown(md);
    assert.ok(rows.length >= 13, `el inventario real debe tener >= 13 filas, tiene ${rows.length}`);
    const { isSafeProjectId } = require('../safe-project-id');
    for (const row of rows) {
        assert.ok(isSafeProjectId(row.project_id),
            `docs/secrets-inventory.md linea ${row.source_line} (${row.env_var}) `
            + `resuelve a project_id='${row.project_id}', que no es un slug valido`);
    }
    assert.equal(rows.filter((r) => r.invalid_project_id).length, 0);
});

test('CA-8 · INVENTARIO REAL: la columna project_id esta declarada en el header', () => {
    const md = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'secrets-inventory.md'), 'utf8');
    const header = md.split('\n').find((l) => l.startsWith('|') && l.includes('env_var'));
    assert.ok(header, 'no se encontro el header de la tabla');
    assert.match(header, /\|\s*project_id\s*\|/, 'project_id debe ser columna del inventario');
});

// =============================================================================
// CA-9 — El recordatorio nombra el proyecto primero
// =============================================================================

test('CA-9: `Proyecto:` es el PRIMER campo del mensaje, antes de Provider', () => {
    const msg = cron.buildTelegramMessage(
        { project_id: 'acme-corp', provider: 'p', env_var: 'KEY', owner: 'leo' },
        { key: 'T-7', daysRemaining: 7, icon: '⚠️', expired: false },
    );
    const iProyecto = msg.indexOf('Proyecto:');
    const iProvider = msg.indexOf('Provider:');
    assert.ok(iProyecto > -1, 'el mensaje debe nombrar el proyecto');
    assert.ok(iProyecto < iProvider, '`Proyecto:` va ANTES de `Provider:`');
});

test('CA-9: kernel se muestra como "Kernel (plataforma)", no como slug tecnico', () => {
    const msg = cron.buildTelegramMessage(
        { project_id: KERNEL_PROJECT_ID, provider: 'p', env_var: 'KEY', owner: 'leo' },
        { key: 'T-7', daysRemaining: 7, icon: '⚠️', expired: false },
    );
    assert.match(msg, /Proyecto:\s+Kernel \(plataforma\)/);
});

test('CA-9: un slug no validado NUNCA se refleja en el mensaje', () => {
    const msg = cron.buildTelegramMessage(
        { project_id: '<script>alert(1)</script>', provider: 'p', env_var: 'KEY', owner: 'leo' },
        { key: 'T-7', daysRemaining: 7, icon: '⚠️', expired: false },
    );
    assert.doesNotMatch(msg, /<script>/);
    assert.match(msg, /\(proyecto inválido\)/);
});

test('CA-9: el mensaje de metadata pendiente tambien nombra el proyecto', () => {
    const r = cron.evaluateRotationState({
        now: dateUTC('2026-08-03'),
        inventoryRows: [{
            project_id: 'acme-corp', provider: 'p', env_var: 'KEY', owner: 'leo',
            metadata_missing: true, runbook_url: 'https://example.test',
        }],
        state: {},
    });
    assert.equal(r.alerts.length, 1);
    assert.match(r.alerts[0].message, /Proyecto: acme-corp/);
    assert.equal(r.alerts[0].project_id, 'acme-corp');
});

test('CA-9 · anti-leak: el mensaje sigue sin llevar valores de credenciales', () => {
    const msg = cron.buildTelegramMessage(
        {
            project_id: 'acme-corp', provider: 'p', env_var: 'KEY', owner: 'leo',
            secret_value: 'FAKE-sk-ant-NO-DEBE-APARECER',
        },
        { key: 'T-0', daysRemaining: -3, icon: '🔴', expired: true },
    );
    assert.doesNotMatch(msg, /FAKE-/);
    assert.doesNotMatch(msg, /NO-DEBE-APARECER/);
});

// =============================================================================
// CA-10 — Una alerta por (env_var, threshold) que lista los proyectos
// =============================================================================

test('CA-10: N proyectos con el mismo env_var y threshold => UNA alerta que los nombra', () => {
    const filas = ['proyecto-a', 'proyecto-b', 'proyecto-c'].map((p) => fila({ projectId: p }));
    const r = cron.evaluateRotationState({ now: dateUTC('2026-06-16'), inventoryRows: filas, state: {} });
    assert.equal(r.alerts.length, 3, 'evaluate emite una alerta por PAR (el estado es por par)');

    const agrupadas = cron.groupAlertsByEnvVarAndThreshold(r.alerts);
    assert.equal(agrupadas.length, 1, 'el MENSAJE se agrupa por (env_var, threshold)');
    assert.deepEqual(agrupadas[0].projects, ['proyecto-a', 'proyecto-b', 'proyecto-c']);
    for (const p of ['proyecto-a', 'proyecto-b', 'proyecto-c']) {
        assert.match(agrupadas[0].message, new RegExp(p));
    }
    assert.match(agrupadas[0].message, /Proyectos afectados \(3\)/);
});

test('CA-10: agrupar el MENSAJE no agrupa el ESTADO', () => {
    const filas = ['proyecto-a', 'proyecto-b'].map((p) => fila({ projectId: p }));
    const r = cron.evaluateRotationState({ now: dateUTC('2026-06-16'), inventoryRows: filas, state: {} });
    cron.groupAlertsByEnvVarAndThreshold(r.alerts);
    assert.deepEqual(Object.keys(r.nextState).sort(), ['proyecto-a', 'proyecto-b']);
    assert.ok(r.nextState['proyecto-a'].SHARED_API_KEY.thresholds_sent['T-14']);
    assert.ok(r.nextState['proyecto-b'].SHARED_API_KEY.thresholds_sent['T-14']);
});

test('CA-10: env_vars distintas NO se mezclan en el mismo grupo', () => {
    const filas = [
        fila({ projectId: 'proyecto-a', envVar: 'KEY_A' }),
        fila({ projectId: 'proyecto-b', envVar: 'KEY_B' }),
    ];
    const r = cron.evaluateRotationState({ now: dateUTC('2026-06-16'), inventoryRows: filas, state: {} });
    const agrupadas = cron.groupAlertsByEnvVarAndThreshold(r.alerts);
    assert.equal(agrupadas.length, 2);
    assert.deepEqual(agrupadas.map((a) => a.env_var).sort(), ['KEY_A', 'KEY_B']);
});

test('CA-10: thresholds distintos del mismo env_var NO se mezclan', () => {
    const agrupadas = cron.groupAlertsByEnvVarAndThreshold([
        { project_id: 'a', env_var: 'KEY', threshold: 'T-7', message: 'm1' },
        { project_id: 'b', env_var: 'KEY', threshold: 'T-3', message: 'm2' },
    ]);
    assert.equal(agrupadas.length, 2);
});

test('CA-10: un grupo de UNO conserva su project_id escalar', () => {
    const agrupadas = cron.groupAlertsByEnvVarAndThreshold([
        { project_id: 'acme-corp', env_var: 'KEY', threshold: 'T-7', message: 'm' },
    ]);
    assert.equal(agrupadas.length, 1);
    assert.equal(agrupadas[0].project_id, 'acme-corp');
    assert.deepEqual(agrupadas[0].projects, ['acme-corp']);
});

test('CA-10: un grupo de VARIOS anula project_id para que nadie lo lea como "el" proyecto', () => {
    const agrupadas = cron.groupAlertsByEnvVarAndThreshold([
        { project_id: 'a-uno', env_var: 'KEY', threshold: 'T-7', message: 'm' },
        { project_id: 'b-dos', env_var: 'KEY', threshold: 'T-7', message: 'm' },
    ]);
    assert.equal(agrupadas[0].project_id, null);
    assert.deepEqual(agrupadas[0].projects, ['a-uno', 'b-dos']);
});

test('CA-10 + UX-7 (#5340): el consolidado por threshold conserva el eje de proyecto', () => {
    const dir = tmpDir();
    try {
        const inventoryFile = path.join(dir, 'inv.md');
        fs.writeFileSync(inventoryFile, [
            '| project_id | provider | env_var | owner | last_rotated | expires_at |',
            '|------------|----------|---------|-------|--------------|------------|',
            '| proyecto-a | uno | `SHARED` | leo | 2026-04-01 | 2026-06-30 |',
            '| proyecto-b | dos | `SHARED` | leo | 2026-04-01 | 2026-06-30 |',
            '| kernel | tres | `OTRA` | leo | 2026-04-01 | 2026-06-30 |',
        ].join('\n'));
        const enviados = [];
        const r = cron.runRotationTick({
            pipelineDir: dir,
            now: dateUTC('2026-06-16'),
            sendTelegramFn: (m) => enviados.push(m),
            inventoryPath: inventoryFile,
            statePath: path.join(dir, 'state.json'),
        });
        assert.equal(r.alerts.length, 3, 'tres pares (projectId, env_var)');
        assert.equal(enviados.length, 1, 'UX-7: un solo mensaje por threshold');
        assert.match(enviados[0], /SHARED/);
        assert.match(enviados[0], /OTRA/);
        assert.match(enviados[0], /proyecto-a/);
        assert.match(enviados[0], /proyecto-b/);
        assert.match(enviados[0], /Kernel \(plataforma\)/);
        // El estado: tres slots en dos/tres namespaces distintos.
        const guardado = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
        assert.deepEqual(Object.keys(guardado).sort(), ['kernel', 'proyecto-a', 'proyecto-b']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('CA-10 · anti-leak: la agrupacion no filtra valores ni slugs invalidos', () => {
    const agrupadas = cron.groupAlertsByEnvVarAndThreshold([
        { project_id: '<script>', env_var: 'KEY', threshold: 'T-7', message: 'm' },
        { project_id: 'valido-a', env_var: 'KEY', threshold: 'T-7', message: 'm' },
    ]);
    assert.doesNotMatch(agrupadas[0].message, /<script>/);
    assert.match(agrupadas[0].message, /\(proyecto inválido\)/);
});

test('CA-7: un estado legacy que sigue DENTRO del repo se avisa, no se ignora en silencio', () => {
    const dir = tmpDir();
    try {
        const inventoryFile = path.join(dir, 'inv.md');
        fs.writeFileSync(inventoryFile, [
            '| project_id | provider | env_var | owner | last_rotated | expires_at |',
            '|------------|----------|---------|-------|--------------|------------|',
            '| kernel | p | `KEY` | leo | 2026-04-01 | 2026-06-30 |',
        ].join('\n'));
        // Archivo legacy en la ubicacion vieja (dentro del "repo" simulado).
        fs.writeFileSync(path.join(dir, 'credential-reminder-state.json'), '{}');

        const logs = [];
        const r = cron.runRotationTick({
            pipelineDir: dir,
            now: dateUTC('2026-06-16'),
            sendTelegramFn: () => {},
            inventoryPath: inventoryFile,
            statePath: path.join(dir, 'externo', 'state.json'),
            log: (m) => logs.push(m),
        });
        const aviso = r.errors.find((e) => e.stage === 'legacy-state-path');
        assert.ok(aviso, 'el estado legacy dentro del repo debe verse en errors[]');
        assert.match(aviso.message, /ya no se lee/);
        assert.match(aviso.message, /pipeline-state/, 'debe decir donde vive ahora');
        assert.ok(logs.some((l) => /legacy detectado DENTRO del repo/.test(l)));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
