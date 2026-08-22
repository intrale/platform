'use strict';

// =============================================================================
// #5176 · CA-8 — Paridad de comportamiento de los lectores migrados.
//
// Qué prueba
// ----------
// Corre, sobre el MISMO estado operativo, la implementación VIEJA (copiada
// literal de `origin/main@8dd6f5fdb`, construyendo el path a mano) y la NUEVA
// (migrada al envoltorio), y exige que den lo mismo — salvo en las dos
// divergencias DECLARADAS, que tienen su propio test y su propia aserción de
// que la nueva es la correcta.
//
// Por qué la vieja va copiada acá
// -------------------------------
// Las funciones migradas viven en módulos con requires relativos: comparar
// contra `origin/main` "de verdad" pediría un checkout paralelo del árbol, o
// sea un worktree extra dentro del repo que el propio pipeline audita. Copiar
// las ~40 líneas del lector viejo es más chico, queda auditable en el diff del
// PR, y convierte la evidencia puntual de CA-8 en un guard permanente: si una
// migración futura mueve la semántica, este test lo dice.
//
// Por qué vive en `__tests__/` y no en `scripts/`
// ----------------------------------------------
// Las implementaciones viejas construyen paths con los literales de estado. En
// `scripts/` sumaban 9 violations al inventario de producción — exactamente lo
// contrario de CA-2a. `__tests__/` está fuera del scan POR CONSTRUCCIÓN
// (`SKIP_DIRS` de `walkJs`), no por entrada de allowlist.
//
// node --test .pipeline/lib/__tests__/paridad-lectores-5176.test.js
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NOW = Date.parse('2026-08-14T00:00:00.000Z');
const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

// ─── Implementaciones VIEJAS (copia literal de origin/main@8dd6f5fdb) ───────

function normNum(n) {
    const x = Number(n);
    return Number.isInteger(x) && x > 0 ? x : null;
}

function oldReadPartialAllowlist(dir) {
    const p = path.join(dir, '.partial-pause.json');
    if (!fs.existsSync(p)) return null;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
    if (!parsed || typeof parsed !== 'object') return null;
    const arr = Array.isArray(parsed.allowed_issues) ? parsed.allowed_issues : [];
    return arr.map(normNum).filter(Boolean);
}

function oldHeaderMode(dir) {
    const partialFile = path.join(dir, '.partial-pause.json');
    const pauseFile = path.join(dir, '.paused');
    let mode = 'running';
    let allowedIssues = [];
    if (fs.existsSync(pauseFile)) {
        mode = 'paused';
    } else if (fs.existsSync(partialFile)) {
        let data = {};
        try { data = JSON.parse(fs.readFileSync(partialFile, 'utf8')) || {}; } catch { data = {}; }
        const arr = Array.isArray(data.allowed_issues) ? data.allowed_issues : [];
        if (arr.length > 0) { mode = 'partial_pause'; allowedIssues = arr; }
    }
    return { mode, allowedIssues };
}

function oldResolveBlockDependencies(dir) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(path.join(dir, '.partial-pause.json'), 'utf8')); }
    catch { return {}; }
    if (!parsed || typeof parsed !== 'object') return {};
    const ttls = (parsed.authorization_ttls && typeof parsed.authorization_ttls === 'object')
        ? parsed.authorization_ttls : {};
    const map = {};
    for (const [childKey, info] of Object.entries(ttls)) {
        const child = normNum(childKey);
        const parent = info && typeof info === 'object' ? normNum(info.parent) : null;
        if (child === null || parent === null) continue;
        if (!map[parent]) map[parent] = [];
        if (!map[parent].includes(child)) map[parent].push(child);
    }
    for (const k of Object.keys(map)) map[k].sort((a, b) => a - b);
    return map;
}

function oldResolveLiveSplitChildren(dir, parentIds, now) {
    const parents = new Set([...parentIds].map(normNum).filter((n) => n !== null));
    if (parents.size === 0) return [];
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(path.join(dir, '.partial-pause.json'), 'utf8')); }
    catch { return []; }
    if (!parsed || typeof parsed !== 'object') return [];
    const allowed = new Set((Array.isArray(parsed.allowed_issues) ? parsed.allowed_issues : [])
        .map(normNum).filter((n) => n !== null));
    const ttls = (parsed.authorization_ttls && typeof parsed.authorization_ttls === 'object')
        ? parsed.authorization_ttls : {};
    const out = new Set();
    for (const [childKey, info] of Object.entries(ttls)) {
        const child = normNum(childKey);
        if (child === null) continue;
        const parent = info && typeof info === 'object' ? normNum(info.parent) : null;
        if (parent === null || !parents.has(parent)) continue;
        if (!allowed.has(child)) continue;
        const expiresAt = info && typeof info.expires_at === 'string' ? Date.parse(info.expires_at) : NaN;
        if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
        out.add(child);
    }
    return [...out].sort((a, b) => a - b);
}

function oldReadAllowlistSafe(dir) {
    try {
        const p = path.join(dir, '.partial-pause.json');
        if (!fs.existsSync(p)) return [];
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        return Array.isArray(parsed.allowed_issues)
            ? parsed.allowed_issues.map(normNum).filter(Boolean) : [];
    } catch { return []; }
}

// ─── Fixtures: los estados operativos representativos ──────────────────────

const PARENT_IDS = [5109, 5915];

const ESCENARIOS = [
    {
        nombre: 'running (sin ningún marker)',
        marker: null,
        paused: false,
    },
    {
        nombre: 'partial_pause con issues y TTLs (uno vencido)',
        marker: {
            allowed_issues: [5109, 5176, 5179, 5915, 5923],
            created_at: '2026-08-14T10:00:00.000Z',
            authorization_ttls: {
                5176: { parent: 5109, expires_at: PAST },
                5179: { parent: 5109, expires_at: FUTURE },
                5923: { parent: 5915, expires_at: FUTURE },
            },
        },
        paused: false,
    },
    {
        nombre: 'marker presente y vacío',
        marker: { allowed_issues: [], created_at: '2026-08-14T10:00:00.000Z' },
        paused: false,
    },
    {
        nombre: 'marker ilegible',
        markerRaw: '{ esto no es json',
        paused: false,
    },
    {
        nombre: 'halt total sobre allowlist poblada',
        marker: {
            allowed_issues: [5109, 5179],
            created_at: '2026-08-14T10:00:00.000Z',
            authorization_ttls: { 5179: { parent: 5109, expires_at: FUTURE } },
        },
        paused: true,
    },
];

function montarEscenario(esc) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paridad-5176-'));
    if (esc.markerRaw !== undefined) {
        fs.writeFileSync(path.join(dir, '.partial-pause.json'), esc.markerRaw);
    } else if (esc.marker) {
        fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify(esc.marker));
    }
    if (esc.paused) fs.writeFileSync(path.join(dir, '.paused'), '');
    return dir;
}

function conOverride(dir, fn) {
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    // Los módulos leen `PIPELINE_DIR_OVERRIDE` en cada llamada, pero
    // `desync-detector` / `wave-auto-transition` capturan el envoltorio en el
    // require: se recargan para que el fixture quede limpio entre escenarios.
    delete require.cache[require.resolve('../desync-detector')];
    delete require.cache[require.resolve('../wave-auto-transition')];
    try {
        return fn({
            desyncDetector: require('../desync-detector'),
            waveAutoTransition: require('../wave-auto-transition'),
            waveResolver: require('../wave-resolver'),
            dashboardSlices: require('../dashboard-slices'),
        });
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prev;
    }
}

function headerNuevo(slices, dir) {
    const out = slices.headerSlice({
        procesos: { pulpo: { alive: false, uptime: 0 } },
        issueMatrix: {}, bloqueados: [], actividad: [], priorityWindows: {}, resources: {},
    }, { PIPELINE: dir });
    return { mode: out.mode, allowedIssues: out.allowedIssues };
}

// ─── CA-8 · paridad por escenario ──────────────────────────────────────────

for (const esc of ESCENARIOS) {
    test(`#5176 CA-8 · paridad viejo/nuevo — ${esc.nombre}`, () => {
        const dir = montarEscenario(esc);
        try {
            conOverride(dir, (m) => {
                assert.deepEqual(
                    m.desyncDetector._internal.readPartialAllowlist(),
                    oldReadPartialAllowlist(dir),
                    'desync-detector.readPartialAllowlist',
                );
                assert.deepEqual(
                    m.waveResolver.resolveBlockDependencies({ pipelineRoot: dir }),
                    oldResolveBlockDependencies(dir),
                    'wave-resolver.resolveBlockDependencies',
                );
                assert.deepEqual(
                    m.waveResolver.resolveLiveSplitChildren({ pipelineRoot: dir, parentIds: PARENT_IDS, now: NOW }),
                    oldResolveLiveSplitChildren(dir, PARENT_IDS, NOW),
                    'wave-resolver.resolveLiveSplitChildren',
                );
                assert.deepEqual(
                    m.waveAutoTransition._internal.readAllowlistSafe(),
                    oldReadAllowlistSafe(dir),
                    'wave-auto-transition.readAllowlistSafe',
                );
                assert.deepEqual(
                    headerNuevo(m.dashboardSlices, dir),
                    oldHeaderMode(dir),
                    'dashboard-slices.headerSlice',
                );
            });
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
}

// ─── Las DOS divergencias declaradas ───────────────────────────────────────

test('#5176 SEC-4 · divergencia declarada: ventana por SKILL — el viejo decía running, el nuevo partial_pause', () => {
    const dir = montarEscenario({
        marker: { allowed_issues: [], allowed_skills: ['multi-provider-smoke-test'] },
        paused: false,
    });
    try {
        conOverride(dir, (m) => {
            const viejo = oldHeaderMode(dir);
            const nuevo = headerNuevo(m.dashboardSlices, dir);
            assert.equal(viejo.mode, 'running', 'el viejo mostraba "sin pausa" con el dispatch acotado');
            assert.equal(nuevo.mode, 'partial_pause', 'el nuevo adopta la semántica del gate real (#3680 CA-A15)');

            // Y la nueva es la CORRECTA: el gate del Pulpo ya trataba esto como
            // pausa parcial. La divergencia corrige el header, no lo rompe.
            const partialPause = require('../partial-pause');
            assert.equal(partialPause.getPipelineMode().mode, 'partial_pause');
        });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#5176 A-1 · divergencia declarada: /allowlist leía un schema que ningún escritor produce', () => {
    const dir = montarEscenario({
        marker: { allowed_issues: [5176, 5179], created_at: '2026-08-14T10:00:00.000Z' },
        paused: false,
    });
    try {
        // Cascada VIEJA del render: `parsed.issues` / `parsed.allowlist` / array
        // pelado. Ninguna matchea el schema canónico `allowed_issues`.
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, '.partial-pause.json'), 'utf8'));
        let viejoAllowed = [];
        if (Array.isArray(parsed)) viejoAllowed = parsed;
        else if (parsed && Array.isArray(parsed.issues)) viejoAllowed = parsed.issues;
        else if (parsed && Array.isArray(parsed.allowlist)) viejoAllowed = parsed.allowlist;

        assert.equal(viejoAllowed.length, 0, 'el render viejo computaba 0 con 2 issues autorizados');
        assert.equal(parsed.allowed_issues.length, 2, 'el schema canónico sí los tiene');

        conOverride(dir, () => {
            const ops = require('../operational-state');
            assert.deepEqual(ops.readDispatchAllowlist().issues, [5176, 5179],
                'el nuevo lee el canónico: /allowlist deja de reportar "vacía" con issues autorizados');
        });

        // `modified_by` nunca lo escribe nadie: `last-modified-by` rendía null
        // antes y sigue rindiendo null. No es regresión, es campo muerto.
        assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'modified_by'), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
