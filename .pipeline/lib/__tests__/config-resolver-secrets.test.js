// =============================================================================
// config-resolver-secrets.test.js — #5172 · CA-14 / SEC-1 (bloqueante)
// =============================================================================
//
// Cubre **los dos caminos de fallo**, no uno:
//
//   (a) violación de schema (ajv) → mensaje sin el valor crudo.
//   (b) parse-error de YAML con un valor con forma de secreto en la línea
//       ADYACENTE → el error expone `{archivo, causa, linea, columna}` y
//       NINGUNA línea del archivo.
//
// El (b) es el que importa: `e.message` de `js-yaml` incluye un snippet del
// archivo. Antes de #5172 sólo `pulpo.js` reportaba parse-errors (y lo hacía
// bien); los otros 21 lectores los tragaban en un `catch` mudo. Al migrarlos a
// reportar, un error tipado que arrastrara `e.message` llevaría la superficie de
// fuga de CERO a veintidós call-sites.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const resolver = require('../config-resolver');
const schema = require('../config-schema');

const SECRETO = 'SUPER-SECRETO-ABC123';
const PASSWORD = 'pa55w0rd-de-prueba';
const API_KEY = 'sk-ant-CLAVE-FALSA-9999';

function mkTmp(nombre) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `cfgsec-${nombre}-`));
}

function escribir(dir, contenido) {
    fs.writeFileSync(path.join(dir, 'config.yaml'), contenido, 'utf8');
    return dir;
}

/** Todo el texto que el error puede llegar a poner en superficie de operador. */
function superficieDeError(err, estado) {
    return [
        err.message,
        JSON.stringify({ archivo: err.archivo, causa: err.causa, linea: err.linea, columna: err.columna }),
        JSON.stringify(err.errors || []),
        estado ? JSON.stringify(estado) : '',
        estado ? schema.formatConfigFailureLog(estado) : '',
        estado ? schema.formatConfigFailureTelegram(estado) : '',
    ].join('\n');
}

test.beforeEach(() => {
    resolver.clearCache();
    resolver._resetTraceState();
    resolver.setTraceSink(() => {});
});

test.after(() => {
    resolver.setTraceSink(null);
});

test('camino YAML: parse-error con secreto en la línea adyacente no filtra NADA del archivo', () => {
    const dir = mkTmp('yaml');
    // El secreto está en la línea 3; el error de indentación está en la 4. El
    // snippet de js-yaml incluiría ambas.
    escribir(dir, [
        'telegram_outbound:',
        '  max_retries: 3',
        `  bot_token: ${SECRETO}`,
        '   mal_indentado: x',
        '',
    ].join('\n'));

    let err = null;
    try { resolver.resolve({ pipelineDir: dir }); } catch (e) { err = e; }
    assert.ok(err, 'debe lanzar');
    assert.equal(err.name, 'ConfigParseViolation');

    const estado = schema.describeConfigFailure(err, { contexto: 'halt-auto' });
    const superficie = superficieDeError(err, estado);

    // Assert NEGATIVO explícito sobre el literal del secreto.
    assert.equal(superficie.includes(SECRETO), false,
        'el literal del secreto NO puede aparecer en ninguna superficie de operador');
    assert.equal(superficie.includes('bot_token'), false,
        'ni siquiera la clave adyacente: el snippet de js-yaml trae líneas enteras');
    assert.equal(/mal_indentado/.test(superficie), false,
        'ninguna línea del archivo, ni la que falló');

    // Y sí expone lo accionable y seguro: archivo, causa, línea, columna.
    assert.equal(err.causa, 'yaml-invalido');
    assert.equal(typeof err.linea, 'number');
    assert.equal(typeof err.columna, 'number');
    assert.ok(estado.detalle.includes('línea'));
});

test('el error NO encadena el error de js-yaml (`cause` vacía)', () => {
    const dir = mkTmp('cause');
    escribir(dir, `a:\n  token: ${SECRETO}\n   roto: 1\n`);
    let err = null;
    try { resolver.resolve({ pipelineDir: dir }); } catch (e) { err = e; }
    assert.equal(err.cause, undefined, 'encadenar reexpone `.message` con el snippet crudo');
    assert.equal(err.stack.includes(SECRETO), false, 'ni por el stack');
});

test('camino ajv: violación de schema no vuelca el valor crudo', () => {
    const dir = mkTmp('ajv');
    // `infra_escalate_threshold` con un valor que ADEMÁS parece un secreto.
    escribir(dir, [
        'circuit_breaker:',
        `  infra_escalate_threshold: "${API_KEY}"`,
        '  auto_resume_ok_threshold: 2',
        `  password: "${PASSWORD}"`,
        '',
    ].join('\n'));

    let err = null;
    try { resolver.resolve({ pipelineDir: dir }); } catch (e) { err = e; }
    assert.ok(err, 'debe lanzar');
    assert.equal(err.name, 'ConfigSchemaViolation');

    const estado = schema.describeConfigFailure(err, { contexto: 'halt-auto' });
    const superficie = superficieDeError(err, estado);

    assert.equal(superficie.includes(API_KEY), false, 'ajv con verbose:false + redactErrors: sin valor crudo');
    assert.equal(superficie.includes(PASSWORD), false);
    // Lo que sí expone: dónde está el problema y qué regla se violó.
    assert.ok(/circuit_breaker/.test(superficie), 'el path del error sí es seguro y es lo accionable');
});

test('CA-UX-4: ningún código de máquina llega a la superficie del operador', () => {
    const casos = [
        { causa: 'ENOENT', linea: null, columna: null },
        { causa: 'not-a-file', linea: null, columna: null },
        { causa: 'empty-or-not-a-map', linea: null, columna: null },
        { causa: 'yaml-invalido', linea: 12, columna: 5 },
        { causa: 'schema-invalido', linea: null, columna: null },
    ];
    for (const c of casos) {
        const err = new schema.ConfigParseViolation('x', {
            archivo: 'C:/repo/.pipeline/config.yaml', via: 'default', ...c,
        });
        const estado = schema.describeConfigFailure(err, { contexto: 'halt-auto', repoRoot: 'C:/repo' });
        const textos = [
            schema.formatConfigFailureLog(estado),
            schema.formatConfigFailureTelegram(estado),
        ].join('\n');
        for (const codigo of ['ENOENT', 'not-a-file', 'empty-or-not-a-map']) {
            assert.equal(textos.includes(codigo), false,
                `el código de máquina '${codigo}' no puede aparecer en el texto al operador (causa=${c.causa})`);
        }
        assert.ok(estado.detalle.length > 0 && estado.accion.length > 0,
            'toda causa tiene detalle y acción en español');
    }
});

test('CA-16 / SEC-4: la traza de overrides no expone variables fuera de la allowlist', () => {
    const dir = mkTmp('override');
    escribir(dir, 'admission_gate:\n  sweep_enabled: true\n  dry_run: false\n');

    const lineas = [];
    resolver.setTraceSink((l, nivel) => lineas.push(`${nivel}|${l}`));

    const prevSweep = process.env.ADMISSION_SWEEP_ENABLED;
    const prevToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.ADMISSION_SWEEP_ENABLED = '0';
    process.env.TELEGRAM_BOT_TOKEN = SECRETO;
    try {
        const cfg = resolver.resolve({ pipelineDir: dir });
        // G-2: la sección real es `admission_gate`, no `admission`.
        assert.equal(cfg.admission_gate.sweep_enabled, false, 'env > YAML');
        assert.equal(cfg.admission, undefined, 'no se crea una sección fantasma `admission`');
    } finally {
        if (prevSweep === undefined) delete process.env.ADMISSION_SWEEP_ENABLED;
        else process.env.ADMISSION_SWEEP_ENABLED = prevSweep;
        if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
        else process.env.TELEGRAM_BOT_TOKEN = prevToken;
        resolver.setTraceSink(() => {});
    }

    const todo = lineas.join('\n');
    // Assert NEGATIVO sobre el valor, no sólo sobre el nombre de la variable.
    assert.equal(todo.includes(SECRETO), false,
        'el resolver no barre process.env: el bot token jamás puede llegar al log');
    assert.equal(todo.includes('TELEGRAM_BOT_TOKEN'), false);
    // El override que DEBILITA un gate se loguea con nivel de ALERTA, no info.
    const alerta = lineas.find((l) => l.startsWith('alerta|'));
    assert.ok(alerta, 'apagar el sweep es un override que debilita ⇒ nivel alerta');
    assert.ok(alerta.includes('ADMISSION_SWEEP_ENABLED=0'));
    assert.ok(alerta.includes('origen: env, no archivo'),
        'sin esa frase el operador audita config.yaml, lo ve correcto y no entiende el gate apagado');
});

test('CA-16: override que NO debilita se traza como info, no como alerta', () => {
    const dir = mkTmp('override-ok');
    escribir(dir, 'admission_gate:\n  sweep_enabled: false\n  dry_run: false\n');
    const lineas = [];
    resolver.setTraceSink((l, nivel) => lineas.push(`${nivel}|${l}`));
    const prev = process.env.ADMISSION_SWEEP_ENABLED;
    process.env.ADMISSION_SWEEP_ENABLED = '1';
    try {
        const cfg = resolver.resolve({ pipelineDir: dir });
        assert.equal(cfg.admission_gate.sweep_enabled, true, 'encender el gate por env también es efectivo');
    } finally {
        if (prev === undefined) delete process.env.ADMISSION_SWEEP_ENABLED;
        else process.env.ADMISSION_SWEEP_ENABLED = prev;
        resolver.setTraceSink(() => {});
    }
    assert.equal(lineas.some((l) => l.startsWith('alerta|')), false, 'encender un gate no es una alerta');
    assert.ok(lineas.some((l) => l.startsWith('info|') && l.includes('ADMISSION_SWEEP_ENABLED=1')));
});

test('CA-16: sin env vars, los valores efectivos son los del YAML (paridad afirmada, no supuesta)', () => {
    const dir = mkTmp('sin-env');
    escribir(dir, 'admission_gate:\n  sweep_enabled: true\n  dry_run: false\n');
    const prevA = process.env.ADMISSION_SWEEP_ENABLED;
    const prevB = process.env.ADMISSION_GATE_DRY_RUN;
    delete process.env.ADMISSION_SWEEP_ENABLED;
    delete process.env.ADMISSION_GATE_DRY_RUN;
    try {
        const cfg = resolver.resolve({ pipelineDir: dir });
        // Coinciden con lo que producía `servicio-reconciler.js:61-62` con las
        // env vars ausentes (`!== '0'` ⇒ true, `=== '1'` ⇒ false).
        assert.equal(cfg.admission_gate.sweep_enabled, true);
        assert.equal(cfg.admission_gate.dry_run, false);
    } finally {
        if (prevA !== undefined) process.env.ADMISSION_SWEEP_ENABLED = prevA;
        if (prevB !== undefined) process.env.ADMISSION_GATE_DRY_RUN = prevB;
    }
});

test('formatOverrideAlert sólo habla de la allowlist y nombra el origen', () => {
    const prev = process.env.ADMISSION_GATE_DRY_RUN;
    process.env.ADMISSION_GATE_DRY_RUN = '1';
    try {
        const msg = resolver.formatOverrideAlert('ADMISSION_GATE_DRY_RUN');
        assert.ok(msg.includes('⚠️'));
        assert.ok(msg.includes('Origen: entorno del proceso, no `config.yaml`'),
            'la frase de origen es el punto UX: sin ella el operador audita el archivo y no entiende el gate apagado');
        assert.equal(resolver.formatOverrideAlert('TELEGRAM_BOT_TOKEN'), null,
            'una variable fuera de la allowlist no produce mensaje alguno');
    } finally {
        if (prev === undefined) delete process.env.ADMISSION_GATE_DRY_RUN;
        else process.env.ADMISSION_GATE_DRY_RUN = prev;
    }
});

test('redactYamlParseError sólo devuelve posición, nunca texto del archivo', () => {
    const yaml = require('js-yaml');
    let e = null;
    try { yaml.load(`a:\n  token: ${SECRETO}\n   roto: 1\n`); } catch (err) { e = err; }
    assert.ok(e && e.message.includes(SECRETO), 'precondición: js-yaml SÍ vuelca el snippet crudo');
    const red = require('../config-schema').redactYamlParseError(e);
    assert.deepEqual(Object.keys(red).sort(), ['causa', 'columna', 'linea']);
    assert.equal(JSON.stringify(red).includes(SECRETO), false);
});
