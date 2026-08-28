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
    for (const rel of [
        'lib/operational-state.js', 'lib/waves.js', 'lib/partial-pause.js', 'lib/operational-state-lint.js',
        // #5110 — sustrato del namespaceo por projectId.
        'lib/project-context.js', 'scripts/migrate-operational-state-namespace.js',
    ]) {
        placeJs(root, rel, body);
    }
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 0);
    // El set se pinea a propósito: agrandar el scope del control es una decisión
    // que tiene que pasar por este test (y por CODEOWNERS), no colarse en un
    // refactor. #5110 suma dos entradas y ninguna es un consumidor:
    //   - `lib/project-context.js` RESUELVE el namespace `.pipeline/projects/<id>/`.
    //   - el migrador MUEVE el layout plano a ese namespace.
    // Ambos manipulan los literales de estado por definición, igual que
    // `waves.js`. Auditarlos sería tautológico.
    assert.deepEqual([...I.SELF_EXEMPT].sort(), [
        'lib/operational-state-lint.js',
        'lib/operational-state.js',
        'lib/partial-pause.js',
        'lib/project-context.js',
        'lib/waves.js',
        'scripts/migrate-operational-state-namespace.js',
    ]);
});

// ─── Allowlist (CA-5 / CA-5b / CA-5c / SEC-3 / SEC-4) ───────────────────────

/**
 * Arma una entry de `rules` con el ancla ya normalizada (#6106).
 *
 * Los tests NO escriben anclas a mano por la misma razon que el dev usa
 * `--anchor`: un ancla tipeada a ojo se desincroniza del fixture en silencio y
 * el test pasa a probar otra cosa (el camino de "excepcion obsoleta").
 */
function rule(file, source, needle, extra = {}) {
    const line = lineOf(source, needle);
    const anchor = I.normalizeAnchor(source.split('\n')[line - 1]);
    return { file, anchor, anchorNormalized: anchor, line, where: `test rules[0]`, index: 0, reason: 'razon real de test', ...extra };
}

test('CA-5/#6106 · regla puntual {file,anchor,reason} skipea esa violation', () => {
    const root = makeTmpPipeline();
    const src = "const path=require('path');\nconst w = path.join(D, 'waves.json');";
    placeJs(root, 'lib/bad.js', src);
    const base = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(base.violations.length, 1);
    const ruled = { files: new Set(), rules: [rule('lib/bad.js', src, "path.join(D, 'waves.json')")] };
    const r = lint.lint({ pipelineRoot: root, allowlist: ruled });
    assert.equal(r.violations.length, 0);
    assert.deepEqual(r.anchorIssues, [], 'un ancla que resuelve no genera diagnostico');
    assert.equal(r.anchorResolutions[0].status, I.ANCHOR_OK);
    assert.equal(r.anchorResolutions[0].covered, true, 'la entry suprime una violation real');
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
    writeAllowlistRaw(root, JSON.stringify({
        files: [],
        rules: [{ file: 'lib/bad.js', anchor: "const w = path.join(D, 'waves.json');", line: 2, reason: 'TODO' }],
    }));
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
        ['{"rules": [{"anchor": "const x = 1;", "reason": "ok real"}]}', /rules\[0\].*"file"/s],
        // #6106 — el shape viejo (sin `anchor`) se rechaza de una, no se acepta
        // en transicion: aceptarlo mantendria vivo el falso negativo.
        ['{"rules": [{"file": "lib/a.js", "line": 3, "reason": "ok real"}]}', /rules\[0\].*"anchor" es obligatorio/s],
        ['{"rules": [{"file": "lib/a.js", "anchor": "   ", "reason": "ok real"}]}', /rules\[0\].*"anchor" es obligatorio/s],
        ['{"rules": [{"file": "lib/a.js", "anchor": "a\\nb", "reason": "ok real"}]}', /rules\[0\].*UNA sola línea/s],
        ['{"rules": [{"file": "lib/a.js", "anchor": "const x = 1;", "line": 0, "reason": "ok real"}]}', /rules\[0\].*"line".*entero >= 1/s],
        ['{"rules": [{"file": "lib/a.js", "anchor": "const x = 1;", "occurrence": 0, "reason": "ok real"}]}', /rules\[0\].*"occurrence".*entero >= 1/s],
        ['{"rules": [{"file": "lib/a.js", "anchor": "const x = 1;"}]}', /rules\[0\].*reason/s],
        // Una clave desconocida DENTRO de la entry tambien sale por exit 2: un
        // `ancla`/`linea` mal tipeado se comeria la excepcion en silencio.
        ['{"rules": [{"file": "lib/a.js", "ancla": "const x = 1;", "reason": "ok real"}]}', /rules\[0\].*clave desconocida "ancla"/s],
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

test('CA-10 · la allowlist REAL del repo carga sin errores, sin exenciones de archivo entero y sin entries stale', () => {
    const pipelineRoot = path.join(__dirname, '..', '..');
    const al = I.loadAllowlist(pipelineRoot);

    // `files` sigue teniendo que estar vacio: una exencion de ARCHIVO ENTERO es
    // demasiado amplia para el invariante del contrato §2 (CA-10 / CA-5).
    assert.equal(al.files.size, 0, 'files debe estar vacio (CA-10)');

    // `rules` ya NO tiene que estar vacio. #5176 (parte 2 de 3) declaro la
    // primera exclusion justificada: `desync-detector` conserva su lectura
    // tolerante de `waves.json` porque ningun lector del envoltorio distingue
    // "sin ola activa" (null) de "ola vacia" ([]) sin romper el detector (A-2).
    //
    // Lo que se fija acá es MAS fuerte que "cero entries": cada entry tiene que
    // estar VIVA. Una entry que ya no corresponde a ninguna violation (call
    // site migrado, o codigo cambiado) es una exencion que nadie revisa y que el
    // guardrail aplicaria en silencio — justo el modo de falla que #5175 evito
    // con el fail-loud de `loadAllowlist`.
    //
    // #6106 — la liveness se mide contra la RESOLUCION DEL ANCLA, no contra el
    // numero de linea. Medirla contra `r.line` reintroduciria exactamente el
    // acoplamiento posicional que este issue elimina: el test rompería en cada
    // drift del archivo y obligaría a mantener la coordenada a mano.
    const res = lint.lint({ pipelineRoot });
    assert.deepEqual(
        res.anchorIssues.map((it) => `${it.entry.where}: ${it.status}`),
        [],
        'ninguna entry de la allowlist real puede quedar obsoleta, ambigua ni con ordinal fuera de rango',
    );
    assert.equal(res.anchorResolutions.length, al.rules.length, 'toda entry se resuelve contra un archivo escaneado');
    for (const r of res.anchorResolutions) {
        assert.equal(r.status, I.ANCHOR_OK, `${r.entry.where} (${r.entry.file}) debe resolver`);
        assert.ok(Number.isInteger(r.line) && r.line >= 1);
        assert.ok(
            r.covered,
            `${r.entry.where} (${r.entry.file}:${r.line}) no esta suprimiendo ninguna violation — la entry sobra, borrala`,
        );
    }

    // `line` sigue siendo INDICATIVA: si esta, tiene que ser un entero valido,
    // pero NO se exige que coincida con la linea resuelta. Que se desincronice
    // es el comportamiento deseado — es lo que deja de romper el build.
    for (const r of al.rules) {
        if (r.line === undefined) continue;
        assert.ok(Number.isInteger(r.line) && r.line >= 1, `${r.where}: "line" indicativa mal formada`);
    }
});

test('CA-5b · allowlist AUSENTE si es allowlist vacia (la ausencia no es ambigua, la corrupcion si)', () => {
    const root = makeTmpPipeline();
    const al = I.loadAllowlist(root);
    assert.equal(al.files.size, 0);
    assert.equal(al.rules.length, 0);
});

// ─── Anclaje por contenido (#6106 · CA-1 a CA-8) ────────────────────────────
//
// El matcher era posicional (`r.file === rel && r.line === line`) y fallaba de
// dos formas: falso positivo (insertar lineas arriba corria la coordenada y
// rompia el build de un cambio inocente) y falso negativo (la coordenada pasaba
// a apuntar a OTRO acceso, que quedaba exento sin review). Estos tests fijan las
// dos correcciones y los tres diagnosticos nuevos.

const ACCESO = "    const w = path.join(D, 'waves.json');";

/** Fixture con `n` lineas de relleno arriba del acceso. */
function fixtureConDrift(n) {
    return [
        "const path = require('path');",
        ...Array.from({ length: n }, (_, i) => `// relleno ${i + 1}`),
        'function f(D) {',
        ACCESO,
        '}',
    ].join('\n');
}

test('CA-1 · insertar lineas arriba del acceso excusado NO cambia el veredicto (drift)', () => {
    const src0 = fixtureConDrift(0);
    const entry = rule('lib/drift.js', src0, "path.join(D, 'waves.json')");
    const allowlist = { files: new Set(), rules: [entry] };
    assert.equal(entry.line, 3, 'el fixture base ancla en la linea 3');

    // La MISMA entry, sin tocar el JSON, contra el archivo corrido 40 lineas.
    for (const n of [0, 1, 7, 40]) {
        const root = makeTmpPipeline();
        placeJs(root, 'lib/drift.js', fixtureConDrift(n));
        const r = lint.lint({ pipelineRoot: root, allowlist });
        assert.equal(r.violations.length, 0, `con ${n} lineas de drift la exencion tiene que seguir aplicando`);
        assert.deepEqual(r.anchorIssues, [], `drift de ${n} lineas no es un diagnostico`);
        assert.equal(r.anchorResolutions[0].line, 3 + n, 'la linea resuelta sigue al acceso');
    }
    // Y la `line` indicativa quedo desactualizada a proposito: no participa.
    assert.equal(entry.line, 3);
});

test('CA-2 · la exencion NO se transfiere al acceso que cae en la coordenada vieja', () => {
    const src0 = fixtureConDrift(0);
    const entry = rule('lib/drift.js', src0, "path.join(D, 'waves.json')");

    const root = makeTmpPipeline();
    // El acceso autorizado se movio a la 5 y en la 3 hay un acceso DISTINTO.
    placeJs(root, 'lib/drift.js', [
        "const path = require('path');",
        'function f(D) {',
        "    const otro = path.join(D, '.paused');",   // linea 3 — NUNCA autorizado
        '',
        ACCESO,                                        // linea 5 — el autorizado
        '}',
    ].join('\n'));

    const { violations, anchorResolutions } = lint.lint({ pipelineRoot: root, allowlist: { files: new Set(), rules: [entry] } });
    assert.deepEqual(
        violations.map(v => `${v.file}:${v.line}`),
        ['lib/drift.js:3'],
        'el acceso nuevo en la coordenada vieja se reporta; el autorizado sigue exento',
    );
    assert.equal(anchorResolutions[0].line, 5);
});

test('CA-3 · ancla ambigua ⇒ NADIE queda exento, y el mensaje dice cuantas y cuales', () => {
    const src = [
        "const path = require('path');",
        ACCESO,
        'function g(D) {',
        ACCESO,
        '}',
    ].join('\n');
    const root = makeTmpPipeline();
    placeJs(root, 'lib/dup.js', src);
    const entry = rule('lib/dup.js', src, "path.join(D, 'waves.json')");

    const r = lint.lint({ pipelineRoot: root, allowlist: { files: new Set(), rules: [entry] } });
    assert.equal(r.anchorIssues.length, 1);
    assert.equal(r.anchorIssues[0].status, I.ANCHOR_AMBIGUOUS);
    assert.deepEqual(r.anchorIssues[0].matches, [2, 4]);
    // Lo critico: ninguno de los dos hereda la exencion.
    assert.deepEqual(r.violations.map(v => v.line), [2, 4], 'ambiguedad NO exenta de mas');

    const msg = I.formatAnchorIssue(r.anchorIssues[0]);
    assert.match(msg, /ancla ambigua/);
    assert.match(msg, /matchea 2 lineas/, 'UX-4: decir el numero, no solo "ambigua"');
    assert.match(msg, /\(2, 4\)/, 'UX-4: decir cuales');
    assert.match(msg, /occurrence/, 'la salida tiene que ser accionable');
    assert.equal(msg.split('\n').length, 1, 'UX-4: una linea por hallazgo');
});

test('CA-3 · la desambiguacion es EXPLICITA: `occurrence` elige uno y solo uno', () => {
    const src = [
        "const path = require('path');",
        ACCESO,
        'function g(D) {',
        ACCESO,
        '}',
    ].join('\n');
    const root = makeTmpPipeline();
    placeJs(root, 'lib/dup.js', src);
    const base = rule('lib/dup.js', src, "path.join(D, 'waves.json')");

    for (const [occurrence, exenta, reportada] of [[1, 2, 4], [2, 4, 2]]) {
        const r = lint.lint({ pipelineRoot: root, allowlist: { files: new Set(), rules: [{ ...base, occurrence }] } });
        assert.deepEqual(r.anchorIssues, [], `occurrence=${occurrence} resuelve`);
        assert.equal(r.anchorResolutions[0].line, exenta);
        assert.deepEqual(r.violations.map(v => v.line), [reportada], `occurrence=${occurrence} exenta SOLO una`);
    }

    // Ordinal fuera de rango: error de configuracion, no exencion silenciosa.
    const fuera = lint.lint({ pipelineRoot: root, allowlist: { files: new Set(), rules: [{ ...base, occurrence: 3 }] } });
    assert.equal(fuera.anchorIssues[0].status, I.ANCHOR_ORDINAL);
    assert.deepEqual(fuera.violations.map(v => v.line), [2, 4], 'ordinal invalido no exenta nada');
    assert.match(I.formatAnchorIssue(fuera.anchorIssues[0]), /fuera de rango/);
});

test('CA-4 · la normalizacion del ancla es estable entre CRLF (Windows) y LF (CI Linux)', () => {
    const linea = "    const w = path.join(D, 'waves.json');";
    assert.equal(I.normalizeAnchor(`${linea}\r\n`), I.normalizeAnchor(`${linea}\n`));
    assert.equal(I.normalizeAnchor(`${linea}\r`), I.normalizeAnchor(linea));
    // `src.split('\n')` deja el `\r` colgando: esa es la forma exacta en que
    // llega la linea en un checkout Windows con core.autocrlf=true.
    const crlf = `const a=1;\r\n${linea}\r\n`;
    const lf = `const a=1;\n${linea}\n`;
    assert.equal(
        I.normalizeAnchor(crlf.split('\n')[1]),
        I.normalizeAnchor(lf.split('\n')[1]),
        'sin esto el guardrail pasa local y rompe en Actions (o al reves)',
    );
    // Whitespace horizontal: reindentar no cambia el acceso.
    assert.equal(I.normalizeAnchor('\tconst  w =\tpath.join(D);'), I.normalizeAnchor('const w = path.join(D);'));
    // Lo que SI cambia el acceso no se normaliza.
    assert.notEqual(I.normalizeAnchor("path.join(D,'a')"), I.normalizeAnchor('path.join(D,"a")'));
});

test('CA-4 · el mismo fixture en CRLF y en LF da el mismo veredicto con la misma entry', () => {
    const src = fixtureConDrift(2);
    const entry = rule('lib/eol.js', src, "path.join(D, 'waves.json')");
    const veredictos = ['\n', '\r\n'].map((eol) => {
        const root = makeTmpPipeline();
        placeJs(root, 'lib/eol.js', src.split('\n').join(eol));
        const r = lint.lint({ pipelineRoot: root, allowlist: { files: new Set(), rules: [entry] } });
        return { violations: r.violations.length, issues: r.anchorIssues.length, status: r.anchorResolutions[0].status };
    });
    assert.deepEqual(veredictos[0], veredictos[1], 'CRLF y LF tienen que dar identico');
    assert.deepEqual(veredictos[0], { violations: 0, issues: 0, status: I.ANCHOR_OK });
});

test('CA-5 · ancla obsoleta se reporta (nunca queda muda) y distingue las dos causas', () => {
    const src = fixtureConDrift(0);
    const entry = rule('lib/drift.js', src, "path.join(D, 'waves.json')");

    // (a) el acceso CAMBIO — hay que re-anclar Y volver a CODEOWNERS.
    const root = makeTmpPipeline();
    placeJs(root, 'lib/drift.js', src.replace(ACCESO, '    const w = ops.getActiveWave();'));
    const r = lint.lint({ pipelineRoot: root, allowlist: { files: new Set(), rules: [entry] } });
    assert.equal(r.anchorIssues.length, 1);
    assert.equal(r.anchorIssues[0].status, I.ANCHOR_STALE);
    const msg = I.formatAnchorIssue(r.anchorIssues[0]);
    assert.match(msg, /excepcion obsoleta/);
    assert.match(msg, /SE BORRO/, 'UX-4: la causa "el codigo se borro" (borrar la entry)');
    assert.match(msg, /CAMBIO/, 'UX-4: la causa "el codigo cambio" (re-anclar + re-aprobar)');
    assert.match(msg, /--anchor=/, 'accionable');
    assert.equal(msg.split('\n').length, 1);

    // (b) el ARCHIVO desaparecio del scan — la entry sobra.
    const vacio = makeTmpPipeline();
    const r2 = lint.lint({ pipelineRoot: vacio, allowlist: { files: new Set(), rules: [entry] } });
    assert.equal(r2.anchorIssues.length, 1);
    assert.equal(r2.anchorIssues[0].status, I.ANCHOR_UNSCANNED);
    assert.match(I.formatAnchorIssue(r2.anchorIssues[0]), /no se escaneo/);
});

test('CA-5 · una entry redundante con `files[]` o con SELF_EXEMPT tampoco queda muda', () => {
    const src = fixtureConDrift(0);
    const root = makeTmpPipeline();
    placeJs(root, 'lib/drift.js', src);
    placeJs(root, 'lib/waves.js', src);

    const porFiles = lint.lint({
        pipelineRoot: root,
        allowlist: { files: new Set(['lib/drift.js']), rules: [rule('lib/drift.js', src, "path.join(D, 'waves.json')")] },
    });
    assert.equal(porFiles.anchorIssues[0].status, I.ANCHOR_UNSCANNED);
    assert.match(I.formatAnchorIssue(porFiles.anchorIssues[0]), /files\[\]/);

    const porSelf = lint.lint({
        pipelineRoot: root,
        allowlist: { files: new Set(), rules: [rule('lib/waves.js', src, "path.join(D, 'waves.json')")] },
    });
    assert.equal(porSelf.anchorIssues[0].status, I.ANCHOR_UNSCANNED);
    assert.match(I.formatAnchorIssue(porSelf.anchorIssues[0]), /SELF_EXEMPT/);
});

test('#6106 · una entry resuelta que no suprime nada se reporta pero NO rompe el build', () => {
    // El acceso quedo comentado: el ancla sigue matcheando (mismo texto tras
    // normalizar? no — el `//` lo cambia), asi que se ancla a un no-acceso.
    const src = [
        "const path = require('path');",
        "const SOLO_DOMINIO = 'waves.json';",      // literal sin contexto de path
        'const x = 1;',
    ].join('\n');
    const root = makeTmpPipeline();
    placeJs(root, 'lib/tibio.js', src);
    const entry = rule('lib/tibio.js', src, "const SOLO_DOMINIO");

    const r = lint.lint({ pipelineRoot: root, allowlist: { files: new Set(), rules: [entry] } });
    assert.deepEqual(r.anchorIssues, [], 'no es un diagnostico bloqueante');
    assert.equal(r.anchorResolutions[0].status, I.ANCHOR_OK);
    assert.equal(r.anchorResolutions[0].covered, false, 'la entry no protege nada — habilita #5167');
});

test('CA-3/CA-5 · CLI: --check ⇒ exit 2 (config), --report-only ⇒ AVISO + exit 0, --report ⇒ exit 0', () => {
    const root = makeTmpPipeline();
    installBin(root);
    placeJs(root, 'lib/bad.js', "const path=require('path');\nconst w = path.join(D, 'waves.json');");
    // Ancla que no matchea nada ⇒ excepcion obsoleta.
    writeAllowlistRaw(root, JSON.stringify({
        files: [],
        rules: [{ file: 'lib/bad.js', anchor: 'const YA_NO_EXISTE = 1;', line: 2, reason: 'razon real de test' }],
    }));

    const check = runCli(root, ['--check']);
    assert.equal(check.code, 2, 'ancla sin resolver es error de CONFIGURACION (2), no violation (1)');
    assert.match(check.all, /^ERROR: .*excepcion obsoleta/m);
    assert.match(check.all, /Remediacion - excepciones de la allowlist/);

    const only = runCli(root, ['--report-only']);
    assert.equal(only.code, 0, 'report-only NUNCA falla');
    assert.match(only.all, /^AVISO: .*excepcion obsoleta/m);

    const rep = runCli(root, ['--report']);
    assert.equal(rep.code, 0, '--report es la salida de diagnostico: su contrato es exit 0 SIEMPRE');
    assert.match(rep.stdout, /## Estado de las excepciones de la allowlist/);
    assert.match(rep.stdout, /\| `rules\[0\]` \| `lib\/bad\.js` \| obsoleta \|/);
});

test('UX-5 · --only no bloquea a quien no toco el archivo de la entry rota', () => {
    const root = makeTmpPipeline();
    installBin(root);
    placeJs(root, 'lib/bad.js', "const path=require('path');\nconst w = path.join(D, 'waves.json');");
    placeJs(root, 'lib/otro.js', 'const x = 1;');
    writeAllowlistRaw(root, JSON.stringify({
        files: [],
        rules: [{ file: 'lib/bad.js', anchor: 'const YA_NO_EXISTE = 1;', reason: 'razon real de test' }],
    }));
    // El dev stagea `lib/otro.js`, que no tiene nada que ver.
    const ajeno = runCli(root, ['--check', '--only=.pipeline/lib/otro.js']);
    assert.equal(ajeno.code, 0, 'una entry rota en un archivo ajeno no puede frenar el commit');
    // CI corre SIN --only: ahi la foto completa no se pierde.
    assert.equal(runCli(root, ['--check']).code, 2);
    // Y si el dev SI stagea el archivo de la entry, bloquea.
    assert.equal(runCli(root, ['--check', '--only=.pipeline/lib/bad.js']).code, 2);
});

test('UX-2 · --anchor emite la entry lista para pegar, valida y con reason que NO sale por exit 2', () => {
    const root = makeTmpPipeline();
    installBin(root);
    const src = fixtureConDrift(3);
    placeJs(root, 'lib/gen.js', src);
    const linea = lineOf(src, "path.join(D, 'waves.json')");

    const r = runCli(root, [`--anchor=lib/gen.js:${linea}`]);
    assert.equal(r.code, 0);
    const json = r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1);
    const entry = JSON.parse(json);
    assert.deepEqual(Object.keys(entry), ['file', 'anchor', 'line', 'reason'], 'el reviewer lee QUE se autoriza antes que DONDE');
    assert.equal(entry.file, 'lib/gen.js');
    assert.equal(entry.anchor, I.normalizeAnchor(ACCESO));
    assert.equal(entry.line, linea);

    // La reason placeholder tiene que sobrevivir a `sanitizeReason` (UX-2): si
    // el copy-paste de la remediacion sale por exit 2, el dev deja de usarla.
    assert.doesNotThrow(() => I.sanitizeReason(entry.reason, 'test'));

    // Y pegada tal cual en la allowlist, exenta el acceso.
    writeAllowlistRaw(root, JSON.stringify({ files: [], rules: [entry] }));
    const check = runCli(root, ['--check']);
    assert.equal(check.code, 0, 'la entry generada tiene que funcionar sin edicion manual');
});

test('UX-2 · --anchor calcula el `occurrence` cuando el ancla es ambigua', () => {
    const root = makeTmpPipeline();
    installBin(root);
    placeJs(root, 'lib/dup.js', ["const path = require('path');", ACCESO, 'function g(D) {', ACCESO, '}'].join('\n'));
    const r = runCli(root, ['--anchor=lib/dup.js:4']);
    assert.equal(r.code, 0);
    const entry = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1));
    assert.equal(entry.occurrence, 2, 'el ordinal se emite ya calculado: a mano el dev lo cuenta mal');
    assert.match(r.all, /matchea 2 lineas/, 'y se avisa que el ancla no es unica');

    writeAllowlistRaw(root, JSON.stringify({ files: [], rules: [entry] }));
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: I.loadAllowlist(root) });
    assert.deepEqual(violations.map(v => v.line), [2], 'exenta la 4, reporta la 2');
});

test('UX-2 · --anchor: usos invalidos ⇒ exit 2, y no combina con otros modos', () => {
    const root = makeTmpPipeline();
    installBin(root);
    placeJs(root, 'lib/gen.js', 'const x = 1;\n\nconst y = 2;');
    for (const [args, re] of [
        [['--anchor=sin-linea'], /uso: node/],
        [['--anchor=lib/no-existe.js:1'], /no se pudo leer/],
        [['--anchor=lib/gen.js:999'], /tiene 3 lineas/],
        [['--anchor=lib/gen.js:2'], /esta vacia o es solo whitespace/],
        [['--check', '--anchor=lib/gen.js:1'], /mutuamente excluyentes/],
        [['--anchor=lib/gen.js:1', '--only=lib/gen.js'], /--only no aplica a --anchor/],
    ]) {
        const r = runCli(root, args);
        assert.equal(r.code, 2, `args=${JSON.stringify(args)} debe salir 2`);
        assert.match(r.all, re);
    }
});

test('SEC-2 · el anclaje no filtra codigo por los caminos que corren en CI ni en el hook', () => {
    // Desvio 1 intacto: `--check` / `--report-only` / `--report` NO imprimen la
    // linea de codigo. `--anchor` si, y por eso es un modo aparte, local y bajo
    // demanda — no lo invoca ni el workflow ni el hook.
    const root = makeTmpPipeline();
    installBin(root);
    const secreto = "const w = path.join(D, 'waves.json'); // MARCA_UNICA_DEL_FIXTURE";
    placeJs(root, 'lib/bad.js', `const path=require('path');\n${secreto}`);
    writeAllowlistRaw(root, JSON.stringify({
        files: [],
        rules: [{ file: 'lib/bad.js', anchor: 'const YA_NO_EXISTE = 1;', reason: 'razon real de test' }],
    }));
    for (const mode of ['--check', '--report-only', '--report']) {
        const r = runCli(root, [mode]);
        assert.ok(!r.all.includes('MARCA_UNICA_DEL_FIXTURE'), `${mode} no puede volcar codigo del repo`);
    }
    const wf = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'operational-state-lint.yml'), 'utf8');
    const hook = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.husky', 'pre-commit'), 'utf8');
    assert.ok(!/--anchor/.test(wf), 'el workflow no invoca --anchor');
    assert.ok(!/--anchor/.test(hook), 'el hook no invoca --anchor');
});

test('UX-1 · ningun mensaje ni doc sigue instruyendo el shape viejo { file, line, reason }', () => {
    // Un mensaje de error que ensena un shape que el propio guardrail rechaza
    // con exit 2 es peor que no tener mensaje. Se mide sobre lo que el dev VE.
    const remediacion = I.remediationLines(new Set(['path-level', 'internal-bypass'])).join('\n');
    assert.ok(!/\{ file, line, reason \}/.test(remediacion), 'la remediacion no puede pedir el shape viejo');
    assert.match(remediacion, /\{ file, anchor, reason \}/);
    assert.match(remediacion, /--anchor=/, 'UX-2: el ancla tiene que ser copiable, no calculable a mano');

    const bin = fs.readFileSync(REAL_BIN, 'utf8');
    const alRaw = fs.readFileSync(path.join(__dirname, '..', ALLOWLIST_NAME), 'utf8');
    // Se permite mencionarlo como shape VIEJO (el mensaje de rechazo lo cita);
    // lo que no se permite es instruirlo como shape esperado.
    for (const [txt, nombre] of [[bin, 'el binario'], [alRaw, 'la allowlist']]) {
        for (const linea of txt.split('\n')) {
            if (!linea.includes('{ file, line, reason }') && !linea.includes('{file, line, reason}')) continue;
            assert.match(
                linea,
                /viejo|NO es|ya NO se acepta|Antes era/,
                `${nombre}: "{ file, line, reason }" solo puede aparecer marcado como shape viejo — ${linea.trim().slice(0, 120)}`,
            );
        }
    }
    // El _shape_doc documenta el comportamiento ante stale (CA-5) y el destino
    // del shape viejo (CA-6).
    const doc = JSON.parse(alRaw)._shape_doc;
    assert.match(doc.estado_de_las_anclas, /exit 2/);
    assert.match(doc.estado_de_las_anclas, /OBSOLETA/);
    assert.match(doc.shape_viejo, /RECHAZA con exit 2/);
    assert.match(doc.occurrence, /EXPLICITA/);
    assert.match(doc.line, /INDICATIVA/);
});

test('CA-6 · las 2 entries reales del repo estan migradas al shape nuevo', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', ALLOWLIST_NAME), 'utf8'));
    assert.ok(raw.rules.length > 0, 'el test pierde sentido con la allowlist vacia');
    for (const [i, e] of raw.rules.entries()) {
        assert.equal(typeof e.anchor, 'string', `rules[${i}] tiene que tener "anchor"`);
        assert.ok(e.anchor.trim().length > 0);
        // UX-3 — el reviewer tiene que poder responder "que acceso autorizo"
        // leyendo SOLO el JSON: el ancla va en claro, no hasheada.
        assert.ok(!/^[a-f0-9]{32,}$/i.test(e.anchor.trim()), 'el ancla no puede ser un hash opaco');
        assert.ok(!/^sha\d*[:-]/i.test(e.anchor.trim()), 'el ancla no puede ser un hash opaco');
    }
    // El estado real ya lo verifica el test CA-10 contra el codebase vivo.
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
    // #5179 — tras el flip, el pie del modo report-only ya no anuncia un flip
    // pendiente: aclara que el wiring real SÍ bloquea, para que nadie lo use
    // como vía de escape.
    assert.match(r.all, /corre en `--check` desde #5179/);
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

test('smoke · el binario real y su allowlist estan en CODEOWNERS (CA-5 / SEC-1)', () => {
    const co = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'CODEOWNERS'), 'utf8');
    for (const p of [
        '/.pipeline/lib/operational-state-lint.js',
        '/.pipeline/lib/operational-state-lint.allowlist.json',
        '/.pipeline/lib/__tests__/operational-state-lint.test.js',
    ]) {
        assert.ok(co.includes(p), `CODEOWNERS debe cubrir ${p}`);
    }
    assert.match(co, /@leitolarreta/);
});

test('CA-9b/#5179 · el hook pre-commit invoca --check y PROPAGA el exit code', () => {
    // Invertido respecto de #5175 a proposito: aquel test fijaba `--report-only`
    // porque el repo tenia violations y un hook bloqueante habria entrenado a
    // todo el mundo a usar `--no-verify` (R5). Con el inventario en cero el hook
    // solo bloquea a quien AGREGA un acceso directo nuevo, que es el objetivo.
    const hook = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.husky', 'pre-commit'), 'utf8');
    const linea = hook.split('\n').find(l => l.includes('operational-state-lint.js') && l.includes('node '));
    assert.ok(linea, 'el hook debe invocar el guardrail');
    assert.match(linea, /--check/);
    assert.ok(!/--report-only/.test(linea), 'volver a report-only apaga la capa local del doble wiring');
    assert.ok(!/\|\|\s*true/.test(linea), 'con `|| true` el hook no bloquea nada: seria wiring decorativo');
    assert.match(linea, /\|\|\s*exit 1/, 'debe propagar el fallo');
    // El filtro `--only` sigue siendo obligatorio: con el hook bloqueante, sin
    // el filtro un dev quedaria frenado por una violation que no introdujo.
    assert.match(linea, /--only=/);
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

test('CA-4a/CA-4c/CA-9b · el workflow corre en enforce, con permissions read y trigger pull_request', () => {
    const wf = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'operational-state-lint.yml'), 'utf8');
    assert.match(wf, /operational-state-lint\.js --check/);
    assert.ok(
        !/run:\s*node lib\/operational-state-lint\.js --report-only/.test(wf),
        'el paso de enforce no puede volver a --report-only (la mencion en los comentarios si esta permitida)',
    );
    // El inventario debe publicarse aunque el check falle: es justo el run donde
    // hace falta para diagnosticar.
    assert.match(wf, /if: always\(\)/);
    assert.match(wf, /permissions:/);
    assert.match(wf, /contents:\s*read/);
    assert.match(wf, /^\s*pull_request:/m);
    // Se mide el TRIGGER, no la mencion: el header del workflow explica por que
    // `pull_request_target` esta prohibido, y esa prosa no debe hacer fallar el
    // assert.
    assert.ok(!/^\s*pull_request_target\s*:/m.test(wf), 'pull_request_target corre con el token del repo base sobre codigo de un fork');
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
