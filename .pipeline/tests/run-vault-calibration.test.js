'use strict';

// =============================================================================
// run-vault-calibration.test.js — #5805
//
// Cubre el WRAPPER CLI: parseo de argumentos, validación del sobre, traducción
// de códigos de error a códigos de salida y el driver que traduce una resolución
// del vault a su categoría.
//
// La lógica de negocio se prueba en `.pipeline/lib/vault-load-calibration.test.js`.
// Acá no se toca AWS ni la red: `credentials` y `git` entran por inyección.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    main,
    parseArgs,
    parsearSobre,
    createVaultResolutionDriver,
    traducir,
    TRADUCCION,
    EXIT,
} = require('../scripts/run-vault-calibration');

const {
    LOAD_CALIBRATION_ERROR_CODES: E,
    ARTIFACT_FILENAME,
} = require('../lib/vault-load-calibration');

// #5800 — los códigos del núcleo de escenario también llegan a este borde.
const { CALIBRATION_ERROR_CODES: N } = require('../lib/vault-calibration-scenario');

const { VAULT_TELEMETRY } = require('../lib/secret-vault');

const HEAD = 'c'.repeat(40);
const SHA_DEP = '5'.repeat(40);
const WINDOW_START_MS = 1735689600000;

function sobreValido(over = {}) {
    return {
        scenario: {
            window_start_ms: WINDOW_START_MS,
            window_duration_ms: 60000,
            bucket_ms: 10000,
            concurrency: 4,
            launches: 8,
            distribution: 'sequential',
            sequence_seed: 1,
            unit: 'physical_read',
        },
        required_commits: [{ issue: 5339, commit: SHA_DEP }],
        project_id: 'intrale',
        scope_logico: 'telegram',
        ...over,
    };
}

function gitFake(opts = {}) {
    return (argv) => {
        if (argv[0] === 'rev-parse' && argv[1] === 'HEAD') return `${HEAD}\n`;
        if (argv[0] === 'status') return opts.sucio ? ' M archivo\n' : '\n';
        if (argv[0] === 'rev-parse' && argv[1] === '--verify') {
            return `${argv[argv.length - 1].replace('^{commit}', '')}\n`;
        }
        if (argv[0] === 'merge-base') return '';
        throw new Error('comando no esperado');
    };
}

/** `credentials` fake: una lectura física y el resto hits de caché. */
function credentialsFake(comportamiento = {}) {
    let resoluciones = 0;
    return {
        async resolveInstanceVaultAsync(args, opts) {
            resoluciones += 1;
            if (comportamiento.falla) return { ok: false, code: 'X', error: 'detalle sensible' };
            if (comportamiento.sinEvento) return { ok: true, scopes: {} };
            const categoria = resoluciones === 1
                ? VAULT_TELEMETRY.PHYSICAL_READ
                : VAULT_TELEMETRY.CACHE_HIT;
            opts.vaultSink({ category: categoria, ts_ms: WINDOW_START_MS });
            return { ok: true, scopes: { telegram: {} } };
        },
    };
}

function relojDeVentana() {
    let i = 0;
    return () => {
        const ts = WINDOW_START_MS + Math.min(i * 1000, 59000);
        i += 1;
        return ts;
    };
}

function dirTemporal() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'calibcli5805-'));
}

function limpiar(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) { /* nada que hacer */ }
}

/** Corre `main` silenciando la salida del CLI para no ensuciar el reporte. */
async function correr(argv, deps) {
    const log = console.log;
    const error = console.error;
    const salida = [];
    console.log = (...a) => salida.push(a.join(' '));
    console.error = (...a) => salida.push(a.join(' '));
    try {
        const codigo = await main(argv, deps);
        return { codigo, salida: salida.join('\n') };
    } finally {
        console.log = log;
        console.error = error;
    }
}

function depsCli(over = {}) {
    return {
        stdinTexto: JSON.stringify(sobreValido()),
        credentials: credentialsFake(),
        git: gitFake(),
        clock: relojDeVentana(),
        ...over,
    };
}

// -----------------------------------------------------------------------------
// Argumentos
// -----------------------------------------------------------------------------

test('parseArgs reconoce las tres opciones y marca lo desconocido', () => {
    assert.deepEqual(parseArgs(['--stdin', '--json']),
        { help: false, stdin: true, json: true, desconocido: null });
    assert.equal(parseArgs(['--help']).help, true);
    assert.equal(parseArgs(['-h']).help, true);
    assert.equal(parseArgs(['--publicar-en', '/tmp']).desconocido, '--publicar-en');
});

test('el CLI muestra la ayuda y no ejecuta nada', async () => {
    const { codigo, salida } = await correr(['--help'], depsCli());
    assert.equal(codigo, EXIT.OK);
    assert.match(salida, /run-vault-calibration/);
    assert.match(salida, /Codigos de salida/);
});

test('el CLI rechaza argumentos desconocidos y la falta de --stdin', async () => {
    const desconocido = await correr(['--dir', '/tmp'], depsCli());
    assert.equal(desconocido.codigo, EXIT.USAGE);

    const sinStdin = await correr([], depsCli());
    assert.equal(sinStdin.codigo, EXIT.USAGE);
    assert.match(sinStdin.salida, /falta --stdin/);
});

// -----------------------------------------------------------------------------
// Sobre
// -----------------------------------------------------------------------------

test('parsearSobre rechaza JSON invalido, claves ajenas y campos faltantes', () => {
    assert.match(parsearSobre('{no json').error, /no es JSON valido/);
    assert.match(parsearSobre('[]').error, /objeto JSON/);
    assert.match(parsearSobre(JSON.stringify({ ...sobreValido(), dir: '/tmp' })).error,
        /clave desconocida/);
    const sinScope = sobreValido();
    delete sinScope.scope_logico;
    assert.match(parsearSobre(JSON.stringify(sinScope)).error, /scope_logico/);
    assert.ok(parsearSobre(JSON.stringify(sobreValido())).sobre);
});

test('el CLI corta con codigo de entrada cuando el sobre no cierra', async () => {
    const vacio = await correr(['--stdin'], depsCli({ stdinTexto: '   ' }));
    assert.equal(vacio.codigo, EXIT.INPUT);

    const ajeno = await correr(['--stdin'], depsCli({
        stdinTexto: JSON.stringify({ ...sobreValido(), artifact_path: '/tmp/x.json' }),
    }));
    assert.equal(ajeno.codigo, EXIT.INPUT);
});

// -----------------------------------------------------------------------------
// Corrida
// -----------------------------------------------------------------------------

test('el CLI publica el artefacto y resume la corrida para el operador', async () => {
    const dir = dirTemporal();
    try {
        const { codigo, salida } = await correr(['--stdin'], depsCli({ dir }));

        assert.equal(codigo, EXIT.OK);
        assert.deepEqual(fs.readdirSync(dir), [ARTIFACT_FILENAME]);

        const artefacto = JSON.parse(fs.readFileSync(path.join(dir, ARTIFACT_FILENAME), 'utf8'));
        assert.equal(artefacto.head_sha, HEAD);
        assert.equal(artefacto.counts.total_resolutions, 8);
        assert.equal(artefacto.counts.physical_read, 1);
        assert.equal(artefacto.counts.cache_hit, 7);
        assert.equal(artefacto.scope_logico, 'telegram');

        // El resumen dice qué se midió y dónde quedó, sin path absoluto.
        assert.match(salida, /HEAD medido/);
        assert.match(salida, /\.pipeline\/audit\/vault-load-calibration\.json/);
        assert.ok(!salida.includes(os.tmpdir()));
    } finally {
        limpiar(dir);
    }
});

test('el CLI devuelve el codigo de salida de preflight cuando el arbol esta sucio', async () => {
    const dir = dirTemporal();
    try {
        const { codigo, salida } = await correr(['--stdin'], depsCli({
            dir, git: gitFake({ sucio: true }),
        }));

        assert.equal(codigo, EXIT.PREFLIGHT);
        assert.match(salida, new RegExp(E.WORKTREE_DIRTY));
        assert.match(salida, /proximo paso/);
        assert.deepEqual(fs.readdirSync(dir), []);
    } finally {
        limpiar(dir);
    }
});

test('el modo --json emite un objeto consumible por un wrapper', async () => {
    const dir = dirTemporal();
    try {
        const ok = await correr(['--stdin', '--json'], depsCli({ dir }));
        const cuerpo = JSON.parse(ok.salida);
        assert.equal(cuerpo.ok, true);
        assert.equal(cuerpo.artifact, '.pipeline/audit/vault-load-calibration.json');
        assert.equal(cuerpo.evidence.head_sha, HEAD);

        const falla = await correr(['--stdin', '--json'], depsCli({
            dir, git: gitFake({ sucio: true }),
        }));
        const error = JSON.parse(falla.salida);
        assert.equal(error.ok, false);
        assert.equal(error.code, E.WORKTREE_DIRTY);
        assert.ok(error.impacto.length > 0);
        assert.ok(error.siguiente.length > 0);
    } finally {
        limpiar(dir);
    }
});

// -----------------------------------------------------------------------------
// Driver de resolución
// -----------------------------------------------------------------------------

test('el driver toma la categoria del evento de SU propia invocacion', async () => {
    const credentials = credentialsFake();
    const driver = createVaultResolutionDriver({
        credentials, projectId: 'intrale', scope: 'telegram',
    });

    assert.deepEqual(await driver(), { category: VAULT_TELEMETRY.PHYSICAL_READ });
    assert.deepEqual(await driver(), { category: VAULT_TELEMETRY.CACHE_HIT });
});

test('el driver falla cerrado si la resolucion no clasifica o no resuelve', async () => {
    const sinEvento = createVaultResolutionDriver({
        credentials: credentialsFake({ sinEvento: true }), projectId: 'intrale', scope: 'telegram',
    });
    await assert.rejects(sinEvento, (err) => err.code === 'VAULT_RESOLUTION_UNCLASSIFIED');

    const falla = createVaultResolutionDriver({
        credentials: credentialsFake({ falla: true }), projectId: 'intrale', scope: 'telegram',
    });
    // El texto del vault NO se propaga: sólo sobrevive el código propio.
    await assert.rejects(falla, (err) => err.code === 'VAULT_RESOLUTION_FAILED'
        && !err.message.includes('detalle sensible'));
});

// -----------------------------------------------------------------------------
// Traducción
// -----------------------------------------------------------------------------

test('cada codigo de error del modulo tiene traduccion para el operador', () => {
    for (const code of Object.values(E)) {
        assert.ok(Object.prototype.hasOwnProperty.call(TRADUCCION, code),
            `el código ${code} no tiene fila en la tabla de traducción del CLI`);
        const t = traducir({ code });
        assert.ok(t.impacto.length > 0);
        assert.ok(t.siguiente.length > 0);
        assert.ok(Object.values(EXIT).includes(t.exit));
    }
    // Un código desconocido sí cae a interno, con texto genérico y sin filtrar nada.
    const desconocido = traducir({ code: 'OTRO', detail: { field: 'x' } });
    assert.equal(desconocido.exit, EXIT.INTERNAL);
});

// -----------------------------------------------------------------------------
// #5800 — cierre del hueco entre el núcleo de escenario (#5804) y este borde.
//
// `runCalibration` propaga los `CalibrationError` del núcleo TAL CUAL, así que
// sus códigos llegan hasta acá. Antes no tenían fila y salían por el FALLBACK
// como "condicion no prevista / reportar el incidente" con salida interna, que
// manda al operador a abrir un incidente cuando lo que había era un parámetro
// mal declarado en su propio sobre.
// -----------------------------------------------------------------------------

/** Códigos del núcleo que SÍ son defecto nuestro y por eso pueden ser internos. */
const CODIGOS_INTERNOS_LEGITIMOS = new Set([
    N.SUMMARY_INVALID,
    N.PORT_MISSING,
    N.CLOCK_INVALID,
    N.RESOLVE_HEAD_FAILED,
    N.DRIVER_RESULT_INVALID,
    N.SINK_FAILED,
]);

test('cada codigo del nucleo de escenario tambien tiene traduccion en este borde', () => {
    for (const code of Object.values(N)) {
        assert.ok(Object.prototype.hasOwnProperty.call(TRADUCCION, code),
            `el código ${code} del núcleo no tiene fila en la tabla de traducción del CLI`);
        const t = traducir({ code });
        assert.ok(t.impacto.length > 0, `${code} sin impacto`);
        assert.ok(t.siguiente.length > 0, `${code} sin próximo paso`);
        assert.ok(Object.values(EXIT).includes(t.exit), `${code} con salida fuera del enum`);
    }
});

test('un parametro mal declarado no se reporta como error interno del pipeline', () => {
    // Todo lo que el operador puede corregir en su sobre tiene que salir por un
    // código distinto de INTERNAL: ése es el que dispara "reportar el incidente".
    for (const code of Object.values(N)) {
        if (CODIGOS_INTERNOS_LEGITIMOS.has(code)) continue;
        assert.notEqual(traducir({ code }).exit, EXIT.INTERNAL,
            `${code} se le presenta al operador como defecto del pipeline`);
    }
});

test('la tabla de traduccion no tiene filas huerfanas', () => {
    const conocidos = new Set([...Object.values(E), ...Object.values(N)]);
    for (const code of Object.keys(TRADUCCION)) {
        assert.ok(conocidos.has(code), `la tabla traduce ${code}, que ya no emite ningún módulo`);
    }
});

test('un escenario mal parametrizado corta con salida de corrida y paso accionable', async () => {
    const sobre = sobreValido();
    sobre.scenario.bucket_ms = 7000; // no divide exacto a los 60000 ms de ventana
    const { codigo, salida } = await correr(['--stdin'],
        depsCli({ stdinTexto: JSON.stringify(sobre) }));

    assert.equal(codigo, EXIT.RUN);
    assert.match(salida, /CALIBRATION_WINDOW_NOT_DIVISIBLE/);
    assert.match(salida, /bucket_ms/);
    assert.doesNotMatch(salida, /condicion no prevista/);
    assert.doesNotMatch(salida, /reportar el incidente con el codigo/);
});

test('una resolucion fallida del vault se reporta como corrida, no como bug interno', async () => {
    const { codigo, salida } = await correr(['--stdin'],
        depsCli({ credentials: credentialsFake({ falla: true }) }));

    assert.equal(codigo, EXIT.RUN);
    assert.match(salida, /CALIBRATION_DRIVER_FAILED/);
    assert.match(salida, /SOLO LECTURA/);
    // El detalle del error del vault sigue descartado: nada del backend se filtra.
    assert.doesNotMatch(salida, /detalle sensible/);
});
