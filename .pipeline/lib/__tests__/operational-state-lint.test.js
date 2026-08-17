'use strict';

// Tests: `lib/operational-state-lint` (#5175 — parte 1 de 3 del split de #5109).
//
// Estrategia (espeja `ghost-artifact-lint.test.js`): armamos un pipelineRoot
// sintético en tmpdir con archivos que reflejan patrones REALES del codebase
// —los verdaderos positivos y, sobre todo, los falsos positivos que el issue
// manda no marcar— y verificamos qué detecta y qué no.
//
// Para los tests de CLI (exit codes, prefijos, determinismo) copiamos el
// binario real dentro del tmpdir. `DEFAULT_PIPELINE_ROOT` se deriva de
// `__dirname`, así que la copia escanea el tmpdir sin necesidad de exponer
// ninguna opción de "root" en producción (que sería un bypass del guardrail:
// apuntarlo a un directorio vacío lo deja verde).
//
// Cada test mapea a un CA del issue — está anotado en el nombre.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const lint = require('../operational-state-lint');
// #5986 · CA-3 / SEC-4: el MISMO parser que consume el gate de merge de
// `delivery.js`. Prohibido reimplementar el parseo — dos parsers derivan.
const codeowners = require('../../skills-deterministicos/lib/codeowners');
const I = lint._internal;

const BIN_NAME = 'operational-state-lint.js';
const ALLOWLIST_NAME = 'operational-state-lint.allowlist.json';
const REAL_BIN = path.join(__dirname, '..', BIN_NAME);

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTmpPipeline() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-lint-'));
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    return root;
}

function placeJs(root, relPath, source) {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source, 'utf8');
    return full;
}

function emptyAllowlist() {
    return { files: new Set(), rules: [] };
}

/** Copia el binario REAL al tmpdir para ejercitar el CLI contra ese root. */
function installBin(root) {
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.copyFileSync(REAL_BIN, path.join(root, 'lib', BIN_NAME));
    return path.join(root, 'lib', BIN_NAME);
}

function writeAllowlistRaw(root, raw) {
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'lib', ALLOWLIST_NAME), raw, 'utf8');
}

function runCli(root, args) {
    const bin = path.join(root, 'lib', BIN_NAME);
    const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', all: (r.stdout || '') + (r.stderr || '') };
}

/** Línea 1-indexada donde aparece `needle` dentro de `source`. */
function lineOf(source, needle) {
    const idx = source.indexOf(needle);
    assert.ok(idx >= 0, `el fixture debe contener "${needle}"`);
    return source.slice(0, idx).split('\n').length;
}

// ─── Regla 1 · path-level ───────────────────────────────────────────────────

test('CA-1a/CA-3 · detecta un acceso path-level nuevo y reporta archivo:linea exacto', () => {
    const root = makeTmpPipeline();
    const src = [
        "const fs = require('fs');",
        "const path = require('path');",
        "function wavesFile(dir) {",
        "    return path.join(dir, 'waves.json');",
        "}",
        "module.exports = { wavesFile };",
    ].join('\n');
    placeJs(root, 'lib/nuevo-consumidor.js', src);

    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'lib/nuevo-consumidor.js');
    assert.equal(violations[0].rule, 'path-level');
    assert.equal(violations[0].line, lineOf(src, "path.join(dir, 'waves.json')"));
});

test('CA-1a · detecta los tres literales de estado (waves.json, .partial-pause.json, .paused)', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/tres.js', [
        "const path = require('path');",
        "const fs = require('fs');",
        "const a = path.join(D, 'waves.json');",
        "const b = path.join(D, '.partial-pause.json');",
        "const c = path.join(D, '.paused');",
    ].join('\n'));
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 3);
    assert.deepEqual([...new Set(violations.map(v => v.rule))], ['path-level']);
});

test('CA-6c · NO marca copy del operador — literal dentro de un confirm(...) sin contexto de path', () => {
    const root = makeTmpPipeline();
    // Regresión de UX-6. Modelado sobre `dashboard.js:7833`, que es texto
    // visible al usuario, no construccion de path.
    placeJs(root, 'lib/copy-operador.js', [
        "function quitarIssue(issue) {",
        "    if (!confirm('Quitar #' + issue + ' de la allowlist? Esto modifica ' + '.partial-pause.json' + ' y el Pulpo deja de procesarlo.')) return;",
        "    enviar(issue);",
        "}",
    ].join('\n'));
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 0, 'copy del operador no es un acceso');
});

test('CA-6c · NO marca valores de dominio (wave.source !== "waves.json")', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/dominio.js', [
        "function esLegacy(wave) {",
        "    return wave.source !== 'waves.json';",
        "}",
        "const catalogo = [{ file: 'waves.json', key: 'waves' }];",
    ].join('\n'));
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 0);
});

// ─── Regla 1 · formas de EVASION del literal (rebote rev-2) ─────────────────
//
// El matcher original exigia la comilla PEGADA al nombre del archivo, asi que
// cualquier literal que fuera FRAGMENTO DE PATH lo evadia sin entrar siquiera
// al bucket BRUTO. Caso real: `views/dashboard/mizpa-frame.js:42`, un lector
// vivo de `waves.json` ausente del inventario. Un test por forma.

test('rebote rev-2 · detecta el literal con PREFIJO DE PATH relativo (caso mizpa-frame.js:42)', () => {
    const root = makeTmpPipeline();
    // Copia literal de la linea que evadia el matcher.
    const src = [
        "const path = require('path');",
        "const WAVES_PATH = path.join(__dirname, '../../waves.json');",
        "module.exports = { WAVES_PATH };",
    ].join('\n');
    placeJs(root, 'views/dashboard/marco.js', src);

    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 1, 'el prefijo de path no puede evadir el matcher');
    assert.equal(violations[0].file, 'views/dashboard/marco.js');
    assert.equal(violations[0].rule, 'path-level');
    assert.equal(violations[0].line, lineOf(src, "'../../waves.json'"));
});

test('rebote rev-2 · el literal con prefijo entra al bucket BRUTO aunque se descarte', () => {
    // `raw: 0` era lo grave del falso negativo: invisible incluso para la
    // auditoria del delta bruto-vs-confirmado que publica el inventario.
    const scan = I.lintSource('lib/x.js', [
        "// el estado vive en '.pipeline/waves.json' y lo lee el dashboard",
        "const path = require('path');",
        "const p = path.join(dir, 'logs');",
    ].join('\n'), emptyAllowlist());
    assert.equal(scan.rawLiteralHits, 1, 'debe contarse en el bruto');
    assert.equal(scan.commentHits, 1, 'y descartarse por linea comentada');
    assert.equal(scan.violations.length, 0);
});

test('rebote rev-2 · detecta el prefijo de path con separador Windows', () => {
    const root = makeTmpPipeline();
    const src = [
        "const path = require('path');",
        "const p = path.resolve(base, '..\\\\.paused');",
    ].join('\n');
    placeJs(root, 'lib/win.js', src);
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'path-level');
});

test('rebote rev-2 · detecta la concatenacion con separador dentro del literal', () => {
    const root = makeTmpPipeline();
    const src = [
        "const fs = require('fs');",
        "const raw = fs.readFileSync(DIR + '/.partial-pause.json', 'utf8');",
    ].join('\n');
    placeJs(root, 'lib/concat.js', src);
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'path-level');
});

test('rebote rev-2 · el prefijo NO cruza el borde del literal (sin falsos positivos entre strings)', () => {
    // `[^'"`\n]*` excluye comillas y saltos: el match no puede empezar en una
    // comilla de OTRO literal y arrastrarse hasta el nombre del archivo.
    const scan = I.lintSource('lib/y.js', [
        "const path = require('path');",
        "const p = path.join('logs/', dir, unrelated, 'waves.json');",
    ].join('\n'), emptyAllowlist());
    // Un solo hit bruto: el de `'waves.json'`. Si el prefijo cruzara comillas,
    // el motor reportaria un match que arranca en `'logs/`.
    assert.equal(scan.rawLiteralHits, 1);
    assert.equal(scan.violations.length, 1);
});

test('rebote rev-2 · LIMITE CONOCIDO: la concatenacion partida del nombre NO se detecta', () => {
    // Documentado a proposito en el inventario y en el comentario de
    // STATE_LITERAL_RE. Si algun dia se cierra, este test avisa.
    const scan = I.lintSource('lib/partido.js', [
        "const path = require('path');",
        "const p = path.join(dir, 'waves' + '.json');",
    ].join('\n'), emptyAllowlist());
    assert.equal(scan.rawLiteralHits, 0, 'limite conocido: nombre partido en dos literales');
    assert.equal(scan.violations.length, 0);
});

test('rebote rev-2 · LIMITE CONOCIDO: la indireccion por constante lejana NO se detecta', () => {
    // La declaracion de la constante entra al bruto, pero se descarta por falta
    // de contexto de path si esta a mas de +-3 lineas del `path.join`.
    const scan = I.lintSource('lib/indirecto.js', [
        "const WAVES_FILE = 'waves.json';",
        "", "", "", "", "",
        "const path = require('path');",
        "const p = path.join(dir, WAVES_FILE);",
    ].join('\n'), emptyAllowlist());
    assert.equal(scan.rawLiteralHits, 1);
    assert.equal(scan.noCtxHits, 1, 'limite conocido: la constante queda fuera del radio');
    assert.equal(scan.violations.length, 0);
});

test('CA-6c · NO marca lineas comentadas aunque haya un path.join de otra cosa cerca', () => {
    const root = makeTmpPipeline();
    // Caso verificado en `lib/wizards/ola/index.js:49`: comentario que menciona
    // `waves.json` a 3 lineas de un `path.join` de logs. Sin esta regla, el
    // radio de +-3 lo confirma y contamina el inventario.
    placeJs(root, 'lib/comentado.js', [
        "const path = require('path');",
        "// Los tests sustituyen las deps para no tocar el `waves.json` real.",
        "/** Lee el allowlist actual de `.partial-pause.json` (defensivo). */",
        "let auditDir = path.join(__dirname, '..', 'logs');",
    ].join('\n'));
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 0);
});

test('regresion review · detecta path-level dentro de un metodo generador', () => {
    const src = [
        "const path = require('path');",
        'const loader = {',
        "  *load() { return path.join(root, 'waves.json'); }",
        '};',
    ].join('\n');
    const result = I.lintSource('lib/generator-loader.js', src, emptyAllowlist());
    assert.deepEqual(result.violations, [
        { file: 'lib/generator-loader.js', line: 3, rule: 'path-level' },
    ]);
    assert.equal(result.commentHits, 0);
});

test('rebote rev-3 · un delimitador de bloque dentro de un string no oculta el metodo generador posterior', () => {
    const src = [
        "const path = require('path');",
        "const marker = '/*';",
        'const loader = {',
        "  *load() { return path.join(root, 'waves.json'); }",
        '};',
    ].join('\n');
    const result = I.lintSource('lib/generator-after-string.js', src, emptyAllowlist());
    assert.deepEqual(result.violations, [
        { file: 'lib/generator-after-string.js', line: 4, rule: 'path-level' },
    ]);
    assert.equal(result.commentHits, 0);
});

test('rebote rev-3 · delimitadores dentro de template y regex tampoco abren comentarios', () => {
    for (const marker of ['const marker = `/*`;', 'const marker = /\\/\\*/;']) {
        const src = [
            "const path = require('path');",
            marker,
            'const loader = {',
            "  *load() { return path.join(root, 'waves.json'); }",
            '};',
        ].join('\n');
        const result = I.lintSource('lib/generator-after-literal.js', src, emptyAllowlist());
        assert.equal(result.violations.length, 1, marker);
        assert.equal(result.commentHits, 0, marker);
    }
});

test('regresion review · mantiene descartada una continuacion JSDoc real', () => {
    const src = [
        "const path = require('path');",
        '/**',
        " * Documenta 'waves.json' sin acceder al archivo.",
        ' */',
        "const logs = path.join(root, 'logs');",
    ].join('\n');
    const result = I.lintSource('lib/jsdoc.js', src, emptyAllowlist());
    assert.deepEqual(result.violations, []);
    assert.equal(result.commentHits, 1);
});

test('rebote rev-3 · mantiene un bloque real abierto despues de una division', () => {
    const src = [
        "const path = require('path');",
        'const ratio = total / count; /*',
        " * Documenta 'waves.json' sin acceder al archivo.",
        ' */',
        "const logs = path.join(root, 'logs');",
    ].join('\n');
    const result = I.lintSource('lib/jsdoc-after-division.js', src, emptyAllowlist());
    assert.deepEqual(result.violations, []);
    assert.equal(result.commentHits, 1);
});

test('CA-1a · la aritmetica de buckets particiona exacto el numero bruto', () => {
    const root = makeTmpPipeline();
    // El literal de dominio va LEJOS del path.join (mas de +-3 lineas), si no
    // el radio de confirmacion lo alcanza y deja de ser un descarte por
    // contexto.
    placeJs(root, 'lib/mixto.js', [
        "const path = require('path');",
        "// menciona 'waves.json' en un comentario",
        "const real = path.join(D, 'waves.json');",
        "", "", "", "", "",
        "const dominio = w.source !== '.paused';",
    ].join('\n'));
    const r = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(r.rawLiteralHits, r.commentHits + r.noCtxHits + r.confirmedHits);
    assert.equal(r.commentHits, 1);
    assert.equal(r.confirmedHits, 1);
    assert.equal(r.noCtxHits, 1);
});

// ─── Regla 2 · internal-bypass ──────────────────────────────────────────────

test('CA-6a · detecta <binding>._internal cuando el binding viene del require del envoltorio', () => {
    const root = makeTmpPipeline();
    const src = [
        "const ops = require('./operational-state');",
        "function rutas() {",
        "    return ops._internal.paths();",
        "}",
    ].join('\n');
    placeJs(root, 'lib/bypass-ns.js', src);
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'internal-bypass');
    assert.equal(violations[0].line, lineOf(src, 'ops._internal.paths()'));
});

test('CA-6a · detecta la forma DESTRUCTURADA del require (un regex sobre ._internal se evade con destructuring)', () => {
    const root = makeTmpPipeline();
    const src = [
        "const { getActiveWave, _internal } = require('../operational-state');",
        "const p = _internal.paths();",
    ].join('\n');
    placeJs(root, 'lib/sub/bypass-dest.js', src);
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.ok(violations.length >= 1, 'la destructuracion de _internal es el bypass');
    assert.deepEqual([...new Set(violations.map(v => v.rule))], ['internal-bypass']);
    assert.ok(violations.some(v => v.line === lineOf(src, 'require')), 'se reporta en la linea del require');
});

test('CA-6a · detecta el ALIAS de la forma destructurada', () => {
    const root = makeTmpPipeline();
    const src = [
        "const { _internal: guts } = require('./operational-state');",
        "const p = guts.paths();",
    ].join('\n');
    placeJs(root, 'lib/bypass-alias.js', src);
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.deepEqual([...new Set(violations.map(v => v.rule))], ['internal-bypass']);
    assert.ok(violations.some(v => v.line === lineOf(src, 'guts.paths()')), 'el uso del alias tambien se reporta');
});

test('CA-6a · NO marca el _internal de OTROS modulos (convencion transversal, 78 archivos)', () => {
    const root = makeTmpPipeline();
    // R1: los 8 casos citados en el issue son `_internal: {` de export propio.
    placeJs(root, 'lib/ajeno.js', [
        "function helper() { return 1; }",
        "module.exports = { helper, _internal: { helper } };",
    ].join('\n'));
    // Y la destructuracion de `_internal` de un modulo que NO es el envoltorio
    // (caso real: `dashboard-slices.js:1714` con `./wave-snapshot`).
    placeJs(root, 'lib/ajeno-dest.js', [
        "const { _internal } = require('./wave-snapshot');",
        "const p = _internal.reset();",
    ].join('\n'));
    // Y un consumidor legitimo de la superficie publica del envoltorio.
    placeJs(root, 'lib/consumidor-ok.js', [
        "const ops = require('./operational-state');",
        "const wave = ops.getActiveWave();",
        "const ok = ops.isIssueAllowed(5175);",
    ].join('\n'));
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 0);
});

test('CA-6b/R4 · binding invalido (require malformado): se descarta el candidato, sin excepcion y sin exit 2', () => {
    const root = makeTmpPipeline();
    // Un binding no-identificador interpolado en `new RegExp` seria SyntaxError
    // = exit 2 en todo el scan (DoS del guardrail). Se descarta antes.
    placeJs(root, 'lib/malformado.js', [
        "const 9bad = require('./operational-state');",
        "const $$$ = require('./operational-state');",
        "const a.b = require('./operational-state');",
    ].join('\n'));
    let result;
    assert.doesNotThrow(() => {
        result = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    });
    assert.equal(result.violations.length, 0);
});

test('CA-6b · el matcher NO es /\\._internal/ a secas', () => {
    // Guarda estructural: si alguien "simplifica" el matcher a un regex sobre
    // `._internal`, este assert lo agarra antes de que nazca con 78 archivos
    // de superficie (R1).
    const srcBin = fs.readFileSync(REAL_BIN, 'utf8');
    assert.ok(/resolveWrapperBindings/.test(srcBin), 'debe resolver el binding del require');
    assert.ok(I.ID_RE.test('ops') && !I.ID_RE.test('9bad'), 'la guarda de identificador debe existir');
});

// ─── Shape del violation · sin snippet (CA-3b / SEC-2) ──────────────────────

test('CA-3b/SEC-2 · el violation tiene EXACTAMENTE {file,line,rule} — sin snippet', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/x.js', "const path=require('path');\nconst p = path.join(D, '.paused');");
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 1);
    assert.deepEqual(Object.keys(violations[0]).sort(), ['file', 'line', 'rule']);
    assert.ok(!('snippet' in violations[0]));
    assert.ok(!('reason' in violations[0]));
});

test('CA-3b · la salida FORMATEADA no emite el snippet (assert sobre el string, no sobre el objeto)', () => {
    const linea = I.formatViolation({ file: 'lib/x.js', line: 42, rule: 'path-level' }, 'AVISO:');
    assert.match(linea, /^AVISO: lib\/x\.js:42 - regla path-level/);
    assert.ok(!/path\.join/.test(linea), 'nada de codigo fuente en la salida');
    assert.ok(!/waves\.json/.test(linea));
});

test('CA-3b/SEC-2 · --report --json NO contiene ninguna substring del codigo escaneado', () => {
    const root = makeTmpPipeline();
    installBin(root);
    const TOKEN = 'IDENTIFICADOR_SENSIBLE_QUE_NO_DEBE_FILTRARSE';
    placeJs(root, 'lib/con-token.js', [
        "const path = require('path');",
        `const ${TOKEN} = path.join(D, 'waves.json');`,
    ].join('\n'));
    const r = runCli(root, ['--report', '--json']);
    assert.equal(r.code, 0);
    assert.ok(!r.all.includes(TOKEN), 'el repo es publico y los logs de Actions tambien');
    const j = JSON.parse(r.stdout);
    assert.equal(j.totals.violations, 1);
    assert.deepEqual(Object.keys(j.violations[0]).sort(), ['file', 'line', 'rule']);
});

// ─── CA-3 · mensaje accionable y desambiguacion (UX-A / UX-B) ───────────────

test('CA-3/UX-B · la remediacion de path-level lista LAS DOS funciones de allowlist y remite al contrato §3', () => {
    const out = I.remediationLines(new Set(['path-level'])).join('\n');
    assert.match(out, /getWaveScopeIssues\(\)/);
    assert.match(out, /getDispatchState\(\)/);
    assert.match(out, /isIssueAllowed\(\)/);
    assert.match(out, /NO gatea el dispatch/);
    assert.match(out, /SI gatea el dispatch/);
    assert.match(out, /contrato-estado-operativo\.md §3/);
});

test('CA-3/UX-A · la remediacion de internal-bypass NO dice "usa el envoltorio" y remite al §7', () => {
    const out = I.remediationLines(new Set(['internal-bypass'])).join('\n');
    assert.match(out, /PEDI EXTENDERLA/);
    assert.match(out, /contrato-estado-operativo\.md §7/);
    // "usa el envoltorio" es NO accionable acá: el dev ya lo importo.
    assert.ok(!/Importar `lib\/operational-state\.js`/.test(out));
});

// ─── Scope (CA-6d / R2 / R7) ────────────────────────────────────────────────

test('CA-6d/R2 · test-*.js queda fuera POR SCOPE, con allowlist vacia', () => {
    const root = makeTmpPipeline();
    // `test-desync-status-slice.js:134-135` del repo real hace este path.join.
    placeJs(root, 'test-desync-status-slice.js', [
        "const path = require('path');",
        "const w = path.join(dir, 'waves.json');",
        "const p = path.join(dir, '.partial-pause.json');",
    ].join('\n'));
    const allowlist = emptyAllowlist();
    const { violations } = lint.lint({ pipelineRoot: root, allowlist });
    assert.equal(violations.length, 0);
    assert.equal(allowlist.files.size, 0, 'sin entradas de allowlist — es scope, no excepcion');
    assert.equal(allowlist.rules.length, 0);
    // Y el archivo no esta ni siquiera en la lista de escaneados.
    assert.ok(!I.walkJs(root).some(f => f.endsWith('test-desync-status-slice.js')));
});

test('R7 · __tests__/ y *.test.js quedan fuera (sus fixtures tienen literales a proposito)', () => {
    const root = makeTmpPipeline();
    const body = "const path=require('path');\nconst w = path.join(D, 'waves.json');";
    placeJs(root, 'lib/__tests__/algo.test.js', body);
    placeJs(root, 'lib/otro.test.js', body);
    placeJs(root, 'node_modules/pkg/index.js', body);
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 0);
});

test('CA-10 · SELF_EXEMPT: el sustrato del envoltorio y el propio guardrail no se autoauditan', () => {
    const root = makeTmpPipeline();
    const body = "const path=require('path');\nconst w = path.join(D, 'waves.json');\nconst p = path.join(D, '.partial-pause.json');";
    for (const rel of ['lib/operational-state.js', 'lib/waves.js', 'lib/partial-pause.js', 'lib/operational-state-lint.js']) {
        placeJs(root, rel, body);
    }
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 0);
    assert.deepEqual([...I.SELF_EXEMPT].sort(), [
        'lib/operational-state-lint.js',
        'lib/operational-state.js',
        'lib/partial-pause.js',
        'lib/waves.js',
    ]);
});

// ─── Allowlist (CA-5 / CA-5b / CA-5c / SEC-3 / SEC-4) ───────────────────────

test('CA-5 · regla puntual {file,line,reason} skipea esa violation', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/bad.js', "const path=require('path');\nconst w = path.join(D, 'waves.json');");
    const base = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(base.violations.length, 1);
    const ruled = { files: new Set(), rules: [{ file: 'lib/bad.js', line: base.violations[0].line, reason: 'migrado en la parte 2, ver #5109' }] };
    assert.equal(lint.lint({ pipelineRoot: root, allowlist: ruled }).violations.length, 0);
});

test('CA-5 · exencion de archivo entero skipea todas las violations del archivo', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/todo-mal.js', "const path=require('path');\nconst a=path.join(D,'waves.json');\nconst b=path.join(D,'.paused');");
    const allowlist = { files: new Set(['lib/todo-mal.js']), rules: [] };
    assert.equal(lint.lint({ pipelineRoot: root, allowlist }).violations.length, 0);
});

test('CA-5c/SEC-3 · reason vacia, placeholder, con control chars o que empieza con :: es invalida', () => {
    const bad = ['', '   ', 'TODO', 'fixme', 'TBD', 'placeholder', 'wip', '---', '...', '::stop-commands::abcd', '\r\n', ' '];
    for (const r of bad) {
        assert.throws(
            () => I.sanitizeReason(r, 'test'),
            (e) => e instanceof I.LintConfigError,
            `reason invalida debe romper: ${JSON.stringify(r)}`,
        );
    }
    for (const r of [undefined, null, 42, {}, []]) {
        assert.throws(() => I.sanitizeReason(r, 'test'), (e) => e instanceof I.LintConfigError);
    }
});

test('CA-5c/SEC-3 · reason valida se sanitiza: sin control chars y truncada a 200', () => {
    assert.equal(I.sanitizeReason('migrado\nen\tla parte 2', 'test'), 'migrado en la parte 2');
    assert.equal(I.sanitizeReason('x'.repeat(500), 'test').length, 200);
});

test('CA-5c · CLI: reason placeholder en la allowlist ⇒ exit 2 (no exit 0, no exit 1)', () => {
    const root = makeTmpPipeline();
    installBin(root);
    placeJs(root, 'lib/bad.js', "const path=require('path');\nconst w = path.join(D, 'waves.json');");
    writeAllowlistRaw(root, JSON.stringify({ files: [], rules: [{ file: 'lib/bad.js', line: 2, reason: 'TODO' }] }));
    for (const mode of ['--report', '--report-only', '--check']) {
        const r = runCli(root, [mode]);
        assert.equal(r.code, 2, `${mode} debe salir 2 — el exit 2 NO esta subordinado al modo`);
        assert.match(r.all, /placeholder/i);
    }
});

test('CA-5b/SEC-4 · allowlist con JSON invalido ⇒ exit 2, NUNCA allowlist vacia silenciosa', () => {
    const root = makeTmpPipeline();
    installBin(root);
    placeJs(root, 'lib/bad.js', "const path=require('path');\nconst w = path.join(D, 'waves.json');");
    writeAllowlistRaw(root, '{ "files": [], "rules": [ ');   // truncada
    const r = runCli(root, ['--report-only']);
    assert.equal(r.code, 2);
    assert.match(r.all, /allowlist\.json: JSON/);
    // El punto de SEC-4: corrupta y vacia-a-proposito no pueden confundirse.
    assert.match(r.all, /indistinguibles/);
});

test('CA-5b · allowlist con BOM ⇒ exit 2 (no se degrada a vacia)', () => {
    const root = makeTmpPipeline();
    installBin(root);
    writeAllowlistRaw(root, '﻿{ "files": [], "rules": [] }');
    assert.equal(runCli(root, ['--report']).code, 2);
});

test('CA-5b · shape invalido de la allowlist ⇒ exit 2, citando el entry ofensor', () => {
    const root = makeTmpPipeline();
    installBin(root);
    const casos = [
        ['[]', /se esperaba un objeto \{ files: \[\], rules: \[\] \}/],
        ['{"files": {}}', /"files" debe ser un array/],
        ['{"rules": {}}', /"rules" debe ser un array/],
        ['{"rules": [{"file": "lib/a.js", "reason": "ok real"}]}', /rules\[0\].*"line"/s],
        ['{"rules": [{"line": 3, "reason": "ok real"}]}', /rules\[0\].*"file"/s],
        ['{"rules": [{"file": "lib/a.js", "line": 0, "reason": "ok real"}]}', /rules\[0\].*entero >= 1/s],
        ['{"rules": [{"file": "lib/a.js", "line": 3}]}', /rules\[0\].*reason/s],
        ['{"carpetas": ["lib/"]}', /clave desconocida/],
    ];
    for (const [raw, re] of casos) {
        writeAllowlistRaw(root, raw);
        const r = runCli(root, ['--report']);
        assert.equal(r.code, 2, `debe salir 2 para ${raw}`);
        assert.match(r.all, re, `mensaje esperado para ${raw}`);
    }
});

test('CA-5 · exencion de archivo entero exige {file,reason}: un string pelado ⇒ exit 2', () => {
    const root = makeTmpPipeline();
    installBin(root);
    writeAllowlistRaw(root, '{"files": ["lib/a.js"], "rules": []}');
    const r = runCli(root, ['--report']);
    assert.equal(r.code, 2);
    assert.match(r.all, /se esperaba \{ file, reason \}/);
});

test('CA-10 · la allowlist REAL del repo nace vacia y carga sin errores', () => {
    const al = I.loadAllowlist(path.join(__dirname, '..', '..'));
    assert.equal(al.files.size, 0, 'files debe estar vacio (CA-10)');
    assert.equal(al.rules.length, 0, 'rules debe estar vacio (CA-10)');
});

test('CA-5b · allowlist AUSENTE si es allowlist vacia (la ausencia no es ambigua, la corrupcion si)', () => {
    const root = makeTmpPipeline();
    const al = I.loadAllowlist(root);
    assert.equal(al.files.size, 0);
    assert.equal(al.rules.length, 0);
});

// ─── Modos y exit codes (CA-9a / UX-3) ──────────────────────────────────────

test('CA-9a · --report-only ⇒ exit 0 con prefijo AVISO:, y se auto-declara no bloqueante', () => {
    const root = makeTmpPipeline();
    installBin(root);
    placeJs(root, 'lib/bad.js', "const path=require('path');\nconst w = path.join(D, 'waves.json');");
    const r = runCli(root, ['--report-only']);
    assert.equal(r.code, 0, 'report-only NUNCA falla por violations');
    assert.match(r.all, /^AVISO: lib\/bad\.js:2 /m);
    assert.ok(!/^ERROR:/m.test(r.all));
    assert.match(r.all, /NO bloquea el commit ni el build/);
    assert.match(r.all, /parte 3 de #5109/);
});

test('CA-9a · --check con violations ⇒ exit 1 con prefijo ERROR:', () => {
    const root = makeTmpPipeline();
    installBin(root);
    placeJs(root, 'lib/bad.js', "const path=require('path');\nconst w = path.join(D, 'waves.json');");
    const r = runCli(root, ['--check']);
    assert.equal(r.code, 1);
    assert.match(r.all, /^ERROR: lib\/bad\.js:2 /m);
    assert.ok(!/^AVISO: lib\//m.test(r.all), 'los prefijos de --check y --report-only son distintos');
});

test('CA-9a · --check sin violations ⇒ exit 0', () => {
    const root = makeTmpPipeline();
    installBin(root);
    placeJs(root, 'lib/limpio.js', "const ops = require('./operational-state');\nmodule.exports = () => ops.getActiveWave();");
    const r = runCli(root, ['--check']);
    assert.equal(r.code, 0);
    assert.match(r.all, /0 violations/);
});

test('CA-9a · uso invalido ⇒ exit 2 con `uso:` (sin modo, modo desconocido, modos combinados, --json fuera de --report)', () => {
    const root = makeTmpPipeline();
    installBin(root);
    for (const args of [[], ['--nope'], ['--check', '--report'], ['--check', '--json'], ['--report-only', '--json']]) {
        const r = runCli(root, args);
        assert.equal(r.code, 2, `args=${JSON.stringify(args)} debe salir 2`);
        assert.match(r.all, /uso: node \.pipeline\/lib\/operational-state-lint\.js/);
    }
});

test('UX-1 · --only limita la salida a los archivos pasados (el hook pasa los staged)', () => {
    const root = makeTmpPipeline();
    installBin(root);
    placeJs(root, 'lib/uno.js', "const path=require('path');\nconst w = path.join(D, 'waves.json');");
    placeJs(root, 'lib/dos.js', "const path=require('path');\nconst w = path.join(D, '.paused');");
    const r = runCli(root, ['--report-only', '--only=.pipeline/lib/uno.js']);
    assert.equal(r.code, 0);
    assert.match(r.all, /lib\/uno\.js:2/);
    assert.ok(!/lib\/dos\.js/.test(r.all), '--only debe excluir lo no tocado');
});

// ─── Inventario reproducible (CA-1a / UX-D / UX-E) ──────────────────────────

test('CA-1a/UX-D · --report es determinista: dos corridas seguidas dan salida byte-identica', () => {
    const root = makeTmpPipeline();
    installBin(root);
    placeJs(root, 'lib/b.js', "const path=require('path');\nconst w = path.join(D, 'waves.json');");
    placeJs(root, 'lib/a.js', "const path=require('path');\nconst w = path.join(D, '.paused');");
    placeJs(root, 'zzz.js', "const path=require('path');\nconst w = path.join(D, '.partial-pause.json');");
    const r1 = runCli(root, ['--report']);
    const r2 = runCli(root, ['--report']);
    assert.equal(r1.code, 0);
    assert.equal(r2.code, 0);
    assert.equal(r1.stdout, r2.stdout, '--report debe ser byte-identico entre corridas');
});

test('CA-1a/UX-E · --report no emite timestamps ni rutas absolutas, y ordena alfabeticamente', () => {
    const root = makeTmpPipeline();
    installBin(root);
    placeJs(root, 'lib/zeta.js', "const path=require('path');\nconst w = path.join(D, 'waves.json');");
    placeJs(root, 'lib/alfa.js', "const path=require('path');\nconst w = path.join(D, '.paused');");
    const out = runCli(root, ['--report']).stdout;
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(out), 'sin timestamps');
    assert.ok(!/[A-Za-z]:\\/.test(out), 'sin rutas absolutas Windows');
    assert.ok(!out.includes(root), 'sin la ruta absoluta del root');
    assert.ok(!/\\/.test(out.split('\n').filter(l => l.startsWith('- `')).join('')), 'paths siempre en POSIX');
    assert.ok(out.indexOf('lib/alfa.js') < out.indexOf('lib/zeta.js'), 'orden alfabetico por path');
});

test('CA-1a · --report separa produccion de tests y emite fila de total', () => {
    const root = makeTmpPipeline();
    installBin(root);
    placeJs(root, 'lib/prod.js', "const path=require('path');\nconst w = path.join(D, 'waves.json');");
    const out = runCli(root, ['--report']).stdout;
    assert.match(out, /\| archivo \| scope \| path-level \| internal-bypass \| total \|/);
    assert.match(out, /subtotal produccion/);
    assert.match(out, /subtotal tests/);
    assert.match(out, /\*\*TOTAL\*\*/);
    assert.match(out, /`lib\/prod\.js` \| produccion \| 1 \| 0 \| 1/);
});

test('CA-1a · classifyScope distingue produccion de tests', () => {
    assert.equal(I.classifyScope('lib/foo.js'), 'produccion');
    assert.equal(I.classifyScope('pulpo.js'), 'produccion');
    assert.equal(I.classifyScope('lib/foo.test.js'), 'tests');
    assert.equal(I.classifyScope('test-concurrencia.js'), 'tests');
    assert.equal(I.classifyScope('lib/__tests__/foo.js'), 'tests');
    assert.equal(I.classifyScope('lib/fixtures/foo.js'), 'tests');
});

// ─── Smoke contra el repo real ──────────────────────────────────────────────

test('smoke · lint del repo real devuelve un resultado bien formado y SIN snippet', () => {
    // Ojo: en la PARTE 1 el repo real TIENE violations a proposito (la migracion
    // va en las partes 2 y 3, #5109). Por eso este smoke NO asserta cero — eso
    // seria el test de la parte 3. Lo que se verifica acá es que el control
    // corre end-to-end sobre el codebase real y que su salida no filtra codigo.
    const { violations, scanned, rawLiteralHits, commentHits, noCtxHits, confirmedHits } = lint.lint();
    assert.ok(scanned > 100, `debe escanear el codebase real (scanned=${scanned})`);
    assert.equal(rawLiteralHits, commentHits + noCtxHits + confirmedHits, 'los buckets particionan exacto');
    for (const v of violations) {
        assert.deepEqual(Object.keys(v).sort(), ['file', 'line', 'rule'], 'shape estructural, sin snippet');
        assert.ok(I.RULES.includes(v.rule));
        assert.ok(Number.isInteger(v.line) && v.line >= 1);
        assert.ok(!v.file.includes('\\') && !/^[A-Za-z]:/.test(v.file), 'paths POSIX relativos');
        assert.ok(!I.SELF_EXEMPT.has(v.file));
        assert.ok(!v.file.split('/').pop().startsWith('test-'), 'test-*.js fuera por scope (R2)');
        assert.ok(!v.file.endsWith('.test.js'));
    }
});

test('smoke · los casos de copy/dominio verificados del repo real NO se reportan (UX-6)', () => {
    const { violations } = lint.lint();
    const reported = new Set(violations.map(v => `${v.file}:${v.line}`));
    // Verificados textualmente contra origin/main por guru, security, po y ux.
    const copy = [
        'dashboard.js:7833', 'dashboard.js:7901', 'dashboard.js:8092',
        'lib/audit-trail-renderer.js:171',
        'lib/kernel-store-migrate.js:54',
        'lib/multi-provider/smoke-test.js:186',
        'lib/commander-deterministic.js:2373',
    ];
    for (const c of copy) {
        assert.ok(!reported.has(c), `${c} es copy del operador o valor de dominio, no un acceso`);
    }
});

// ─── #5986 · la asercion de CODEOWNERS PARSEA, no matchea texto ─────────────
//
// La version original de este bloque (#5202) hacia `co.includes('/.pipeline/
// lib/operational-state-lint.js')` sobre el archivo CRUDO. Cuando #5175/#5975
// reescribieron CODEOWNERS como archivo declarativo sin reglas activas, los 3
// paths quedaron como COMENTARIOS y la asercion siguio pasando: verde sobre una
// frontera desprotegida, que es peor que no tener control porque induce a no
// mirar. #5986 la reconcilia contra el mecanismo real.

/**
 * SEC-1: el 4to path es el propio CODEOWNERS. Sin el, un PR que toca solo ese
 * archivo borra las otras 3 reglas y auto-mergea (bypass de dos pasos); el PR
 * siguiente ya edita la allowlist libre. Precedente real: #5975 toco unicamente
 * `.github/CODEOWNERS` y mergeo con 14 checks verdes.
 */
const GUARDRAIL_PATHS = [
    '.pipeline/lib/operational-state-lint.js',
    '.pipeline/lib/operational-state-lint.allowlist.json',
    '.pipeline/lib/__tests__/operational-state-lint.test.js',
    '.github/CODEOWNERS',
];

/**
 * Paths del guardrail SIN owner humano por una regla ACTIVA.
 *
 * Delega en el MISMO modulo que consume el gate de merge de `delivery.js`
 * (`skills-deterministicos/lib/codeowners.js`) a proposito: dos parsers derivan,
 * y el dia que difieran el test dice verde mientras el gate no bloquea — el
 * mismo falso verde que #5986 cierra, reconstruido un nivel mas arriba.
 *
 * `getHumanOwners` y no `parseCodeowners` a secas: el parser ACEPTA owners tipo
 * team/bot (`@intrale/bots`), asi que un assert sobre `rules.length`
 * sobreviviria la mutacion (c).
 */
function uncoveredGuardrailPaths(codeownersContent) {
    const rules = codeowners.parseCodeowners(codeownersContent);
    return GUARDRAIL_PATHS.filter(p => codeowners.getHumanOwners(rules, [p]).length === 0);
}

const GATE_CODEOWNERS_ESPERADO = false;

/** Clasificacion pura del contenido, independiente del filesystem. */
function classifyGuardrailCodeowners(codeownersContent) {
    const rules = codeowners.parseCodeowners(codeownersContent);
    const active = codeowners.resolveOwners(rules, GUARDRAIL_PATHS).length;
    const mentioned = GUARDRAIL_PATHS.filter(p => codeownersContent.includes(`/${p}`)).length;
    if (active > 0) return 'regla-activa';
    if (mentioned > 0) return 'solo-comentarios';
    return 'sin-mencion';
}

function readRealCodeowners() {
    return fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'CODEOWNERS'), 'utf8');
}

test('smoke · el CODEOWNERS real es coherente con la politica declarativa vigente', () => {
    const mode = classifyGuardrailCodeowners(readRealCodeowners());
    assert.equal(mode, GATE_CODEOWNERS_ESPERADO ? 'regla-activa' : 'solo-comentarios');
});

// ─── CA-4 · tabla de mutacion: la asercion tiene que MORIR ───────────────────
//
// Contenido sintetico, no se toca el archivo real. La asercion vieja
// (`String.includes`) sobrevive (a) y (d) — ese es exactamente el defecto.

const CO_OK = [
    '/.pipeline/lib/operational-state-lint.js                 @leitolarreta',
    '/.pipeline/lib/operational-state-lint.allowlist.json     @leitolarreta',
    '/.pipeline/lib/__tests__/operational-state-lint.test.js  @leitolarreta',
    '/.github/CODEOWNERS                                      @leitolarreta',
].join('\n');

const MODOS_CODEOWNERS = [
    ['sin-mencion', '# responsables generales, sin paths del guardrail\n'],
    ['solo-comentarios', CO_OK.split('\n').map(l => `# ${l}`).join('\n')],
    ['regla-activa', CO_OK],
];

for (const [modo, contenido] of MODOS_CODEOWNERS) {
    test(`#5986 · clasifica el modo ${modo} como funcion pura`, () => {
        assert.equal(classifyGuardrailCodeowners(contenido), modo);
    });
}

test('#5986 · un owner bot sigue siendo regla activa, pero no ownership humano', () => {
    const contenido = CO_OK.replace(/@leitolarreta/g, '@intrale/bots');
    assert.equal(classifyGuardrailCodeowners(contenido), 'regla-activa');
    assert.equal(uncoveredGuardrailPaths(contenido).length, GUARDRAIL_PATHS.length);
});

test('CA-8/CA-UX-1 · el _doc de la allowlist describe la politica declarativa vigente', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', ALLOWLIST_NAME), 'utf8'))._doc;
    assert.match(doc, /declarativ/i);
    assert.match(doc, /sin reglas activas/i);
    assert.equal(classifyGuardrailCodeowners(readRealCodeowners()), 'solo-comentarios');
});

test('CA-UX-1/CA-UX-2 · el bloque de remediacion no promete un gate CODEOWNERS inexistente', () => {
    // Esta salida se publica en el GITHUB_STEP_SUMMARY del workflow (`:56`): es
    // lo que lee el operador cuando el lint reporta violaciones.
    const bin = fs.readFileSync(REAL_BIN, 'utf8');
    const idx = bin.indexOf('Si la excepcion es legitima');
    assert.ok(idx > 0, 'el binario debe emitir el bloque de remediacion de la allowlist');
    const bloque = bin.slice(idx, idx + 1200);
    assert.match(bloque, /declarativ/i);
    assert.match(bloque, /no activa/i);
    assert.doesNotMatch(bloque, /needs-human|owner humano|NO auto-mergea/i);
});

test('CA-10/CA-UX-3 · el header fija la politica declarativa sin reglas activas', () => {
    const co = readRealCodeowners();
    const header = co.split('\n').filter(l => /^\s*#/.test(l)).join('\n');
    assert.match(header, /NO declara reglas activas/);
    assert.match(header, /GATE_CODEOWNERS_ESPERADO=false/);
    assert.equal(classifyGuardrailCodeowners(co), 'solo-comentarios');
});

test('CA-4b/R5 · el hook pre-commit invoca --report-only, NUNCA --check', () => {
    const hook = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.husky', 'pre-commit'), 'utf8');
    const linea = hook.split('\n').find(l => l.includes('operational-state-lint.js') && l.includes('node '));
    assert.ok(linea, 'el hook debe invocar el guardrail');
    assert.match(linea, /--report-only/);
    assert.ok(!/--check/.test(linea), 'clonar el --check del template rompe todo commit bajo .pipeline/ (R5)');
    assert.match(linea, /\|\| true/, 'no debe propagar el exit code');
});

test('CA-4a · el bloque del hook esta ANTES del primer `exit 0` (si no, es codigo muerto)', () => {
    // Hallazgo empirico de este issue (verificado con `sh -x`): la validacion de
    // agent-models hace `exit 0` cuando no se stagea `agent-models.json`, y eso
    // corta el hook entero. Todo bloque posterior a ese `exit 0` NUNCA corre en
    // un commit normal — que es exactamente lo que le pasa hoy al secret-scan
    // (#3310) y al ghost-artifact-lint (#3638).
    //
    // Si alguien mueve este bloque hacia abajo "para agrupar los lints", la capa
    // local del doble wiring desaparece en silencio. Este assert lo agarra.
    const lines = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.husky', 'pre-commit'), 'utf8').split('\n');
    const idxLint = lines.findIndex(l => l.includes('operational-state-lint.js') && l.includes('node '));
    const idxExit = lines.findIndex(l => /^\s*exit 0\s*$/.test(l));
    assert.ok(idxLint >= 0, 'el hook debe invocar el guardrail');
    assert.ok(idxExit >= 0, 'el hook tiene al menos un `exit 0`');
    assert.ok(idxLint < idxExit, `el bloque del guardrail (linea ${idxLint + 1}) debe estar antes del primer \`exit 0\` (linea ${idxExit + 1})`);
});

test('CA-4a/CA-4c · el workflow corre en report-only, con permissions read y trigger pull_request', () => {
    const wf = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'operational-state-lint.yml'), 'utf8');
    assert.match(wf, /operational-state-lint\.js --report-only/);
    assert.ok(!/operational-state-lint\.js --check/.test(wf), 'el flip a --check va en la parte 3');
    assert.match(wf, /permissions:/);
    assert.match(wf, /contents:\s*read/);
    assert.match(wf, /^\s*pull_request:/m);
    // Se mide el TRIGGER, no la mencion: el header del workflow explica por que
    // `pull_request_target` esta prohibido, y esa prosa no debe hacer fallar el
    // assert.
    assert.ok(!/^\s*pull_request_target\s*:/m.test(wf), 'pull_request_target corre con el token del repo base sobre codigo de un fork');

    // #5986 · CA-5: sin `.github/CODEOWNERS` en el `paths:`, un PR que toca solo
    // ese archivo no dispara el job — o sea, la asercion de CA-3/CA-4 no corre
    // en el unico PR donde importa (verificado en el PR #5975).
    // CA-6: se mide el `paths:` de AMBOS triggers, sin tocar permissions ni el
    // --report-only (los asserts de arriba los fijan).
    const bloquesPaths = wf.split(/^\s*paths:\s*$/m).slice(1);
    assert.ok(bloquesPaths.length >= 2, 'el workflow debe filtrar por paths en pull_request y en push');
    for (const [i, bloque] of bloquesPaths.entries()) {
        const lista = bloque.split(/\n(?=\s*(?:on|jobs|permissions|push|pull_request)\b)/)[0];
        assert.match(lista, /-\s*'\.github\/CODEOWNERS'/, `el bloque paths #${i + 1} debe incluir .github/CODEOWNERS`);
    }
});

// ─── Rebote rev-1 · la SALIDA no puede ser secuestrada (SEC-3) ───────────────
//
// El hueco de cobertura que dejo pasar las 3 rutas: la suite cubria `::` como
// INPUT de `sanitizeReason`, nunca como PROPIEDAD DE LA SALIDA. Estos asserts
// son sobre lo que se EMITE, no sobre lo que se recibe.

/** Payload que, si sobrevive, se convierte en una anotacion falsa en el PR. */
const SPOOF = '\n::error title=operational-state-lint::Guardrail OK - sin hallazgos\n';

/** Ninguna linea de `texto` puede arrancar con `::` (workflow command). */
function assertSinWorkflowCommands(texto, contexto) {
    const secuestradas = texto.split('\n').filter(l => l.startsWith('::'));
    assert.deepEqual(
        secuestradas, [],
        `${contexto}: ninguna linea emitida puede arrancar con "::" (seria un workflow command de Actions)`,
    );
}

test('rebote rev-1 ruta A · clave desconocida con "\n::error" NO inyecta un workflow command', () => {
    const root = makeTmpPipeline();
    installBin(root);
    // JSON perfectamente VALIDO: no hace falta corromper nada.
    const raw = JSON.stringify({ files: [], rules: [], [`x${SPOOF}`]: 1 });
    JSON.parse(raw);   // el fixture debe ser JSON valido, si no el test prueba otra cosa
    writeAllowlistRaw(root, raw);
    const r = runCli(root, ['--report-only']);
    assert.equal(r.code, 2, 'sigue siendo fail-loud');
    assert.match(r.all, /clave desconocida/);
    assertSinWorkflowCommands(r.all, 'ruta A');
});

test('rebote rev-1 ruta B · fragmento de JSON.parse con salto de linea NO inyecta un workflow command', () => {
    const root = makeTmpPipeline();
    installBin(root);
    writeAllowlistRaw(root, `{ "files": [ ROTO${SPOOF} ] }`);
    const r = runCli(root, ['--report-only']);
    assert.equal(r.code, 2);
    assert.match(r.all, /allowlist\.json: JSON/);
    assertSinWorkflowCommands(r.all, 'ruta B');
});

test('rebote rev-1 ruta C · un `\n::` en el NOMBRE DE ARCHIVO no secuestra la linea de violation', () => {
    // `v.file` viene de `walkJs`, o sea del nombre de archivo del repo, y el job
    // corre en ubuntu-latest donde un `\n` en un nombre de archivo es legal.
    // Se ejercita `formatViolation` porque ese camino NO pasa por defaultLogger.
    for (const prefix of ['AVISO:', 'ERROR:']) {
        const linea = I.formatViolation({ file: `lib/evil${SPOOF}x.js`, line: 1, rule: 'path-level' }, prefix);
        assertSinWorkflowCommands(linea, `ruta C (${prefix})`);
        assert.equal(linea.split('\n').length, 1, 'una violation = una linea');
    }
});

test('rebote rev-1 · el sink de violations aplana cualquier mensaje a UNA linea', () => {
    const emitidas = [];
    const out = I.oneLineSink((l) => emitidas.push(l));
    out(`AVISO: total: 1 violation${SPOOF}`);
    assert.equal(emitidas.length, 1);
    assertSinWorkflowCommands(emitidas.join('\n'), 'oneLineSink');
    // No colapsa espacios: la indentacion del bloque de remediacion se preserva.
    out('  Ojo: "allowlist" tiene dos significados');
    assert.equal(emitidas[1], '  Ojo: "allowlist" tiene dos significados');
});

test('rebote rev-1 · defaultLogger sanitiza los TRES metodos (puerta unica para mensajes futuros)', () => {
    const original = { log: console.log, warn: console.warn, error: console.error };
    const emitidas = [];
    console.log = console.warn = console.error = (l) => emitidas.push(l);
    try {
        const logger = I.defaultLogger();
        logger.info(`OK${SPOOF}`);
        logger.warn(`aviso${SPOOF}`);
        logger.error(`configuracion: clave desconocida "x${SPOOF}"`);
    } finally {
        console.log = original.log; console.warn = original.warn; console.error = original.error;
    }
    assert.equal(emitidas.length, 3, 'una llamada = una linea, en los tres metodos');
    for (const l of emitidas) {
        assert.equal(l.split('\n').length, 1);
        assert.ok(l.startsWith('[operational-state-lint]'), `toda linea arranca con el prefijo: ${JSON.stringify(l)}`);
    }
    assertSinWorkflowCommands(emitidas.join('\n'), 'defaultLogger');
});

test('rebote rev-1 · --report (markdown a GITHUB_STEP_SUMMARY) tampoco emite lineas con "::"', () => {
    const md = I.formatReport({
        scanned: 1, rawLiteralHits: 1, rawLiteralFiles: 1, commentHits: 0, noCtxHits: 0, confirmedHits: 1,
        violations: [{ file: `lib/evil${SPOOF}x.js`, line: 1, rule: 'path-level' }],
    });
    assertSinWorkflowCommands(md, '--report');
});

test('rebote rev-2 · el inventario se declara PISO y no promete equivalencia con `git grep`', () => {
    // El artefacto se pega literal en #5109. Afirmar que el bruto es
    // "comparable con un git grep" era FALSO: el bruto cuenta el literal
    // entrecomillado, no toda mencion del nombre del archivo.
    const md = I.formatReport({
        scanned: 1, rawLiteralHits: 1, rawLiteralFiles: 1, commentHits: 0, noCtxHits: 0, confirmedHits: 1,
        violations: [{ file: 'lib/x.js', line: 1, rule: 'path-level' }],
    });
    assert.ok(!/comparable con un `git grep`/.test(md), 'no debe prometer equivalencia con git grep');
    assert.ok(/PISO auditable, no un censo/.test(md));
    assert.ok(/## Limites conocidos del matcher/.test(md));
    assert.ok(/'waves' \+ '\.json'/.test(md), 'declara la concatenacion partida');
    assert.ok(/WAVES_FILE/.test(md), 'declara la indireccion por constante');
});

test('rebote rev-1 · el eco del fragmento de JSON.parse queda acotado (CA-3b: no volcar contenido)', () => {
    const root = makeTmpPipeline();
    installBin(root);
    writeAllowlistRaw(root, `{ "files": [ ${'CONTENIDO_LARGO_DEL_ARCHIVO'.repeat(40)} ] }`);
    const r = runCli(root, ['--report-only']);
    assert.equal(r.code, 2);
    const linea = r.all.split('\n').find(l => l.includes('JSON inválido')) || '';
    assert.ok(linea.length < 400, `el mensaje no debe volcar el archivo (largo: ${linea.length})`);
});
