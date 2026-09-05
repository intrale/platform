'use strict';

// =============================================================================
// Tests: `lib/test-env-lint` (#6260 CA-12 .. CA-36 + SEC-8).
//
// Estrategia: fixtures sinteticos en tmpdir (`makeTmpPipeline()` + `placeJs()`,
// reusando el precedente de `ghost-artifact-lint.test.js:19-31`), SIN depender
// del estado real del repo. Un test por CA — el gate de `tester` cuenta CA<->test.
//
// R-A9 — ESTE ARCHIVO ESTA EN ALCANCE del propio guardrail y sus fixtures
// contienen justo el texto que las regex buscan. Por eso los fixtures se
// construyen POR CONCATENACION (`const PE = 'process' + '.env';`) y NO se
// agrega este path a `SELF_EXEMPT`: CA-23 pide exactamente DOS paths exentos.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const lint = require('../test-env-lint');
const { ConfigError, buildRegistry, esSentidoInseguro } = lint;
const {
    walkJs, lintFile, loadAllowlist, loadBaseline, applyAllowlist, classify,
    resolveKey, resolveValue, validarFormaPatron, inScope, safeSnippet,
    writeAllowlist, SELF_EXEMPT, NO_CONTROL_BLACKLIST,
} = lint._internal;

// R-A9: nunca escribir el token literal que el guardrail busca.
const PE = 'process' + '.env';
const DEL = 'delete' + ' ';

// --- Helpers ----------------------------------------------------------------

function makeTmpPipeline() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-env-lint-'));
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    return root;
}

function placeJs(root, relPath, source) {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source, 'utf8');
    return full;
}

function writeJson(root, relPath, obj) {
    return placeJs(root, relPath, JSON.stringify(obj, null, 2));
}

/** Registro minimo pero representativo de las dos formas. */
function registroBase(extra = []) {
    return {
        vars: [
            {
                nombre: 'PULPO_NO_AUTOSTART', motivo: 'm', control_que_apaga: 'c',
                sentido_inseguro: 'apagar',
                motivo_precedencia: 'la familia PULPO_NO_* es encender; esta fila es el caso inverso',
            },
            { nombre: 'QUOTA_SNAPSHOT_ENABLED', motivo: 'm', control_que_apaga: 'c', sentido_inseguro: 'apagar' },
            { nombre: 'PULPO_LIVENESS_KILL_SECONDS', motivo: 'm', control_que_apaga: 'c', sentido_inseguro: 'cualquiera' },
            { patron: '^PULPO_SKIP_[A-Z0-9_]+$', motivo: 'm', control_que_apaga: 'c', sentido_inseguro: 'encender' },
            { patron: '^PULPO_NO_[A-Z0-9_]+$', motivo: 'm', control_que_apaga: 'c', sentido_inseguro: 'encender' },
            { patron: '^[A-Z0-9_]*GATE[0-9A-Z_]*_ENABLED$', motivo: 'm', control_que_apaga: 'c', sentido_inseguro: 'apagar' },
            ...extra,
        ],
    };
}

function emptyAllowlist() {
    return { min_scanned: 0, files: [], rules: [] };
}

function emptyBaseline() {
    return { entries: [] };
}

/** Corre `check()` sobre un pipelineRoot sintetico ya poblado. */
function checkTmp(root, opts = {}) {
    return lint.check({
        pipelineRoot: root,
        registry: opts.registry || buildRegistry(registroBase()),
        allowlist: opts.allowlist || emptyAllowlist(),
        baseline: opts.baseline || emptyBaseline(),
    });
}

function violationsDe(root, registry) {
    return lint.lint({ pipelineRoot: root, registry: registry || buildRegistry(registroBase()) }).violations;
}

// --- CA-12 · las CUATRO formas, con file y line exactos ---------------------

test('CA-12 · forma `dot`: detecta la asignacion con punto y reporta file y line exactos', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/__tests__/a.test.js', ['// l1', '// l2', PE + '.FOO_CORRIENTE = "1";', ''].join('\n'));
    const v = violationsDe(root);
    assert.strictEqual(v.length, 1);
    assert.strictEqual(v[0].file, 'lib/__tests__/a.test.js');
    assert.strictEqual(v[0].line, 3);
    assert.strictEqual(v[0].forma, 'dot');
    assert.strictEqual(v[0].variable, 'FOO_CORRIENTE');
});

test('CA-12 · forma `computed`: detecta process.env[expr] y reporta file y line exactos', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/__tests__/b.test.js', ['// l1', PE + '["FOO_CORRIENTE"] = "1";', ''].join('\n'));
    const v = violationsDe(root);
    assert.strictEqual(v.length, 1);
    assert.strictEqual(v[0].forma, 'computed');
    assert.strictEqual(v[0].line, 2);
    assert.strictEqual(v[0].variable, 'FOO_CORRIENTE');
});

test('CA-12 · forma `delete`: detecta delete process.env.X y reporta file y line exactos', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/__tests__/c.test.js', ['// l1', '// l2', '// l3', DEL + PE + '.FOO_CORRIENTE;', ''].join('\n'));
    const v = violationsDe(root);
    assert.strictEqual(v.length, 1);
    assert.strictEqual(v[0].forma, 'delete');
    assert.strictEqual(v[0].line, 4);
});

test('CA-12 · forma `whole`: asignacion al objeto entero y Object.assign son estrictas', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/__tests__/d.test.js', [
        PE + ' = { A: "1" };',
        'Object' + '.assign(' + PE + ', { B: "1" });',
        '',
    ].join('\n'));
    const v = violationsDe(root);
    assert.strictEqual(v.length, 2, 'las dos variantes de `whole`');
    assert.ok(v.every((x) => x.forma === 'whole'));
    assert.ok(v.every((x) => x.severity === 'estricta'), 'estrictas SIN excepcion posible');
    assert.deepStrictEqual(v.map((x) => x.line), [1, 2]);
});

// --- CA-13 / R-A2 · alcance ------------------------------------------------

test('CA-13 / R-A2 · lo que vive bajo `_tmp/` o un dir scratch NO se reporta', () => {
    const root = makeTmpPipeline();
    placeJs(root, '_tmp/viejo/x.test.js', PE + '.FOO = "1";\n');
    placeJs(root, 'tmp-review-1/y.test.js', PE + '.FOO = "1";\n');
    placeJs(root, 'lib/__tests__/ok.test.js', '// nada\n');
    const { scanned, violations } = lint.lint({ pipelineRoot: root, registry: buildRegistry(registroBase()) });
    assert.strictEqual(violations.length, 0);
    assert.strictEqual(scanned, 1, 'solo el archivo legitimo entra al alcance');
});

test('CA-13 · el alcance es por INCLUSION: `*.test.js` y `test-*.js`, nada mas', () => {
    assert.strictEqual(inScope('foo.test.js'), true);
    assert.strictEqual(inScope('test-foo.js'), true);
    assert.strictEqual(inScope('foo.js'), false);
    assert.strictEqual(inScope('foo.test.ts'), false);
    const root = makeTmpPipeline();
    placeJs(root, 'lib/produccion.js', PE + '.FOO = "1";\n');
    placeJs(root, 'lib/test-algo.js', '// nada\n');
    const files = walkJs(root).map((f) => path.basename(f));
    assert.deepStrictEqual(files, ['test-algo.js'], 'el codigo de produccion no esta en alcance');
});

// --- CA-14 / SEC-2 / SEC-6 · no se allowlistea una estricta -----------------

test('CA-14 / SEC-6 · allowlistear una estricta hace que la ENTRY sea violation, nombrando la variable', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/__tests__/e.test.js', PE + '.PULPO_NO_AUTOSTART = "0";\n');
    const allowlist = { min_scanned: 0, files: [], rules: [{ file: 'lib/__tests__/e.test.js', line: 1, kind: 'deuda', reason: 'x' }] };
    const res = checkTmp(root, { allowlist });
    assert.strictEqual(res.code, 2);
    const texto = res.lines.join('\n');
    assert.match(texto, /cubren violations ESTRICTAS/);
    assert.match(texto, /PULPO_NO_AUTOSTART/, 'el error nombra la VARIABLE, no solo el archivo');
});

test('CA-14 · una entry de `files` tampoco puede tapar una estricta, y el archivo se escanea IGUAL', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/__tests__/f.test.js', PE + '.PULPO_NO_AUTOSTART = "0";\n');
    const allowlist = { min_scanned: 0, files: [{ file: 'lib/__tests__/f.test.js', kind: 'deuda', reason: 'x' }], rules: [] };
    const res = checkTmp(root, { allowlist });
    assert.strictEqual(res.code, 2);
    assert.match(res.lines.join('\n'), /files\[lib\/__tests__\/f\.test\.js\]/);
});

// --- CA-15 / CA-15' · fail-closed sobre el alcance --------------------------

test("CA-15 / SEC-3 · scanned === 0 es ERROR con el mensaje literal, nunca verde", () => {
    const root = makeTmpPipeline();
    const res = checkTmp(root);
    assert.notStrictEqual(res.code, 0);
    assert.ok(res.lines.includes('glob no matcheo ningun archivo'), 'mensaje LITERAL');
});

test("CA-15' · piso de escaneo: forzar el alcance del SKIP_DIRS ajeno falla POR PISO, no verde", () => {
    const root = makeTmpPipeline();
    // Un unico archivo limpio: sin violations el lint daria verde... si no
    // hubiera piso. Con `min_scanned` alto, falla informando esperado y encontrado.
    placeJs(root, 'lib/__tests__/g.test.js', '// limpio\n');
    const allowlist = { min_scanned: 800, files: [], rules: [] };
    const res = checkTmp(root, { allowlist });
    assert.strictEqual(res.code, 1);
    const texto = res.lines.join('\n');
    assert.match(texto, /piso de escaneo incumplido/);
    assert.match(texto, /esperado >= 800/);
    assert.match(texto, /encontrado 1/);
});

// --- CA-16 / SEC-4 · analisis estatico puro y containment -------------------

test('CA-16 / SEC-4 · grep estatico: cero require() dinamico, eval, vm o import() en el guardrail', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'test-env-lint.js'), 'utf8');
    // `require(` solo con literal string, y ninguno de los otros tres.
    const requires = src.match(/require\(([^)]*)\)/g) || [];
    for (const r of requires) {
        assert.match(r, /require\('[^']+'\)/, `require dinamico detectado: ${r}`);
    }
    assert.doesNotMatch(src, /\beval\s*\(/, 'eval prohibido');
    assert.doesNotMatch(src, /require\('vm'\)|require\("vm"\)/, 'vm prohibido');
    assert.doesNotMatch(src, /[^.\w]import\s*\(/, 'import() dinamico prohibido');
});

test('CA-16 · un archivo fuera del pipelineRoot (path con `..`) se rechaza por containment', () => {
    const root = makeTmpPipeline();
    const afuera = path.join(root, '..', 'afuera-' + path.basename(root) + '.test.js');
    fs.writeFileSync(afuera, PE + '.FOO = "1";\n', 'utf8');
    try {
        const v = lintFile(afuera, root, buildRegistry(registroBase()));
        assert.deepStrictEqual(v, [], 'un path que sale del root no produce violations');
    } finally {
        fs.rmSync(afuera, { force: true });
    }
});

// --- CA-21 / CA-22 · higiene de la allowlist --------------------------------

test('CA-21 / R-5 · una entry obsoleta es ella misma una violation', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/__tests__/h.test.js', '// limpio\n');
    const allowlist = {
        min_scanned: 0,
        files: [{ file: 'lib/__tests__/borrado.test.js', kind: 'deuda', reason: 'x' }],
        rules: [{ file: 'lib/__tests__/h.test.js', line: 99, kind: 'deuda', reason: 'x' }],
    };
    const res = checkTmp(root, { allowlist });
    assert.strictEqual(res.code, 1);
    const texto = res.lines.join('\n');
    assert.match(texto, /OBSOLETA/);
    assert.match(texto, /files\[lib\/__tests__\/borrado\.test\.js\]/);
    assert.match(texto, /rules\[lib\/__tests__\/h\.test\.js:99\]/);
});

test('CA-22 · `kind` es obligatorio y sin default; la linea verde imprime los DOS conteos', () => {
    const root = makeTmpPipeline();
    writeJson(root, 'lib/test-env-lint.allowlist.json', { min_scanned: 0, files: [], rules: [{ file: 'x', line: 1, reason: 'sin kind' }] });
    assert.throws(() => loadAllowlist(root), (e) => e instanceof ConfigError && /`kind` es obligatorio/.test(e.message));
    // Y con `kind` valido, la linea verde muestra los dos conteos.
    placeJs(root, 'lib/__tests__/i.test.js', [PE + '.FOO_A = "1";', PE + '.FOO_B = "1";', ''].join('\n'));
    const allowlist = {
        min_scanned: 0,
        files: [],
        rules: [
            { file: 'lib/__tests__/i.test.js', line: 1, kind: 'deuda', reason: 'x' },
            { file: 'lib/__tests__/i.test.js', line: 2, kind: 'falso-positivo', reason: 'x' },
        ],
    };
    const res = checkTmp(root, { allowlist });
    assert.strictEqual(res.code, 0, res.lines.join('\n'));
    assert.match(res.lines[0], /allowlist: 1 deuda \/ 1 falso-positivo/);
});

test('CA-22 · una allowlist ausente o malformada es exit 2, NUNCA allowlist vacia silenciosa', () => {
    const root = makeTmpPipeline();
    assert.throws(() => loadAllowlist(root), (e) => e instanceof ConfigError && /no se pudo leer/.test(e.message));
    placeJs(root, 'lib/test-env-lint.allowlist.json', '{ no soy json');
    assert.throws(() => loadAllowlist(root), (e) => e instanceof ConfigError && /JSON invalido/.test(e.message));
    // Idem baseline.
    assert.throws(() => loadBaseline(root), (e) => e instanceof ConfigError);
});

// --- CA-23 · auto-exencion de exactamente dos paths -------------------------

test('CA-23 · exactamente DOS paths auto-exentos; un tercer archivo de test-helpers SI se audita', () => {
    assert.strictEqual(SELF_EXEMPT.size, 2);
    assert.ok(SELF_EXEMPT.has('lib/test-helpers/with-env.js'));
    assert.ok(SELF_EXEMPT.has('lib/__tests__/with-env.test.js'));
    const root = makeTmpPipeline();
    placeJs(root, 'lib/test-helpers/with-env.js', PE + '.PULPO_NO_AUTOSTART = "0";\n');
    placeJs(root, 'lib/__tests__/with-env.test.js', PE + '.PULPO_NO_AUTOSTART = "0";\n');
    placeJs(root, 'lib/test-helpers/test-otro.js', PE + '.FOO_CORRIENTE = "1";\n');
    const v = violationsDe(root);
    assert.strictEqual(v.length, 1, 'solo el tercer archivo produce violation');
    assert.strictEqual(v[0].file, 'lib/test-helpers/test-otro.js');
});

// --- CA-24 · --write-allowlist no es el bypass ------------------------------

test('CA-24 · --write-allowlist con una estricta presente ABORTA con exit 2 y no escribe', () => {
    const root = makeTmpPipeline();
    writeJson(root, 'lib/test-env-lint.protected.json', registroBase());
    writeJson(root, 'lib/test-env-lint.allowlist.json', { min_scanned: 0, files: [], rules: [] });
    placeJs(root, 'lib/__tests__/j.test.js', PE + '.PULPO_NO_AUTOSTART = "0";\n');
    const antes = fs.readFileSync(path.join(root, 'lib', 'test-env-lint.allowlist.json'), 'utf8');
    const logged = [];
    const logger = { info: (m) => logged.push(m), warn: (m) => logged.push(m), error: (m) => logged.push(m) };
    const code = writeAllowlist(root, logger, { skipGitCheck: true });
    assert.strictEqual(code, 2);
    assert.match(logged.join('\n'), /ABORTA/);
    assert.strictEqual(
        fs.readFileSync(path.join(root, 'lib', 'test-env-lint.allowlist.json'), 'utf8'), antes,
        'la allowlist NO se escribio',
    );
});

// --- CA-27 · validador del registro (una fixture por sub-criterio) ----------

test('CA-27.1 · `sentido_inseguro` ausente o fuera del enum es exit 2, nombrando la entrada', () => {
    assert.throws(
        () => buildRegistry({ vars: [{ nombre: 'FOO_BAR_BAZ', motivo: 'm' }] }),
        (e) => e instanceof ConfigError && /FOO_BAR_BAZ/.test(e.message) && /sentido_inseguro/.test(e.message),
    );
    assert.throws(
        () => buildRegistry({ vars: [{ nombre: 'FOO_BAR_BAZ', sentido_inseguro: 'quizas' }] }),
        (e) => e instanceof ConfigError && /FOO_BAR_BAZ/.test(e.message),
    );
});

test('CA-27.2 · `sentido_inseguro` es obligatorio TAMBIEN en las entradas `patron`', () => {
    assert.throws(
        () => buildRegistry({ vars: [{ patron: '^FOO_[A-Z]+$' }] }),
        (e) => e instanceof ConfigError && /\^FOO_\[A-Z\]\+\$/.test(e.message) && /sentido_inseguro/.test(e.message),
    );
});

test('CA-27.2 · dos patrones solapados con direcciones distintas resuelven a `cualquiera`, nunca al mas laxo', () => {
    const r = buildRegistry({
        vars: [
            { patron: '^FOOX_[A-Z0-9_]+$', sentido_inseguro: 'encender' },
            { patron: '^[A-Z0-9_]*FOOX_ALGO$', sentido_inseguro: 'apagar' },
        ],
    });
    assert.strictEqual(r.direction('FOOX_ALGO'), 'cualquiera', 'fail-closed ante el conflicto');
    assert.strictEqual(r.direction('FOOX_OTRA'), 'encender', 'sin conflicto, la unica familia manda');
});

test('CA-27.3 · forma del patron: anclado, sin comodines libres, literal >= 4, anti-ReDoS', () => {
    const casos = [
        ['.*', /ANCLADO/],                                  // fixture canonica
        ['^.*$', /comodines libres/],
        ['^[A-Z0-9_]*\\w+$', /comodines libres/],
        ['^FOO[A-Z]*$', /prefijo o sufijo literal/],        // literal de 3
        ['^(A+)+FOOBAR$', /ReDoS/],
        ['PULPO_SKIP_[A-Z]+$', /ANCLADO/],                  // sin ^
        ['^PULPO_SKIP_[A-Z]+', /ANCLADO/],                  // sin $
    ];
    for (const [patron, re] of casos) {
        assert.throws(
            () => validarFormaPatron(patron, 'fixture'),
            (e) => e instanceof ConfigError && re.test(e.message),
            `el patron ${patron} debia ser rechazado por ${re}`,
        );
    }
    // Los 3 patrones reales del contrato pasan.
    for (const ok of ['^PULPO_SKIP_[A-Z0-9_]+$', '^PULPO_NO_[A-Z0-9_]+$', '^[A-Z0-9_]*GATE[0-9A-Z_]*_ENABLED$']) {
        assert.ok(validarFormaPatron(ok, 'fixture') instanceof RegExp);
    }
});

test('CA-27.4 · test de NO-CAPTURA: ningun patron puede matchear la lista negra fija', () => {
    assert.deepStrictEqual(
        [...NO_CONTROL_BLACKLIST],
        ['PIPELINE_DIR_OVERRIDE', 'PATH', 'HOME', 'NODE_ENV', 'TMPDIR', 'TEMP'],
    );
    assert.throws(
        () => validarFormaPatron('^[A-Z0-9_]*PATH$', 'fixture'),
        (e) => e instanceof ConfigError && /lista negra/.test(e.message) && /PATH/.test(e.message),
    );
    // Y el registro real no captura ninguna.
    const real = lint.getRegistry();
    for (const negra of NO_CONTROL_BLACKLIST) {
        assert.strictEqual(real.direction(negra), null, `${negra} no puede ser variable de control`);
    }
});

test('CA-27.5 · `motivo_precedencia` obligatorio cuando la fila nominal difiere de su familia', () => {
    const sinMotivo = {
        vars: [
            { nombre: 'PULPO_NO_AUTOSTART', sentido_inseguro: 'apagar' },
            { patron: '^PULPO_NO_[A-Z0-9_]+$', sentido_inseguro: 'encender' },
        ],
    };
    assert.throws(
        () => buildRegistry(sinMotivo),
        (e) => e instanceof ConfigError && /PULPO_NO_AUTOSTART/.test(e.message) && /motivo_precedencia/.test(e.message),
    );
    // Vacio tampoco alcanza.
    const vacio = JSON.parse(JSON.stringify(sinMotivo));
    vacio.vars[0].motivo_precedencia = '   ';
    assert.throws(() => buildRegistry(vacio), (e) => e instanceof ConfigError);
    // Con motivo, pasa — y la precedencia nominal decide la direccion.
    const conMotivo = JSON.parse(JSON.stringify(sinMotivo));
    conMotivo.vars[0].motivo_precedencia = 'es el caso inverso: "1" es la posicion inerte';
    const r = buildRegistry(conMotivo);
    assert.strictEqual(r.direction('PULPO_NO_AUTOSTART'), 'apagar');
    assert.strictEqual(r.direction('PULPO_NO_OTRA_COSA'), 'encender', 'la familia sigue intacta');
});

test('CA-27 · una fila nominal que COINCIDE con su familia no necesita motivo_precedencia', () => {
    assert.doesNotThrow(() => buildRegistry({
        vars: [
            { nombre: 'PULPO_SKIP_SECRETS_HALT', sentido_inseguro: 'encender' },
            { patron: '^PULPO_SKIP_[A-Z0-9_]+$', sentido_inseguro: 'encender' },
        ],
    }));
});

test('CA-27 · la cobertura es la UNION: la forma nominal no resta cobertura a la familia', () => {
    const r = buildRegistry(registroBase());
    // Cubierta solo por familia.
    assert.strictEqual(r.direction('PIPELINE_GATE0_ENABLED'), 'apagar');
    // Cubierta solo por nombre.
    assert.strictEqual(r.direction('QUOTA_SNAPSHOT_ENABLED'), 'apagar');
    // Ninguna de las dos.
    assert.strictEqual(r.direction('PIPELINE_DIR_OVERRIDE'), null);
});

// --- CA-28 .. CA-31 · clasificacion por direccion ---------------------------

test('CA-28 · classify marca estricta SOLO en la direccion insegura', () => {
    const r = buildRegistry(registroBase());
    const deuda = classify({ kind: 'dot', keyExpr: 'PULPO_NO_AUTOSTART', valueExpr: "'1'" }, r);
    assert.strictEqual(deuda.severity, 'deuda', "PULPO_NO_AUTOSTART='1' es el sentido SEGURO");
    const estricta = classify({ kind: 'dot', keyExpr: 'PULPO_NO_AUTOSTART', valueExpr: "'0'" }, r);
    assert.strictEqual(estricta.severity, 'estricta');
    assert.strictEqual(estricta.sentido, 'apagar');
});

test('CA-29 · valor no resoluble estaticamente sobre variable protegida es estricta', () => {
    const r = buildRegistry(registroBase());
    for (const valueExpr of ['v', 'previo', 'cond ? "1" : "0"', 'f()', '`${x}`', "'1' + x"]) {
        const c = classify({ kind: 'dot', keyExpr: 'PULPO_SKIP_SECRETS_HALT', valueExpr }, r);
        assert.strictEqual(c.severity, 'estricta', `valor \`${valueExpr}\` debia ser estricta`);
        assert.match(c.reason, /valor no resoluble/);
    }
    // Y el literal resoluble en sentido seguro sigue siendo deuda.
    assert.strictEqual(
        classify({ kind: 'dot', keyExpr: 'PULPO_SKIP_SECRETS_HALT', valueExpr: "'0'" }, r).severity,
        'deuda',
    );
});

test('CA-29 · clave no resoluble estaticamente es estricta (fail-closed, no re-litigable)', () => {
    const r = buildRegistry(registroBase());
    const c = classify({ kind: 'computed', keyExpr: 'k', valueExpr: "'1'" }, r);
    assert.strictEqual(c.severity, 'estricta');
    assert.match(c.reason, /clave no resoluble/);
    // Con clave literal si se resuelve.
    assert.strictEqual(resolveKey("'FOO'", 'computed'), 'FOO');
    assert.strictEqual(resolveKey('k', 'computed'), null);
    assert.strictEqual(resolveKey('`${k}`', 'computed'), null);
});

test('CA-30 · delete de una protegida: estricta si su sentido es `apagar`, deuda si es `encender`', () => {
    const r = buildRegistry(registroBase());
    const apagar = classify({ kind: 'delete-dot', keyExpr: 'QUOTA_SNAPSHOT_ENABLED' }, r);
    assert.strictEqual(apagar.severity, 'estricta', 'borrar == ausencia == apagar');
    const encender = classify({ kind: 'delete-dot', keyExpr: 'PULPO_SKIP_SECRETS_HALT' }, r);
    assert.strictEqual(encender.severity, 'deuda', 'borrar una `encender` la deja en su posicion segura');
});

test('CA-31 · `cualquiera`: TODA escritura es estricta, en ambas direcciones', () => {
    const r = buildRegistry(registroBase());
    for (const valueExpr of ["'1'", "'0'", "''", 'undefined', 'null', "'99999'", '0']) {
        const c = classify({ kind: 'dot', keyExpr: 'PULPO_LIVENESS_KILL_SECONDS', valueExpr }, r);
        assert.strictEqual(c.severity, 'estricta', `valor ${valueExpr} debia ser estricta`);
    }
    assert.strictEqual(classify({ kind: 'delete-dot', keyExpr: 'PULPO_LIVENESS_KILL_SECONDS' }, r).severity, 'estricta');
});

test('esSentidoInseguro · vocabulario del consumidor real, no truthiness', () => {
    // `apagar`: todo lo que no sea exactamente '1', la ausencia incluida.
    for (const v of [undefined, null, '', '0', 'false', 'true', 'off', '2', 'FALSE']) {
        assert.strictEqual(esSentidoInseguro(v, 'apagar'), true, `${JSON.stringify(v)} apaga el gate`);
    }
    assert.strictEqual(esSentidoInseguro('1', 'apagar'), false);
    assert.strictEqual(esSentidoInseguro(' 1 ', 'apagar'), false, 'con trim');
    // `encender`: fuera de {undefined,null,'','0','false','off','no'} (ci+trim).
    for (const v of [undefined, null, '', '0', 'false', 'FALSE', 'off', 'no', ' 0 ']) {
        assert.strictEqual(esSentidoInseguro(v, 'encender'), false, `${JSON.stringify(v)} no enciende`);
    }
    for (const v of ['1', 'on', 'si', 'true', '2']) {
        assert.strictEqual(esSentidoInseguro(v, 'encender'), true, `${JSON.stringify(v)} enciende`);
    }
    // `cualquiera`: siempre.
    for (const v of [undefined, '0', '1', 'x']) assert.strictEqual(esSentidoInseguro(v, 'cualquiera'), true);
});

test('resolveValue · reconoce literales y rechaza todo lo demas', () => {
    assert.deepStrictEqual(resolveValue("'0';"), { resoluble: true, value: '0' });
    assert.deepStrictEqual(resolveValue('"1"'), { resoluble: true, value: '1' });
    assert.deepStrictEqual(resolveValue('`1`'), { resoluble: true, value: '1' });
    assert.deepStrictEqual(resolveValue('0'), { resoluble: true, value: '0' });
    assert.deepStrictEqual(resolveValue('undefined'), { resoluble: true, value: undefined });
    assert.deepStrictEqual(resolveValue('null'), { resoluble: true, value: null });
    assert.strictEqual(resolveValue('`${x}`').resoluble, false);
    assert.strictEqual(resolveValue('prev').resoluble, false);
    assert.strictEqual(resolveValue('').resoluble, false);
});

// --- CA-36 · baseline por entrada, no un contador ---------------------------

test('CA-36 · mover una estricta de archivo SIN cambiar el total es exit 1', () => {
    const registry = buildRegistry(registroBase());
    const baseline = {
        entries: [{ file: 'lib/__tests__/viejo.test.js', line: 1, variable: 'PULPO_NO_AUTOSTART', sentido: 'apagar' }],
    };
    // Mismo total (1 estricta), otro archivo: el contador no lo veria.
    const root = makeTmpPipeline();
    placeJs(root, 'lib/__tests__/nuevo.test.js', PE + '.PULPO_NO_AUTOSTART = "0";\n');
    const res = checkTmp(root, { registry, baseline });
    assert.strictEqual(res.code, 1);
    assert.match(res.lines.join('\n'), /el baseline CRECIO/);
    // Y en su archivo original SI queda congelada (verde, con la deuda visible).
    const root2 = makeTmpPipeline();
    placeJs(root2, 'lib/__tests__/viejo.test.js', PE + '.PULPO_NO_AUTOSTART = "0";\n');
    const res2 = checkTmp(root2, { registry, baseline });
    assert.strictEqual(res2.code, 0, res2.lines.join('\n'));
    assert.match(res2.lines.join('\n'), /DEUDA CONGELADA \(baseline\): 1 estrictas/);
});

test('CA-36 · el baseline NO suprime: la deuda congelada se reporta en linea propia siempre', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/__tests__/k.test.js', PE + '.PULPO_NO_AUTOSTART = "0";\n');
    const baseline = { entries: [{ file: 'lib/__tests__/k.test.js', line: 1, variable: 'PULPO_NO_AUTOSTART', sentido: 'apagar' }] };
    const res = checkTmp(root, { baseline });
    assert.strictEqual(res.code, 0);
    assert.ok(res.lines.some((l) => /^DEUDA CONGELADA \(baseline\)/.test(l)), 'linea propia, en voz alta');
});

test('CA-36 · una estricta que se resolvio hace que el baseline ENCOJA, y eso se informa (no es error)', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/__tests__/l.test.js', '// ya no toca el entorno\n');
    const baseline = { entries: [{ file: 'lib/__tests__/l.test.js', line: 1, variable: 'PULPO_NO_AUTOSTART', sentido: 'apagar' }] };
    const res = checkTmp(root, { baseline });
    assert.strictEqual(res.code, 0);
    assert.match(res.lines.join('\n'), /El baseline ENCOGIO/);
});

// --- SEC-8 · el snippet nunca lleva el valor -------------------------------

test('SEC-8 · el snippet reportado se corta en el `=` y NO contiene el lado derecho', () => {
    const root = makeTmpPipeline();
    const CENTINELA = 'zx9-valor-que-no-debe-salir-7f3a';
    placeJs(root, 'lib/__tests__/m.test.js', PE + '.FOO_CORRIENTE = "' + CENTINELA + '";\n');
    const v = violationsDe(root);
    assert.strictEqual(v.length, 1);
    assert.doesNotMatch(v[0].snippet, new RegExp(CENTINELA), 'el snippet no puede llevar el valor');
    assert.match(v[0].snippet, /FOO_CORRIENTE/, 'pero si el lado izquierdo');
    assert.doesNotMatch(lint._internal.formatViolation(v[0]), new RegExp(CENTINELA));
    assert.strictEqual(safeSnippet('process.env.X = "secreto"'), 'process.env.X');
});

// --- Orden invertido de lintFile (SEC-6, desvio no negociable) --------------

test('SEC-6 · el archivo se lee y escanea SIEMPRE: la allowlist filtra DESPUES, violation por violation', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/__tests__/n.test.js', [
        PE + '.FOO_CORRIENTE = "1";',
        PE + '.PULPO_NO_AUTOSTART = "0";',
        '',
    ].join('\n'));
    // Aunque el archivo entero este allowlisteado, lintFile devuelve TODO.
    const v = lintFile(path.join(root, 'lib/__tests__/n.test.js'), root, buildRegistry(registroBase()));
    assert.strictEqual(v.length, 2, 'lintFile no conoce la allowlist');
    const r = applyAllowlist(v, { min_scanned: 0, files: [{ file: 'lib/__tests__/n.test.js', kind: 'deuda', reason: 'x' }], rules: [] }, emptyBaseline());
    assert.strictEqual(r.conteoKind.deuda, 1, 'solo la deuda se suprime');
    assert.strictEqual(r.entriesQueCubrenEstrictas.length, 1, 'la estricta hace violation a la entry');
});

// -----------------------------------------------------------------------------
// CA-40.4 · BARRIDO FINAL — parte de la entrega, no solo de la definicion.
//
// Simula el registro hibrido contra TODAS las llamadas literales a `withEnv` de
// `.pipeline` (excluyendo `_tmp/`) y exige CERO sitios que tiren sin estar
// autorizados. Va versionado como TEST y no como scratch: es criterio.
//
// Autorizaciones (secciones 10 y 11 del issue):
//   * `lib/__tests__/with-env.test.js` — la suite del propio helper: ahi los
//     throws SON el objeto de prueba (`assert.throws`).
//   * cualquier llamada que declare el opt-in `permitirApagarControl` nombrando
//     la variable en cuestion (gate-verdict.test.js, quota-state-block-4327).
// -----------------------------------------------------------------------------

const BARRIDO_EXENTOS = new Set(['lib/__tests__/with-env.test.js']);
const WITHENV_RE = /withEnv\(\s*\{([^}]*)\}/g;
const PAR_RE = /(?:\[\s*)?(?:'([^']+)'|"([^"]+)"|`([^`$]+)`|([A-Za-z_$][\w$]*))\s*\]?\s*:\s*([^,\n}]+)/g;

function barrerWithEnv(rootAbs, registry) {
    const rojos = [];
    function recurse(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            if (e.isSymbolicLink()) continue;
            if (e.isDirectory()) {
                if (e.name === 'node_modules' || /^(_tmp|tmp[-.]|\.)/.test(e.name)) continue;
                recurse(path.join(dir, e.name));
            } else if (e.isFile() && e.name.endsWith('.js')) {
                const rel = path.relative(rootAbs, path.join(dir, e.name)).split(path.sep).join('/');
                if (BARRIDO_EXENTOS.has(rel)) continue;
                let src;
                try { src = fs.readFileSync(path.join(dir, e.name), 'utf8'); }
                catch { continue; }
                WITHENV_RE.lastIndex = 0;
                let m;
                while ((m = WITHENV_RE.exec(src)) !== null) {
                    // Ventana de la llamada completa, para ver el opt-in del 3er argumento.
                    const ventana = src.slice(m.index, m.index + 900);
                    PAR_RE.lastIndex = 0;
                    let p;
                    while ((p = PAR_RE.exec(m[1])) !== null) {
                        const nombre = p[1] || p[2] || p[3] || p[4];
                        const sentido = registry.direction(nombre);
                        if (sentido === null) continue;
                        const rv = resolveValue(p[5]);
                        // Sin valor resoluble no se puede afirmar que tire: no es rojo del barrido.
                        if (!rv.resoluble) continue;
                        if (!esSentidoInseguro(rv.value, sentido)) continue;
                        // El opt-in vale solo si NOMBRA la variable: un
                        // `permitirApagarControl` de otra variable en la misma
                        // ventana no autoriza esta.
                        const iOptIn = ventana.indexOf('permitirApagarControl');
                        const conOptIn = iOptIn !== -1
                            && ventana.slice(iOptIn, iOptIn + 300).includes(nombre);
                        if (conOptIn) continue;
                        rojos.push({
                            file: rel,
                            line: src.slice(0, m.index).split('\n').length,
                            variable: nombre,
                            sentido,
                        });
                    }
                }
            }
        }
    }
    recurse(rootAbs);
    return rojos;
}

test('CA-40.4 · barrido final: cero sitios de `withEnv` que tiren sin autorizacion', () => {
    const rootAbs = path.resolve(__dirname, '..', '..');
    const rojos = barrerWithEnv(rootAbs, lint.getRegistry());
    assert.deepStrictEqual(
        rojos, [],
        'sitios que tirarian bajo el registro hibrido sin opt-in ni autorizacion:\n'
        + rojos.map((r) => `  ${r.file}:${r.line} ${r.variable} [${r.sentido}]`).join('\n'),
    );
});

test('CA-40.4 · fixture del propio barrido: un uso nuevo NO autorizado lo hace fallar', () => {
    const root = makeTmpPipeline();
    // Sin opt-in: rojo.
    placeJs(root, 'lib/__tests__/nuevo-uso.test.js',
        "withEnv({ PIPELINE_GATE0_ENABLED: '0' }, () => {});\n");
    const rojos = barrerWithEnv(root, lint.getRegistry());
    assert.strictEqual(rojos.length, 1, 'el barrido debe ver el uso nuevo');
    assert.strictEqual(rojos[0].variable, 'PIPELINE_GATE0_ENABLED');
    assert.strictEqual(rojos[0].sentido, 'apagar');

    // Con opt-in nombrando la variable: verde.
    const root2 = makeTmpPipeline();
    placeJs(root2, 'lib/__tests__/uso-autorizado.test.js',
        "withEnv({ PIPELINE_GATE0_ENABLED: '0' }, () => {}, {\n"
        + "    permitirApagarControl: ['PIPELINE_GATE0_ENABLED'],\n"
        + "    motivo: 'ejercita la rama fail-closed',\n"
        + '});\n');
    assert.deepStrictEqual(barrerWithEnv(root2, lint.getRegistry()), []);

    // Y el sentido SEGURO nunca es rojo.
    const root3 = makeTmpPipeline();
    placeJs(root3, 'lib/__tests__/seguro.test.js',
        "withEnv({ PULPO_NO_AUTOSTART: '1' }, () => {});\n");
    assert.deepStrictEqual(barrerWithEnv(root3, lint.getRegistry()), []);
});

// -----------------------------------------------------------------------------
// SEC-5.2 · chequeo anti-podredumbre del registro
// -----------------------------------------------------------------------------

test('SEC-5.2 · una flag de produccion con forma de control sin cubrir se REPORTA, nombrandola', () => {
    const { detectarPodredumbre, FORMA_DE_CONTROL_RE } = lint._internal;
    // La forma reconoce las familias que el issue enumera.
    for (const n of ['PULPO_ALGO', 'FOO_ENABLED', 'FOO_DISABLED', 'FOO_BYPASS_X', 'FOO_KILL_SWITCH', 'X_GATE_Y']) {
        assert.ok(FORMA_DE_CONTROL_RE.test(n), `${n} tiene forma de control`);
    }
    assert.strictEqual(FORMA_DE_CONTROL_RE.test('PIPELINE_DIR_OVERRIDE'), false);

    const root = makeTmpPipeline();
    // Archivo de PRODUCCION (no `.test.js`, no `test-*.js`) que lee una flag
    // con forma de control que el registro no cubre.
    placeJs(root, 'lib/produccion.js', 'const v = ' + PE + '.PIPELINE_INVENTADA_ENABLED;\n');
    const podridas = detectarPodredumbre(root, buildRegistry(registroBase()));
    assert.deepStrictEqual(podridas, ['PIPELINE_INVENTADA_ENABLED']);

    // Una flag que el registro SI cubre (por familia) no se reporta.
    const root2 = makeTmpPipeline();
    placeJs(root2, 'lib/produccion.js', 'const v = ' + PE + '.PIPELINE_GATE0_ENABLED;\n');
    assert.deepStrictEqual(detectarPodredumbre(root2, buildRegistry(registroBase())), []);
});

test('SEC-5.2 · el arbol de entrega no tiene flags de control sin clasificar', () => {
    const { detectarPodredumbre } = lint._internal;
    const rootAbs = path.resolve(__dirname, '..', '..');
    assert.deepStrictEqual(
        detectarPodredumbre(rootAbs, lint.getRegistry()), [],
        'toda flag de produccion con forma de control esta cubierta por el registro',
    );
});

// --- rev-1 · el guardrail no se evade por casing ni por asignacion compuesta -

test('rev-1 · una escritura en MINUSCULAS a una variable de control es ESTRICTA, no invisible', () => {
    // En Windows `process.env` es case-insensitive: la clave en minuscula apaga
    // EXACTAMENTE el mismo control que la mayuscula. Con la clase de nombre
    // restringida a `[A-Z0-9_]` el lint no la veia NI COMO DEUDA, asi que el dev
    // frenado por `withEnv` (que si la bloquea, CA-38) la evadia a mano.
    const root = makeTmpPipeline();
    placeJs(root, 'lib/__tests__/minus.test.js', PE + '.pipeline_gate0_enabled = "0";\n');
    const v = violationsDe(root);
    assert.strictEqual(v.length, 1, 'la escritura en minusculas se detecta');
    assert.strictEqual(v[0].severity, 'estricta', 'apagar un control es estricta, sin importar el casing');
    assert.strictEqual(v[0].variable, 'pipeline_gate0_enabled');
    assert.strictEqual(v[0].forma, 'dot');
});

test('rev-1 · el casing MIXTO tampoco evade, y el nombre NO se reporta truncado', () => {
    // Con `[A-Z0-9_]+` un nombre `Xxxx` no solo escapaba a la deteccion: en la
    // forma `delete` el grupo capturaba la PRIMERA letra suelta y la identidad
    // de la variable llegaba truncada a allowlist y baseline.
    const root = makeTmpPipeline();
    placeJs(root, 'lib/__tests__/mixto.test.js', [
        PE + '.Pipeline_Gate0_Enabled = "0";',
        DEL + PE + '.ProgramFiles;',
        '',
    ].join('\n'));
    const v = violationsDe(root);
    assert.strictEqual(v.length, 2);
    assert.strictEqual(v[0].variable, 'Pipeline_Gate0_Enabled');
    assert.strictEqual(v[0].severity, 'estricta');
    assert.strictEqual(v[1].variable, 'ProgramFiles', 'el nombre completo, no la `P` suelta');
    assert.strictEqual(v[1].forma, 'delete');
});

test('rev-2 · las asignaciones compuestas ||= ??= += tambien escriben y se detectan', () => {
    // `X ||= "1"` ENCIENDE el escape hatch cuando la variable esta ausente, que
    // es el caso normal en CI. El lookahead `=(?!=)` las dejaba fuera a las tres.
    const root = makeTmpPipeline();
    placeJs(root, 'lib/__tests__/comp.test.js', [
        PE + '.PULPO_SKIP_SECRETS_HALT ||= "1";',
        PE + '.PULPO_SKIP_SECRETS_HALT ??= "1";',
        PE + '.PIPELINE_GATE0_ENABLED += "0";',
        PE + '["PULPO_SKIP_SECRETS_HALT"] ||= "1";',
        '',
    ].join('\n'));
    const v = violationsDe(root);
    assert.strictEqual(v.length, 4, 'las tres formas compuestas, en `dot` y en `computed`');
    for (const each of v) {
        assert.strictEqual(each.severity, 'estricta', each.variable + ' escrita en su sentido inseguro');
    }
    assert.deepStrictEqual(v.map((x) => x.forma), ['dot', 'dot', 'dot', 'computed']);
});

test('rev-2 · las COMPARACIONES siguen sin ser falsos positivos', () => {
    // La alternancia no puede aflojar el lookahead: leer no es escribir, y un
    // guardrail que reporta lecturas se vuelve ruido y el equipo lo apaga.
    const root = makeTmpPipeline();
    placeJs(root, 'lib/__tests__/lee.test.js', [
        'if (' + PE + '.PIPELINE_GATE0_ENABLED === "1") {}',
        'if (' + PE + '.PIPELINE_GATE0_ENABLED == "1") {}',
        'if (' + PE + '.PIPELINE_GATE0_ENABLED !== "1") {}',
        'const a = ' + PE + '.PIPELINE_GATE0_ENABLED + "=b";',
        'const b = ' + PE + '.PIPELINE_GATE0_ENABLED ?? "x";',
        'const c = ' + PE + '.PIPELINE_GATE0_ENABLED || "x";',
        '',
    ].join('\n'));
    assert.deepStrictEqual(violationsDe(root), []);
});

test('rev-2 / SEC-8 · el snippet de una compuesta corta ANTES del valor, sin dejar el operador', () => {
    assert.strictEqual(safeSnippet(PE + '.PULPO_SKIP_SECRETS_HALT ||= "sk-secreto"'), PE + '.PULPO_SKIP_SECRETS_HALT');
    assert.strictEqual(safeSnippet(PE + '.FOO ??= "sk-secreto"'), PE + '.FOO');
    assert.strictEqual(safeSnippet(PE + '.FOO += "sk-secreto"'), PE + '.FOO');
    assert.strictEqual(safeSnippet(PE + '.FOO = "sk-secreto"'), PE + '.FOO');
});

test('rev-1 · el helper y el lint coinciden: lo que withEnv bloquea, el lint lo ve', () => {
    // El hallazgo era EXACTAMENTE esta divergencia: `withEnv` bloqueaba la clave
    // en minuscula (derivacion nominal con flag `i`) y el lint no la reportaba,
    // asi que la salida de escape era escribirla a mano.
    const registry = lint.getRegistry();
    for (const nombre of ['pulpo_skip_secrets_halt', 'Pipeline_Gate0_Enabled', 'PIPELINE_GATE0_ENABLED']) {
        assert.ok(registry.isControl(nombre), nombre + ' es variable de control para el registro');
        const root = makeTmpPipeline();
        placeJs(root, 'lib/__tests__/par.test.js', PE + '.' + nombre + ' = "0";\n');
        const v = lint.lint({ pipelineRoot: root, registry }).violations;
        assert.strictEqual(v.length, 1, nombre + ' es visible para el lint');
    }
});
