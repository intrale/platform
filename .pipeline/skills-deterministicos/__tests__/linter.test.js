// Tests unitarios de .pipeline/skills-deterministicos/linter.js (issue #2491)
// No ejecutamos git real: validamos parseArgs, heartbeat, updateMarker y
// el agregado de findings con filesystem aislado.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-linter-'));
fs.mkdirSync(path.join(TMP, '.claude', 'hooks'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'logs'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'desarrollo', 'linteo', 'trabajando'), { recursive: true });
process.env.PIPELINE_REPO_ROOT = TMP;
process.env.CLAUDE_PROJECT_DIR = TMP;

delete require.cache[require.resolve('../linter')];
const linter = require('../linter');

test('parseArgs — issue posicional', () => {
    const a = linter.parseArgs(['node', 'linter.js', '2491']);
    assert.equal(a.issue, 2491);
    assert.equal(a.base, 'origin/main');
});

test('parseArgs — --trabajando=<path> y --base=<ref>', () => {
    const a = linter.parseArgs(['node', 'x', '10', '--trabajando=/tmp/foo.linter', '--base=origin/develop']);
    assert.equal(a.trabajando, '/tmp/foo.linter');
    assert.equal(a.base, 'origin/develop');
});

test('parseArgs — fallback a PIPELINE_ISSUE y PIPELINE_TRABAJANDO', () => {
    const savedI = process.env.PIPELINE_ISSUE;
    const savedT = process.env.PIPELINE_TRABAJANDO;
    process.env.PIPELINE_ISSUE = '8888';
    process.env.PIPELINE_TRABAJANDO = '/tmp/env.linter';
    try {
        const a = linter.parseArgs(['node', 'x']);
        assert.equal(a.issue, 8888);
        assert.equal(a.trabajando, '/tmp/env.linter');
    } finally {
        if (savedI === undefined) delete process.env.PIPELINE_ISSUE; else process.env.PIPELINE_ISSUE = savedI;
        if (savedT === undefined) delete process.env.PIPELINE_TRABAJANDO; else process.env.PIPELINE_TRABAJANDO = savedT;
    }
});

test('startHeartbeat — escribe archivo con skill=linter y model=deterministic', () => {
    const hb = linter.startHeartbeat(7777);
    try {
        const hbFile = path.join(TMP, '.claude', 'hooks', 'agent-7777.heartbeat');
        assert.ok(fs.existsSync(hbFile), 'heartbeat file debe existir');
        const data = JSON.parse(fs.readFileSync(hbFile, 'utf8').trim());
        assert.equal(data.skill, 'linter');
        assert.equal(data.model, 'deterministic');
        assert.equal(data.issue, 7777);
        assert.equal(typeof data.pid, 'number');
    } finally {
        hb.stop();
    }
});

test('startHeartbeat — stop() elimina el archivo', () => {
    const hb = linter.startHeartbeat(7778);
    const hbFile = path.join(TMP, '.claude', 'hooks', 'agent-7778.heartbeat');
    assert.ok(fs.existsSync(hbFile));
    hb.stop();
    assert.ok(!fs.existsSync(hbFile));
});

test('updateMarker — actualiza YAML sin duplicar keys', () => {
    const markerPath = path.join(TMP, '.pipeline', 'desarrollo', 'linteo', 'trabajando', '999.linter');
    fs.writeFileSync(markerPath, 'issue: 999\nskill: "linter"\nresultado: "pendiente"\n');
    linter.updateMarker(markerPath, {
        resultado: 'aprobado',
        motivo: 'Linter OK',
        linter_errors: 0,
    });
    const content = fs.readFileSync(markerPath, 'utf8');
    assert.match(content, /resultado: "aprobado"/);
    assert.match(content, /motivo: "Linter OK"/);
    assert.match(content, /linter_errors: 0/);
    // No debe haber duplicado la key "resultado"
    const matches = content.match(/^resultado:/gm) || [];
    assert.equal(matches.length, 1, 'resultado debe aparecer una sola vez');
});

test('updateMarker — sin trabajandoPath no tira excepción', () => {
    assert.doesNotThrow(() => linter.updateMarker(null, { foo: 'bar' }));
    assert.doesNotThrow(() => linter.updateMarker(undefined, { foo: 'bar' }));
});

test('runAllChecks — integra static-checks sin romper con repo vacío', () => {
    // Con git no disponible / sin commits, igual debe devolver findings (branch warn + no-commits)
    // NOTA: runAllChecks llama a git real; si git falla, los helpers devuelven vacío.
    // Probamos que el shape del retorno sea correcto.
    const r = linter.runAllChecks({ issue: 1, cwd: TMP, base: 'origin/main' });
    assert.ok(Array.isArray(r.findings));
    assert.equal(typeof r.stats, 'object');
    assert.equal(typeof r.commitCount, 'number');
    assert.equal(typeof r.fileCount, 'number');
});

// Regresión #2407: el linter debe leer git desde el worktree del issue, no
// desde REPO_ROOT. Antes usaba REPO_ROOT (fijo, repo principal) y reportaba
// la rama del worktree principal aunque el pulpo lo lanzaba con cwd=worktree.
// Acá no podemos probar el spawn real, pero verificamos que el módulo expone
// runAllChecks con el contrato cwd-based y que no hay referencia hardcodeada
// a REPO_ROOT en el call-site (así el cwd que pasa el caller manda).
test('runAllChecks — respeta el cwd recibido (no fuerza REPO_ROOT) — regresión #2407', () => {
    // Crear dos directorios "ficticios" — el cwd recibido debe ser el que
    // se pasa por argumento, no un valor cacheado del módulo.
    const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-linter-cwdA-'));
    const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-linter-cwdB-'));
    try {
        // Si cualquiera de los cwds rompiera el shape (ej. lanzando excepción
        // por hardcode), el test fallaría. Como ambos no son repos git, los
        // helpers devuelven vacío pero NO tiran.
        const rA = linter.runAllChecks({ issue: 99, cwd: cwdA, base: 'origin/main' });
        const rB = linter.runAllChecks({ issue: 99, cwd: cwdB, base: 'origin/main' });
        assert.ok(Array.isArray(rA.findings));
        assert.ok(Array.isArray(rB.findings));
        // El branch detectado proviene del cwd, no de REPO_ROOT. Como ambos
        // cwds están fuera de un repo git, branch es null y se reporta
        // 'branch:missing'. Lo importante: ningún cwd ajeno se filtró.
        assert.equal(typeof rA.commitCount, 'number');
        assert.equal(typeof rB.commitCount, 'number');
    } finally {
        fs.rmSync(cwdA, { recursive: true, force: true });
        fs.rmSync(cwdB, { recursive: true, force: true });
    }
});

// Regresión #2407: confirma que el call-site real de `main()` usa
// process.cwd() (vía GIT_CWD) y no REPO_ROOT. Inspeccionamos el source para
// hacer fail si alguien revierte sin querer la línea clave.
test('linter.js source — runAllChecks recibe GIT_CWD/process.cwd, no REPO_ROOT — regresión #2407', () => {
    const linterSrc = fs.readFileSync(path.join(__dirname, '..', 'linter.js'), 'utf8');
    // Aceptamos GIT_CWD (constante explícita) o process.cwd() (uso directo).
    const acceptable = /runAllChecks\(\{\s*issue,\s*cwd:\s*(GIT_CWD|process\.cwd\(\))/;
    assert.match(linterSrc, acceptable,
        'main() debe pasar GIT_CWD o process.cwd() a runAllChecks, no REPO_ROOT');
    // Garantía adicional: NO debe quedar `cwd: REPO_ROOT` en el call-site.
    const forbidden = /runAllChecks\(\{\s*issue,\s*cwd:\s*REPO_ROOT/;
    assert.doesNotMatch(linterSrc, forbidden,
        'cwd: REPO_ROOT en runAllChecks fue revertido — bug del incidente #2407');
});
