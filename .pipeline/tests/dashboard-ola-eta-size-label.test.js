// #3529 — Precedencia D3 end-to-end: el caller del dashboard
// (`_scheduleOlaETARefresh` en `.pipeline/dashboard.js`) debe extraer el label
// `size:*` desde `state.issueMatrix[id].labels` y pasarlo a `calculateOlaETA`
// como `{ number, size }` para que la librería honre la precedencia
// label > roadmap > fallback `M`.
//
// Pattern de testing (consistente con dashboard-pipeline-allowlist.test.js):
// 1. Leemos el source de dashboard.js como string y verificamos que el contrato
//    esperado quede congelado (regex anclado, fallback, try/catch, push del
//    objeto en lugar de num plano).
// 2. Replicamos la lógica de extracción y validamos los 3 escenarios CA-9 +
//    integramos con `calculateOlaETA` real para verificar que el `sizeCanonical`
//    resultante es el del label y NO el del roadmap/fallback.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard.js');
const DASHBOARD_SRC = fs.readFileSync(DASHBOARD_PATH, 'utf8');

// ─────────────────────── Congelar contrato del source ───────────────────────

test('dashboard.js declara extracción defensiva de size label en _scheduleOlaETARefresh', () => {
    // El marker #3529 debe estar presente para trazabilidad
    assert.match(
        DASHBOARD_SRC,
        /#3529[^\n]*Precedencia D3/,
        'el bloque de extracción debe estar marcado con #3529 y referenciar D3',
    );
});

test('dashboard.js usa match anclado al prefijo "size:" (SEC-2)', () => {
    // El match debe usar startsWith('size:') después de toLowerCase(), no
    // includes() (que daría falsos positivos con "app:client-sized").
    assert.match(
        DASHBOARD_SRC,
        /\.toLowerCase\(\)\.startsWith\(['"]size:['"]\)/,
        'el match debe ser case-insensitive y anclado al prefijo size:',
    );
});

test('dashboard.js envuelve la extracción de size en try/catch (CA-5)', () => {
    // El bloque dentro de _scheduleOlaETARefresh debe tener try/catch para que
    // un label malformado no rompa el refresh de la ola.
    const slice = DASHBOARD_SRC.split('_scheduleOlaETARefresh')[1] || '';
    assert.match(
        slice,
        /try\s*\{[\s\S]*?sizeLabel[\s\S]*?\}\s*catch/,
        'la extracción de sizeLabel debe estar protegida con try/catch',
    );
});

test('dashboard.js pushea {number, size} cuando hay label, num plano en fallback (CA-1/CA-2)', () => {
    const slice = DASHBOARD_SRC.split('_scheduleOlaETARefresh')[1] || '';
    // Branch positivo: push del objeto con number y size
    assert.match(
        slice,
        /olaIssues\.push\(\s*\{\s*number:\s*num\s*,\s*size:\s*sizeLabel\s*\}\s*\)/,
        'debe pushear { number, size } cuando hay sizeLabel',
    );
    // Branch negativo: push del num plano (preserva precedencia roadmap)
    assert.match(
        slice,
        /else\s+olaIssues\.push\(num\)/,
        'debe pushear num plano cuando no hay sizeLabel (mantiene precedencia roadmap)',
    );
});

// ─────────────────────── Comportamiento de la extracción ───────────────────────

// Replicamos la lógica idéntica al source para validar comportamiento de los
// 3 escenarios CA-9. Si el source cambia de forma incompatible, los tests de
// arriba (regex) ya fallarían — éstos validan que la semántica es la esperada.
function extractOlaIssues(issueMatrix) {
    const olaIssues = [];
    const seen = new Set();
    for (const [issueStr, info] of Object.entries(issueMatrix || {})) {
        if (!info || !info.estadoActual) continue;
        if (info.estadoActual === 'procesado') continue;
        const num = Number(issueStr);
        if (!Number.isInteger(num) || num <= 0) continue;
        if (seen.has(num)) continue;
        seen.add(num);
        let sizeLabel = null;
        try {
            const labels = Array.isArray(info.labels) ? info.labels : null;
            if (labels) {
                for (const l of labels) {
                    if (typeof l !== 'string') continue;
                    if (l.toLowerCase().startsWith('size:')) { sizeLabel = l; break; }
                }
            }
        } catch {
            sizeLabel = null;
        }
        if (sizeLabel) olaIssues.push({ number: num, size: sizeLabel });
        else olaIssues.push(num);
    }
    return olaIssues;
}

test('CA-1: issue con label size:simple se pushea como { number, size:"size:simple" }', () => {
    const matrix = {
        '101': { estadoActual: 'trabajando', labels: ['priority:low', 'size:simple', 'area:pipeline'] },
    };
    const result = extractOlaIssues(matrix);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { number: 101, size: 'size:simple' });
});

test('CA-2: issue sin label size:* se pushea como num plano', () => {
    const matrix = {
        '202': { estadoActual: 'pendiente', labels: ['priority:low', 'area:pipeline'] },
    };
    const result = extractOlaIssues(matrix);
    assert.equal(result.length, 1);
    assert.strictEqual(result[0], 202);
});

test('CA-3: match anclado descarta falsos positivos como "app:client-sized"', () => {
    const matrix = {
        '303': { estadoActual: 'trabajando', labels: ['app:client-sized', 'priority:low'] },
    };
    const result = extractOlaIssues(matrix);
    assert.equal(result.length, 1);
    assert.strictEqual(result[0], 303, 'app:client-sized NO debe matchear; debe caer a num plano');
});

test('CA-3: match case-insensitive (Size:Simple matchea)', () => {
    const matrix = {
        '304': { estadoActual: 'trabajando', labels: ['Size:Simple'] },
    };
    const result = extractOlaIssues(matrix);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { number: 304, size: 'Size:Simple' });
});

test('CA-4: con múltiples labels size:*, toma el primero del array (determinístico)', () => {
    const matrix = {
        '404': { estadoActual: 'trabajando', labels: ['size:simple', 'size:medium', 'priority:low'] },
    };
    const result = extractOlaIssues(matrix);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { number: 404, size: 'size:simple' }, 'primer match gana');
});

test('CA-5: labels malformado/no-array no rompe extracción (fallback a num plano)', () => {
    const matrix = {
        '501': { estadoActual: 'trabajando', labels: undefined },
        '502': { estadoActual: 'trabajando', labels: 'not-an-array' },
        '503': { estadoActual: 'trabajando', labels: [null, 42, 'size:grande'] }, // entries no-string ignoradas
    };
    const result = extractOlaIssues(matrix);
    assert.equal(result.length, 3);
    assert.strictEqual(result[0], 501);
    assert.strictEqual(result[1], 502);
    assert.deepEqual(result[2], { number: 503, size: 'size:grande' });
});

test('issues en estado procesado se excluyen de la ola actual', () => {
    const matrix = {
        '601': { estadoActual: 'procesado', labels: ['size:simple'] },
        '602': { estadoActual: 'trabajando', labels: ['size:medium'] },
    };
    const result = extractOlaIssues(matrix);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { number: 602, size: 'size:medium' });
});

// ─────────────────────── Integración con calculateOlaETA ───────────────────────
// CA-1 end-to-end: verificamos que pasar `{ number, size }` a la librería real
// produce `byIssue[N].sizeCanonical` derivado del label, no del fallback `M`.

test('integración: { number, size:"size:simple" } produce sizeCanonical "S" (NO "M")', async () => {
    // Aislamos roadmap+metrics para asegurar que el resultado viene del label
    // y no de roadmap.json. Apuntamos PIPELINE_ROOT_OVERRIDE a un tmpdir vacío.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ola-eta-test-'));
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.pipeline'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'scripts', 'roadmap.json'), JSON.stringify({ items: [] }));
    const prev = process.env.PIPELINE_ROOT_OVERRIDE;
    process.env.PIPELINE_ROOT_OVERRIDE = tmp;
    try {
        // Cargar fresh para que tome el override y limpie caches internos
        delete require.cache[require.resolve('../lib/eta-wave')];
        const etaWave = require('../lib/eta-wave');
        etaWave._internal._invalidateRoadmapCache();

        const matrix = {
            '701': { estadoActual: 'trabajando', labels: ['size:simple'] },
            '702': { estadoActual: 'pendiente', labels: ['priority:low'] }, // sin size → fallback M
        };
        const olaIssues = extractOlaIssues(matrix);
        const r = await etaWave.calculateOlaETA(olaIssues, 3);

        assert.equal(r.byIssue[701].sizeCanonical, 'S',
            'issue con label size:simple debe resolver a sizeCanonical "S"');
        assert.equal(r.byIssue[702].sizeCanonical, 'M',
            'issue sin label size:* y sin entrada en roadmap debe caer a fallback M');
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_ROOT_OVERRIDE;
        else process.env.PIPELINE_ROOT_OVERRIDE = prev;
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
});

test('integración: label gana sobre roadmap (precedencia D3)', async () => {
    // Roadmap dice "L" para el issue 801, pero el label dice "size:simple" →
    // debe ganar el label.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ola-eta-test-'));
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.pipeline'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'scripts', 'roadmap.json'), JSON.stringify({
        items: [{ issue: 801, size: 'L' }],
    }));
    const prev = process.env.PIPELINE_ROOT_OVERRIDE;
    process.env.PIPELINE_ROOT_OVERRIDE = tmp;
    try {
        delete require.cache[require.resolve('../lib/eta-wave')];
        const etaWave = require('../lib/eta-wave');
        etaWave._internal._invalidateRoadmapCache();

        const matrix = {
            '801': { estadoActual: 'trabajando', labels: ['size:simple'] },
        };
        const olaIssues = extractOlaIssues(matrix);
        const r = await etaWave.calculateOlaETA(olaIssues, 3);

        assert.equal(r.byIssue[801].sizeCanonical, 'S',
            'label size:simple debe anular el "L" del roadmap (precedencia D3)');
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_ROOT_OVERRIDE;
        else process.env.PIPELINE_ROOT_OVERRIDE = prev;
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
});
