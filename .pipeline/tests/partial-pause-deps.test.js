// Tests de .pipeline/lib/partial-pause-deps.js (issue #2893)
//
// Cubre CA-10 (unit): detección de deps, auto-inclusión, persistencia con accepted_dep_risk.
// El runner de gh se inyecta como fake — no toca la red.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ppDeps = require('../lib/partial-pause-deps');

// ----- Fake gh runner ----------------------------------------------------------

function makeFakeRunner(issueDb) {
    // issueDb: { '2882': { state, body, comments, title }, ... }
    const calls = [];
    const fn = (args) => {
        calls.push(args);
        // Esperamos: ['issue', 'view', '<num>', '--repo', repo, '--json', 'number,title,state,body,comments']
        if (args[0] === 'issue' && args[1] === 'view') {
            const num = String(args[2]);
            const e = issueDb[num];
            if (!e) return { ok: false, stdout: '', stderr: 'not found', status: 1 };
            const json = {
                number: Number(num),
                title: e.title || '',
                state: e.state || 'OPEN',
                body: e.body || '',
                comments: (e.comments || []).map(c => ({ body: c })),
            };
            return { ok: true, stdout: JSON.stringify(json), stderr: '', status: 0 };
        }
        return { ok: false, stdout: '', stderr: 'unsupported', status: 2 };
    };
    fn.calls = calls;
    return fn;
}

function tmpCacheFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-deps-'));
    return path.join(dir, 'cache.json');
}

// ----- parseDepsFromText -------------------------------------------------------

test('parseDepsFromText reconoce "Closes #N", "Depends on #N", "Split de #N"', () => {
    const text = 'Closes #100\nDepends on #200\nSplit de #300\nFix #400';
    assert.deepEqual(ppDeps.parseDepsFromText(text), [100, 200, 300, 400]);
});

test('parseDepsFromText reconoce "Tracked by #N" y "Blocked by #N"', () => {
    const text = 'tracked by #501\nblocked by #502';
    assert.deepEqual(ppDeps.parseDepsFromText(text), [501, 502]);
});

test('parseDepsFromText es idempotente (no acumula state global por /g)', () => {
    const text = 'Closes #100';
    assert.deepEqual(ppDeps.parseDepsFromText(text), [100]);
    assert.deepEqual(ppDeps.parseDepsFromText(text), [100]);  // segunda llamada igual
});

test('parseDepsFromText devuelve [] para input vacío o inválido', () => {
    assert.deepEqual(ppDeps.parseDepsFromText(''), []);
    assert.deepEqual(ppDeps.parseDepsFromText(null), []);
    assert.deepEqual(ppDeps.parseDepsFromText(undefined), []);
    assert.deepEqual(ppDeps.parseDepsFromText('sin referencias'), []);
});

test('parseDepsFromText es case-insensitive', () => {
    const text = 'CLOSES #1\nclosES #2\nDEPENDS ON #3\ndepEnds on #4';
    assert.deepEqual(ppDeps.parseDepsFromText(text), [1, 2, 3, 4]);
});

test('parseDepsFromText ignora #N sin verbo de dependencia', () => {
    // "Ver #999" (mención casual) NO debe ser detectada como dep.
    assert.deepEqual(ppDeps.parseDepsFromText('Ver #999 para más contexto'), []);
});

test('parseDepsFromText deduplica', () => {
    assert.deepEqual(ppDeps.parseDepsFromText('Closes #50\nDepends on #50'), [50]);
});

// ----- fetchIssueInfo (con fake gh) -------------------------------------------

test('fetchIssueInfo extrae state, title y deps del body', () => {
    const cacheFile = tmpCacheFile();
    const ghRunner = makeFakeRunner({
        '2882': {
            state: 'OPEN',
            title: 'Modo descanso',
            body: 'Closes #2890\nCloses #2891\nCloses #2892',
        },
    });
    const r = ppDeps.fetchIssueInfo(2882, { ghRunner, cacheFile, repo: 'test/repo' });
    assert.equal(r.state, 'open');
    assert.equal(r.title, 'Modo descanso');
    assert.deepEqual(r.deps, [2890, 2891, 2892]);
});

test('fetchIssueInfo cachea (segunda llamada no consulta gh)', () => {
    const cacheFile = tmpCacheFile();
    const ghRunner = makeFakeRunner({
        '100': { state: 'OPEN', title: 't', body: 'Closes #200' },
    });
    ppDeps.fetchIssueInfo(100, { ghRunner, cacheFile });
    assert.equal(ghRunner.calls.length, 1);
    ppDeps.fetchIssueInfo(100, { ghRunner, cacheFile });
    assert.equal(ghRunner.calls.length, 1);  // hit de cache
});

test('fetchIssueInfo refresca cuando expira TTL', () => {
    const cacheFile = tmpCacheFile();
    const ghRunner = makeFakeRunner({
        '100': { state: 'OPEN', title: 't', body: '' },
    });
    const t0 = 1_000_000_000;
    ppDeps.fetchIssueInfo(100, { ghRunner, cacheFile, now: t0 });
    // Avanzar más allá del TTL (5 min default).
    ppDeps.fetchIssueInfo(100, { ghRunner, cacheFile, now: t0 + 6 * 60_000 });
    assert.equal(ghRunner.calls.length, 2);
});

test('fetchIssueInfo guarda error cuando gh falla', () => {
    const cacheFile = tmpCacheFile();
    const ghRunner = (args) => ({ ok: false, stdout: '', stderr: 'rate limit\n', status: 4 });
    const r = ppDeps.fetchIssueInfo(999, { ghRunner, cacheFile });
    assert.equal(r.state, 'unknown');
    assert.match(r.error, /rate limit/);
    assert.deepEqual(r.deps, []);
});

test('fetchIssueInfo descarta auto-referencias (issue se referencia a sí mismo)', () => {
    const cacheFile = tmpCacheFile();
    const ghRunner = makeFakeRunner({
        '100': { state: 'OPEN', body: 'Closes #100\nCloses #200' },
    });
    const r = ppDeps.fetchIssueInfo(100, { ghRunner, cacheFile });
    assert.deepEqual(r.deps, [200]);
});

// ----- resolveOpenDeps --------------------------------------------------------

test('resolveOpenDeps ignora deps cerradas', () => {
    const cacheFile = tmpCacheFile();
    const ghRunner = makeFakeRunner({
        '100': { state: 'OPEN', body: 'Closes #200\nCloses #201' },
        '200': { state: 'OPEN', body: '' },
        '201': { state: 'CLOSED', body: '' },
    });
    const r = ppDeps.resolveOpenDeps(100, { ghRunner, cacheFile });
    assert.deepEqual(r.openDeps, [200]);  // 201 cerrada queda fuera
});

test('resolveOpenDeps recorre profundidad limitada (MAX_DEPTH=3)', () => {
    const cacheFile = tmpCacheFile();
    // Cadena de 5 niveles: 1 → 2 → 3 → 4 → 5
    const ghRunner = makeFakeRunner({
        '1': { state: 'OPEN', body: 'Closes #2' },
        '2': { state: 'OPEN', body: 'Closes #3' },
        '3': { state: 'OPEN', body: 'Closes #4' },
        '4': { state: 'OPEN', body: 'Closes #5' },
        '5': { state: 'OPEN', body: '' },
    });
    const r = ppDeps.resolveOpenDeps(1, { ghRunner, cacheFile });
    assert.equal(r.truncated, true);
});

test('resolveOpenDeps maneja ciclos sin loop infinito', () => {
    const cacheFile = tmpCacheFile();
    // Ciclo: 1 → 2 → 1
    const ghRunner = makeFakeRunner({
        '1': { state: 'OPEN', body: 'Closes #2' },
        '2': { state: 'OPEN', body: 'Closes #1' },
    });
    const r = ppDeps.resolveOpenDeps(1, { ghRunner, cacheFile });
    // No tira excepción, devuelve algo razonable.
    assert.ok(Array.isArray(r.openDeps));
});

// ----- findMissingDeps (caso real del incidente 2026-04-30) -------------------

test('findMissingDeps reproduce el incidente del 2026-04-30 (CA-1)', () => {
    const cacheFile = tmpCacheFile();
    const ghRunner = makeFakeRunner({
        '2882': {
            state: 'OPEN',
            title: 'Modo descanso (parent)',
            body: 'Splitteado en sub-historias.\nCloses #2890\nCloses #2891\nCloses #2892',
        },
        '2890': { state: 'OPEN', title: 'Split A', body: 'Split de #2882' },
        '2891': { state: 'OPEN', title: 'Split B', body: 'Split de #2882' },
        '2892': { state: 'OPEN', title: 'Split C', body: 'Split de #2882' },
    });
    const det = ppDeps.findMissingDeps([2882], { ghRunner, cacheFile });
    assert.deepEqual(det.missing['2882'], [2890, 2891, 2892]);
    assert.equal(det.truncated, false);
});

test('findMissingDeps no reporta cuando todas las deps están en el allowlist', () => {
    const cacheFile = tmpCacheFile();
    const ghRunner = makeFakeRunner({
        '2882': { state: 'OPEN', body: 'Closes #2890\nCloses #2891' },
        '2890': { state: 'OPEN', body: '' },
        '2891': { state: 'OPEN', body: '' },
    });
    const det = ppDeps.findMissingDeps([2882, 2890, 2891], { ghRunner, cacheFile });
    assert.deepEqual(det.missing, {});
});

test('findMissingDeps no reporta deps cerradas como faltantes', () => {
    const cacheFile = tmpCacheFile();
    const ghRunner = makeFakeRunner({
        '100': { state: 'OPEN', body: 'Closes #200\nCloses #201' },
        '200': { state: 'OPEN', body: '' },
        '201': { state: 'CLOSED', body: '' },
    });
    const det = ppDeps.findMissingDeps([100], { ghRunner, cacheFile });
    assert.deepEqual(det.missing['100'], [200]);  // 201 cerrada, no aparece
});

// ----- allowlistWithDeps (CA-4: auto-incluir) ---------------------------------

test('allowlistWithDeps une el allowlist original con las deps detectadas', () => {
    const out = ppDeps.allowlistWithDeps([2882], { '2882': [2890, 2891, 2892] });
    assert.deepEqual(out, [2882, 2890, 2891, 2892]);
});

test('allowlistWithDeps deduplica si una dep ya estaba en el allowlist', () => {
    const out = ppDeps.allowlistWithDeps([2882, 2890], { '2882': [2890, 2891] });
    assert.deepEqual(out, [2882, 2890, 2891]);
});

test('allowlistWithDeps con missing vacío devuelve el allowlist original', () => {
    const out = ppDeps.allowlistWithDeps([2882], {});
    assert.deepEqual(out, [2882]);
});

// ----- alertSignature (CA-7: cooldown) ----------------------------------------

test('alertSignature es estable independiente del orden de las deps', () => {
    const a = ppDeps.alertSignature(2882, [2892, 2890, 2891]);
    const b = ppDeps.alertSignature(2882, [2890, 2891, 2892]);
    assert.equal(a, b);
});

test('alertSignature cambia cuando cambia el set de deps', () => {
    const a = ppDeps.alertSignature(2882, [2890, 2891, 2892]);
    const b = ppDeps.alertSignature(2882, [2890, 2891]);
    assert.notEqual(a, b);
});

// ----- Persistencia accepted_dep_risk (CA-5) ----------------------------------

test('partial-pause persiste accepted_dep_risk y dep_sources cuando se pasa', () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-flag-'));
    process.env.PIPELINE_DIR_OVERRIDE = TMP;
    delete require.cache[require.resolve('../lib/partial-pause')];
    const pp = require('../lib/partial-pause');
    try {
        pp.setPartialPause([2882], {
            source: 'dashboard-test',
            acceptedDepRisk: true,
        });
        const state = pp.getPipelineMode();
        assert.equal(state.mode, 'partial_pause');
        assert.deepEqual(state.allowedIssues, [2882]);
        assert.equal(state.acceptedDepRisk, true);
        assert.equal(state.source, 'dashboard-test');
    } finally {
        try { fs.unlinkSync(path.join(TMP, '.partial-pause.json')); } catch {}
        delete process.env.PIPELINE_DIR_OVERRIDE;
        delete require.cache[require.resolve('../lib/partial-pause')];
    }
});

test('partial-pause persiste dep_sources con source=auto-deps (CA-4)', () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-src-'));
    process.env.PIPELINE_DIR_OVERRIDE = TMP;
    delete require.cache[require.resolve('../lib/partial-pause')];
    const pp = require('../lib/partial-pause');
    try {
        pp.setPartialPause([2882, 2890, 2891], {
            source: 'dashboard-auto-deps',
            depSources: { '2890': 'auto-deps', '2891': 'auto-deps' },
        });
        const state = pp.getPipelineMode();
        assert.deepEqual(state.depSources, { '2890': 'auto-deps', '2891': 'auto-deps' });
        const raw = JSON.parse(fs.readFileSync(path.join(TMP, '.partial-pause.json'), 'utf8'));
        assert.equal(raw.source, 'dashboard-auto-deps');
        assert.deepEqual(raw.dep_sources, { '2890': 'auto-deps', '2891': 'auto-deps' });
    } finally {
        try { fs.unlinkSync(path.join(TMP, '.partial-pause.json')); } catch {}
        delete process.env.PIPELINE_DIR_OVERRIDE;
        delete require.cache[require.resolve('../lib/partial-pause')];
    }
});

test('partial-pause filtra dep_sources de issues que no están en el allowlist final', () => {
    // Si depSources tiene keys que no están en `issues`, las descartamos para
    // no persistir información sobre issues que no aplican.
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-fil-'));
    process.env.PIPELINE_DIR_OVERRIDE = TMP;
    delete require.cache[require.resolve('../lib/partial-pause')];
    const pp = require('../lib/partial-pause');
    try {
        pp.setPartialPause([2882], {
            source: 'test',
            depSources: { '2890': 'auto-deps', '999': 'spurious' },
        });
        const state = pp.getPipelineMode();
        // 2890 no está en allowlist [2882] → no debería aparecer.
        // 999 tampoco → no debería aparecer.
        assert.equal(state.depSources, null);
    } finally {
        try { fs.unlinkSync(path.join(TMP, '.partial-pause.json')); } catch {}
        delete process.env.PIPELINE_DIR_OVERRIDE;
        delete require.cache[require.resolve('../lib/partial-pause')];
    }
});

// ----- E2E: incidente del 2026-04-30 reproducido (CA-11) ----------------------

test('E2E #2893: simula incidente 2026-04-30 (allowlist [2882] dispara modal con auto-include)', () => {
    const cacheFile = tmpCacheFile();
    const ghRunner = makeFakeRunner({
        '2882': {
            state: 'OPEN',
            title: 'Épico modo descanso',
            body: 'Splitteado en sub-historias.\nCloses #2890\nCloses #2891\nCloses #2892',
        },
        '2890': { state: 'OPEN', title: 'PR-A', body: 'Split de #2882' },
        '2891': { state: 'OPEN', title: 'PR-B', body: 'Split de #2882' },
        '2892': { state: 'OPEN', title: 'PR-C', body: 'Split de #2882' },
    });

    // Step 1: el operador activa partial-pause con [2882]. El flujo del
    // dashboard llama a findMissingDeps antes de persistir.
    const detection = ppDeps.findMissingDeps([2882], { ghRunner, cacheFile });
    assert.ok(Object.keys(detection.missing).length > 0, 'Detección debe encontrar deps faltantes');
    assert.deepEqual(detection.missing['2882'], [2890, 2891, 2892]);

    // Step 2: el operador elige "Sí, incluir todas".
    // El dashboard llama a allowlistWithDeps y persiste con depSources.
    const finalList = ppDeps.allowlistWithDeps([2882], detection.missing);
    assert.deepEqual(finalList, [2882, 2890, 2891, 2892]);

    // Step 3: el partial-pause persistido tiene los 4 issues — el incidente
    // 2026-04-30 (pipeline trabado por allowlist incompleto) NO se reproduce.
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-e2e-'));
    process.env.PIPELINE_DIR_OVERRIDE = TMP;
    delete require.cache[require.resolve('../lib/partial-pause')];
    const pp = require('../lib/partial-pause');
    try {
        const depSources = {};
        for (const deps of Object.values(detection.missing)) {
            for (const d of deps) depSources[String(d)] = 'auto-deps';
        }
        pp.setPartialPause(finalList, { source: 'dashboard-auto-deps', depSources });
        const state = pp.getPipelineMode();
        // El allowlist final cubre al parent + los 3 splits.
        assert.deepEqual(state.allowedIssues, [2882, 2890, 2891, 2892]);
        // dep_sources marca cuáles vinieron de auto-deps.
        assert.deepEqual(state.depSources, {
            '2890': 'auto-deps',
            '2891': 'auto-deps',
            '2892': 'auto-deps',
        });
        // Los 4 issues quedan habilitados → el pipeline puede avanzar.
        assert.equal(pp.isIssueAllowed(2882), true);
        assert.equal(pp.isIssueAllowed(2890), true);
        assert.equal(pp.isIssueAllowed(2891), true);
        assert.equal(pp.isIssueAllowed(2892), true);
    } finally {
        try { fs.unlinkSync(path.join(TMP, '.partial-pause.json')); } catch {}
        delete process.env.PIPELINE_DIR_OVERRIDE;
        delete require.cache[require.resolve('../lib/partial-pause')];
    }
});

test('E2E #2893: camino "solo el original" deja el riesgo aceptado en el marker', () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-e2e2-'));
    process.env.PIPELINE_DIR_OVERRIDE = TMP;
    delete require.cache[require.resolve('../lib/partial-pause')];
    const pp = require('../lib/partial-pause');
    try {
        // El operador eligió "Solo el original" — persistimos solo [2882] con flag.
        pp.setPartialPause([2882], { source: 'dashboard', acceptedDepRisk: true });
        const state = pp.getPipelineMode();
        assert.deepEqual(state.allowedIssues, [2882]);
        assert.equal(state.acceptedDepRisk, true);
        // El pipeline está advertido del riesgo — la detección continua del
        // pulpo va a alertar pero no va a auto-incluir (respeta la decisión).
    } finally {
        try { fs.unlinkSync(path.join(TMP, '.partial-pause.json')); } catch {}
        delete process.env.PIPELINE_DIR_OVERRIDE;
        delete require.cache[require.resolve('../lib/partial-pause')];
    }
});
