'use strict';

// =============================================================================
// vault-load-calibration.test.js — #5805 (hija de #5800)
//
// Cubre la corrida de calibración: preflight fail-closed de integración,
// identidad de sólo lectura, exclusividad de las tres vías de resolución,
// higiene del artefacto y publicación atómica.
//
// Todo corre con `createInMemoryVaultDriver` y relojes inyectados: sin red, sin
// cuenta AWS, sin timers ni sleeps. El único filesystem que se toca es un
// directorio temporal creado por el propio test.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
    preflightIntegrations,
    buildCalibrationEvidence,
    publishCalibrationArtifact,
    runCalibration,
    LOAD_CALIBRATION_ERROR_CODES: E,
    ARTIFACT_FILENAME,
    GIT_ENV_ALLOWLIST,
    buildAllowlistedEnv,
    createGitPort,
} = require('./vault-load-calibration');

const {
    VAULT_TELEMETRY_CATEGORIES,
    VAULT_TELEMETRY,
    createInMemoryVaultDriver,
    createSecretVault,
    buildParameterPath,
} = require('./secret-vault');

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const HEAD = 'a'.repeat(40);
const SHA_5339 = '1'.repeat(40);
const SHA_5340 = '2'.repeat(40);
const SHA_5791 = '3'.repeat(40);
const SHA_5792 = '4'.repeat(40);

const DEPENDENCIAS = Object.freeze([
    { issue: 5339, commit: SHA_5339 },
    { issue: 5340, commit: SHA_5340 },
    { issue: 5791, commit: SHA_5791 },
    { issue: 5792, commit: SHA_5792 },
]);

// Canarios distinguibles: cada uno viaja por un canal distinto (valor del vault,
// ambiente del proceso, mensaje de error del driver). Si alguno aparece en el
// artefacto o en una excepción, el test falla.
const CANARIO_VAULT = 'CANARIO-PAYLOAD-DEL-VAULT-5805';
const CANARIO_AMBIENTE = 'CANARIO-EN-EL-AMBIENTE-5805';
const CANARIO_DRIVER = 'CANARIO-EN-EL-ERROR-DEL-DRIVER-5805';

const WINDOW_START_MS = 1735689600000;   // 2025-01-01T00:00:00.000Z
const WINDOW_START_ISO = '2025-01-01T00:00:00.000Z';

const PREFIX = '/test5805';
const PROJECT = 'proyecto5805';
const HOST = 'host5805';
const SCOPE = 'alpha';

function identidadValida() {
    return { read_only: true, scopes: [SCOPE] };
}

function formulaValida() {
    return { kind: 'ceil_rate_extrapolation', horizon: 'month' };
}

function preflightValido() {
    return {
        head: HEAD,
        integrated: DEPENDENCIAS.map((d) => ({ issue: d.issue, commit: d.commit })),
    };
}

function windowValida(over = {}) {
    return {
        started_at: WINDOW_START_ISO,
        duration_ms: 60000,
        concurrency: 8,
        launches: 16,
        distribution: 'sequential',
        bucket_ms: 10000,
        peak_physical_reads_per_bucket: 4,
        scope_logico: SCOPE,
        ...over,
    };
}

function contadores(over = {}) {
    return {
        physical_read: 12,
        cache_hit: 30,
        single_flight_join: 7,
        ...over,
    };
}

function escenario(over = {}) {
    return {
        window_start_ms: WINDOW_START_MS,
        window_duration_ms: 60000,
        bucket_ms: 10000,
        concurrency: 8,
        launches: 16,
        distribution: 'sequential',
        sequence_seed: 7,
        unit: 'physical_read',
        ...over,
    };
}

/**
 * `git` fake. Responde por comando y permite declarar qué dependencias NO están
 * integradas, si el árbol está sucio y si el HEAD resuelve.
 */
function gitFake(opts = {}) {
    const faltantes = new Set(opts.faltantes || []);
    const noResolubles = new Set(opts.noResolubles || []);
    const llamadas = [];
    const fn = (argv) => {
        llamadas.push(argv.join(' '));
        if (argv[0] === 'rev-parse' && argv[1] === 'HEAD') {
            if (opts.headRoto) throw new Error('fatal: no se pudo resolver HEAD');
            return `${opts.head || HEAD}\n`;
        }
        if (argv[0] === 'status') {
            return opts.sucio ? ' M .pipeline/lib/vault-load-calibration.js\n' : '\n';
        }
        if (argv[0] === 'rev-parse' && argv[1] === '--verify') {
            const ref = argv[argv.length - 1].replace('^{commit}', '');
            if (noResolubles.has(ref)) throw new Error(`fatal: ambiguous argument '${ref}'`);
            return `${ref}\n`;
        }
        if (argv[0] === 'merge-base') {
            const sha = argv[2];
            if (faltantes.has(sha)) throw new Error('exit 1');
            return '';
        }
        throw new Error(`comando no esperado: ${argv.join(' ')}`);
    };
    fn.llamadas = llamadas;
    return fn;
}

/** Driver espía: cuenta invocaciones y devuelve siempre lectura física. */
function driverEspia(categoria) {
    const fn = async () => ({ category: categoria || VAULT_TELEMETRY.PHYSICAL_READ });
    fn.invocaciones = 0;
    const envuelto = async (req) => {
        envuelto.invocaciones += 1;
        return fn(req);
    };
    envuelto.invocaciones = 0;
    return envuelto;
}

/** Reloj determinístico dentro de la ventana. */
function relojDeVentana(step = 1000) {
    let i = 0;
    return () => {
        const ts = WINDOW_START_MS + Math.min(i * step, 59000);
        i += 1;
        return ts;
    };
}

function dirTemporal() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'calib5805-'));
}

function limpiar(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) { /* el test ya terminó: no importa */ }
}

async function capturarError(fn) {
    try {
        await fn();
    } catch (err) {
        return err;
    }
    assert.fail('se esperaba un CalibrationError y no hubo excepción');
    return null;
}

function depsBase(over = {}) {
    return {
        git: gitFake(),
        requiredCommits: DEPENDENCIAS.map((d) => ({ ...d })),
        scenario: escenario(),
        clock: relojDeVentana(),
        driver: driverEspia(),
        identity: identidadValida(),
        scopeLogico: SCOPE,
        formula: formulaValida(),
        fs,
        crypto,
        ...over,
    };
}

// =============================================================================
// CA-1 / CA-7 · Preflight fail-closed
// =============================================================================

test('preflight resuelve HEAD y los cuatro commits integrados', () => {
    const git = gitFake();
    const resultado = preflightIntegrations({ git, requiredCommits: DEPENDENCIAS.map((d) => ({ ...d })) });

    assert.equal(resultado.head, HEAD);
    assert.equal(resultado.integrated.length, 4);
    assert.deepEqual(resultado.integrated.map((i) => i.issue), [5339, 5340, 5791, 5792]);
    assert.equal(resultado.integrated[0].commit, SHA_5339);
    // El resultado es inmutable: nadie puede "agregar" una integración después.
    assert.ok(Object.isFrozen(resultado));
    assert.ok(Object.isFrozen(resultado.integrated));
});

for (const { issue, commit } of DEPENDENCIAS) {
    test(`preflight falla cerrado y no ejecuta ni una lectura fisica cuando falta #${issue}`, async () => {
        const dir = dirTemporal();
        const driver = driverEspia();
        try {
            const err = await capturarError(() => runCalibration(depsBase({
                dir,
                driver,
                git: gitFake({ faltantes: [commit] }),
            })));

            assert.equal(err.code, E.INTEGRATION_MISSING);
            // CA-7: el operador sabe QUÉ destrabar sin leer el código fuente.
            assert.equal(err.detail.field, `issue_${issue}`);
            // CA-1: ni una sola lectura física antes del fallo.
            assert.equal(driver.invocaciones, 0);
            // CA-1: el directorio queda limpio, incluidos los temporales.
            assert.deepEqual(fs.readdirSync(dir), []);
        } finally {
            limpiar(dir);
        }
    });
}

test('preflight falla cerrado cuando el arbol de trabajo esta sucio', async () => {
    const dir = dirTemporal();
    const driver = driverEspia();
    try {
        const err = await capturarError(() => runCalibration(depsBase({
            dir, driver, git: gitFake({ sucio: true }),
        })));

        assert.equal(err.code, E.WORKTREE_DIRTY);
        assert.equal(driver.invocaciones, 0);
        // El path del archivo sucio NO viaja en el error: es dato sensible.
        assert.equal(err.detail.field, 'worktree');
        assert.ok(!err.message.includes('.pipeline'));
        assert.deepEqual(fs.readdirSync(dir), []);
    } finally {
        limpiar(dir);
    }
});

test('preflight falla cerrado cuando el SHA es ambiguo o no resoluble', () => {
    const err1 = capturarErrorSync(() => preflightIntegrations({
        git: gitFake({ noResolubles: [SHA_5791] }),
        requiredCommits: DEPENDENCIAS.map((d) => ({ ...d })),
    }));
    assert.equal(err1.code, E.INTEGRATION_UNRESOLVED);
    assert.equal(err1.detail.field, 'issue_5791');

    const err2 = capturarErrorSync(() => preflightIntegrations({
        git: gitFake({ headRoto: true }),
        requiredCommits: DEPENDENCIAS.map((d) => ({ ...d })),
    }));
    assert.equal(err2.code, E.HEAD_UNRESOLVED);

    // Un HEAD que resuelve a algo que no es un SHA de 40 hex tampoco pasa.
    const err3 = capturarErrorSync(() => preflightIntegrations({
        git: gitFake({ head: 'HEAD -> refs/heads/main' }),
        requiredCommits: DEPENDENCIAS.map((d) => ({ ...d })),
    }));
    assert.equal(err3.code, E.HEAD_UNRESOLVED);
});

test('preflight rechaza referencias de commit con forma de flag o de path', () => {
    for (const commit of ['--upload-pack=rm -rf /', '../../etc/passwd', 'HEAD', 'ABCDEF0', '']) {
        const err = capturarErrorSync(() => preflightIntegrations({
            git: gitFake(),
            requiredCommits: [{ issue: 5339, commit }],
        }));
        assert.equal(err.code, E.REQUIRED_COMMITS_INVALID);
    }
});

test('preflight rechaza claves desconocidas y issues duplicados en requiredCommits', () => {
    const conExtra = capturarErrorSync(() => preflightIntegrations({
        git: gitFake(),
        requiredCommits: [{ issue: 5339, commit: SHA_5339, rama: 'main' }],
    }));
    assert.equal(conExtra.code, E.REQUIRED_COMMITS_INVALID);
    assert.equal(conExtra.detail.field, 'rama');

    const duplicado = capturarErrorSync(() => preflightIntegrations({
        git: gitFake(),
        requiredCommits: [
            { issue: 5339, commit: SHA_5339 },
            { issue: 5339, commit: SHA_5340 },
        ],
    }));
    assert.equal(duplicado.code, E.REQUIRED_COMMITS_INVALID);
});

function capturarErrorSync(fn) {
    try {
        fn();
    } catch (err) {
        return err;
    }
    assert.fail('se esperaba un CalibrationError y no hubo excepción');
    return null;
}

// =============================================================================
// Identidad de sólo lectura con scopes mínimos
// =============================================================================

test('la corrida usa identidad de solo lectura con los scopes minimos del escenario', async () => {
    const dir = dirTemporal();
    try {
        // 1. Identidad correcta: la corrida completa y publica.
        const ok = await runCalibration(depsBase({ dir }));
        assert.equal(ok.evidence.scope_logico, SCOPE);

        // 2. Sin la declaración explícita de sólo lectura no se mide.
        const driverSinLectura = driverEspia();
        const errModo = await capturarError(() => runCalibration(depsBase({
            dir, driver: driverSinLectura, identity: { read_only: 'true', scopes: [SCOPE] },
        })));
        assert.equal(errModo.code, E.IDENTITY_NOT_READ_ONLY);
        assert.equal(driverSinLectura.invocaciones, 0);

        // 3. Un scope de más es privilegio no justificado.
        const errScopes = await capturarError(() => runCalibration(depsBase({
            dir, identity: { read_only: true, scopes: [SCOPE, 'beta'] },
        })));
        assert.equal(errScopes.code, E.IDENTITY_SCOPES_EXCESIVOS);

        // 4. Un scope distinto del medido tampoco pasa.
        const errOtro = await capturarError(() => runCalibration(depsBase({
            dir, identity: { read_only: true, scopes: ['beta'] },
        })));
        assert.equal(errOtro.code, E.IDENTITY_SCOPES_EXCESIVOS);

        // 5. Un driver que expone un verbo de escritura invalida la declaración.
        const driverConEscritura = driverEspia();
        driverConEscritura.putParameter = async () => ({});
        const errDriver = await capturarError(() => runCalibration(depsBase({
            dir, driver: driverConEscritura,
        })));
        assert.equal(errDriver.code, E.IDENTITY_NOT_READ_ONLY);
        assert.equal(driverConEscritura.invocaciones, 0);
    } finally {
        limpiar(dir);
    }
});

test('el scope logico rechaza ARN, account id y nombres de secreto', async () => {
    const dir = dirTemporal();
    try {
        for (const scope of [
            'arn:aws:ssm:us-east-2:123456789012:parameter/x',
            '/intrale/prod/telegram',
            '123456789012',
            'Alpha',
        ]) {
            const err = await capturarError(() => runCalibration(depsBase({
                dir, scopeLogico: scope, identity: { read_only: true, scopes: [scope] },
            })));
            assert.equal(err.code, E.SCOPE_INVALID);
        }
    } finally {
        limpiar(dir);
    }
});

// =============================================================================
// CA-3 · Exclusividad de las tres vías de resolución
// =============================================================================

test('las tres vias de resolucion son mutuamente excluyentes por resolucion bajo concurrencia', async () => {
    const dir = dirTemporal();
    try {
        const parametros = {
            [buildParameterPath({
                prefix: PREFIX, projectId: PROJECT, hostId: HOST, scope: SCOPE, tier: 'host',
            })]: { valor: CANARIO_VAULT },
        };
        const driverVault = createInMemoryVaultDriver({ parameters: parametros });

        // El vault emite `physical_read` / `cache_hit`; el join lo emite la capa
        // que coalesce, igual que en producción (`credentials.js`). Cada
        // resolución obtiene su categoría de UN solo punto de decisión.
        const eventosVault = [];
        let reloj = WINDOW_START_MS;
        const vault = createSecretVault({
            config: {
                enabled: true,
                prefix: PREFIX,
                projectId: PROJECT,
                hostId: HOST,
                cache_ttl_seconds: 300,
                required_scopes: [SCOPE],
                shared_secrets: [],
                region: 'us-east-2',
            },
            driver: driverVault,
            now: () => reloj,
            sink: (e) => eventosVault.push(e),
        });

        let vuelo = null;
        const driver = async () => {
            if (vuelo) {
                await vuelo;
                return { category: VAULT_TELEMETRY.SINGLE_FLIGHT_JOIN };
            }
            const antes = eventosVault.length;
            vuelo = vault.resolveScope({ scopes: [SCOPE] });
            try {
                await vuelo;
            } finally {
                vuelo = null;
            }
            const emitido = eventosVault[antes];
            return { category: emitido.category };
        };

        const resultado = await runCalibration(depsBase({
            dir,
            driver,
            // 16 launches en dos lotes de 8: el primero produce 1 lectura física
            // + 7 joins, el segundo 1 hit de caché + 7 joins.
            scenario: escenario({ launches: 16, concurrency: 8 }),
            clock: relojDeVentana(1000),
        }));

        const counts = resultado.evidence.counts;
        const suma = VAULT_TELEMETRY_CATEGORIES.reduce((acc, c) => acc + counts[c], 0);

        // Sin doble conteo: la suma de las tres vías IGUALA el total de
        // resoluciones, que es exactamente la cantidad de launches.
        assert.equal(suma, 16);
        assert.equal(counts.total_resolutions, 16);
        assert.equal(counts.physical_read, 1);
        assert.equal(counts.cache_hit, 1);
        assert.equal(counts.single_flight_join, 14);
        // Y el vault leyó el backend UNA sola vez pese a las 16 resoluciones.
        assert.equal(driverVault.calls.length, 1);
    } finally {
        limpiar(dir);
    }
});

// =============================================================================
// CA-3 / CA-5 · Pico y extrapolación
// =============================================================================

test('pico y extrapolacion mensual se calculan solo con physical_read', () => {
    const base = buildCalibrationEvidence({
        preflight: preflightValido(),
        window: windowValida(),
        counters: contadores({ cache_hit: 30, single_flight_join: 7 }),
        formula: formulaValida(),
    });
    const variado = buildCalibrationEvidence({
        preflight: preflightValido(),
        window: windowValida(),
        // Mismo `physical_read`, las otras dos categorías cambian por completo.
        counters: contadores({ cache_hit: 99999, single_flight_join: 4242 }),
        formula: formulaValida(),
    });

    assert.equal(
        base.peak_physical_reads_per_minute,
        variado.peak_physical_reads_per_minute,
    );
    assert.equal(base.monthly_extrapolation, variado.monthly_extrapolation);

    // Y sí cambian cuando cambia la categoría física.
    const masFisicas = buildCalibrationEvidence({
        preflight: preflightValido(),
        window: windowValida(),
        counters: contadores({ physical_read: 24 }),
        formula: formulaValida(),
    });
    assert.notEqual(masFisicas.monthly_extrapolation, base.monthly_extrapolation);

    // El pico se escala del bucket físico más cargado: 4 lecturas / 10s = 24/min.
    assert.equal(base.peak_physical_reads_per_minute, 24);
    assert.equal(base.peak_unit, 'physical_read/minute');
});

test('la extrapolacion es recalculable por un tercero desde la formula publicada', () => {
    const evidencia = buildCalibrationEvidence({
        preflight: preflightValido(),
        window: windowValida(),
        counters: contadores({ physical_read: 37 }),
        formula: formulaValida(),
    });

    // Un tercero toma expression + params y rehace la cuenta a mano.
    const { params, expression, substitution, unit } = evidencia.formula;
    assert.equal(expression, 'monthly_extrapolation = ceil(physical_read * horizon_ms / window_duration_ms)');
    const recalculado = Math.ceil(
        (params.physical_read * params.horizon_ms) / params.window_duration_ms,
    );
    assert.equal(recalculado, evidencia.monthly_extrapolation);

    // La sustitución publicada refleja los mismos números y la misma unidad.
    assert.equal(substitution, `ceil(37 * ${params.horizon_ms} / 60000)`);
    assert.equal(unit, 'physical_read/month');
    assert.equal(evidencia.formula.rounding, 'ceil');
});

test('la formula rechaza horizontes y familias fuera del enum cerrado', () => {
    for (const formula of [
        { kind: 'ceil_rate_extrapolation', horizon: 'quarter' },
        { kind: 'linear', horizon: 'month' },
        { kind: 'ceil_rate_extrapolation', horizon: 'month', horizon_ms: 1 },
        { kind: 'ceil_rate_extrapolation' },
    ]) {
        const err = capturarErrorSync(() => buildCalibrationEvidence({
            preflight: preflightValido(),
            window: windowValida(),
            counters: contadores(),
            formula,
        }));
        assert.equal(err.code, E.FORMULA_INVALID);
    }
});

// =============================================================================
// CA-2 / CA-4 · Contenido y higiene del artefacto
// =============================================================================

test('la evidencia registra ventana, distribucion, commits y SHA exacto del HEAD', () => {
    const evidencia = buildCalibrationEvidence({
        preflight: preflightValido(),
        window: windowValida(),
        counters: contadores(),
        formula: formulaValida(),
    });

    assert.equal(evidencia.schema_version, 1);
    assert.equal(evidencia.head_sha, HEAD);
    assert.equal(evidencia.integrated_commits.length, 4);
    assert.deepEqual(
        evidencia.integrated_commits.map((c) => c.issue),
        [5339, 5340, 5791, 5792],
    );
    assert.equal(evidencia.window.started_at, WINDOW_START_ISO);
    assert.equal(evidencia.window.duration_ms, 60000);
    assert.equal(evidencia.window.concurrency, 8);
    assert.equal(evidencia.window.launches, 16);
    assert.equal(evidencia.window.distribution, 'sequential');
    assert.equal(evidencia.counts.total_resolutions, 12 + 30 + 7);
    assert.deepEqual(evidencia.excluded_from_physical_metrics, ['cache_hit', 'single_flight_join']);
});

test('contadores ausentes, no finitos, negativos o fraccionarios invalidan la corrida', () => {
    const casos = [
        { physical_read: 1, cache_hit: 2 },                                    // falta una vía
        contadores({ physical_read: -1 }),
        contadores({ physical_read: 1.5 }),
        contadores({ physical_read: Number.NaN }),
        contadores({ physical_read: Number.POSITIVE_INFINITY }),
        contadores({ physical_read: '12' }),
        { ...contadores(), categoria_inventada: 3 },                           // vía de más
    ];
    for (const counters of casos) {
        const err = capturarErrorSync(() => buildCalibrationEvidence({
            preflight: preflightValido(),
            window: windowValida(),
            counters,
            formula: formulaValida(),
        }));
        assert.equal(err.code, E.COUNTERS_INVALID);
    }
});

test('el artefacto rechaza claves desconocidas en vez de copiarlas', () => {
    const conExtraEnWindow = capturarErrorSync(() => buildCalibrationEvidence({
        preflight: preflightValido(),
        window: windowValida({ operador: 'leito', ruta_local: 'C:\\secretos' }),
        counters: contadores(),
        formula: formulaValida(),
    }));
    assert.equal(conExtraEnWindow.code, E.WINDOW_INVALID);

    const conExtraEnPreflight = capturarErrorSync(() => buildCalibrationEvidence({
        preflight: { ...preflightValido(), env: { AWS_SECRET_ACCESS_KEY: 'x' } },
        window: windowValida(),
        counters: contadores(),
        formula: formulaValida(),
    }));
    assert.equal(conExtraEnPreflight.code, E.PREFLIGHT_INVALID);
    assert.equal(conExtraEnPreflight.detail.field, 'env');

    // Herencia peligrosa: se rechaza, no se ignora.
    const conProto = capturarErrorSync(() => buildCalibrationEvidence({
        preflight: preflightValido(),
        window: JSON.parse('{"started_at":"2025-01-01T00:00:00.000Z","__proto__":{"x":1}}'),
        counters: contadores(),
        formula: formulaValida(),
    }));
    assert.ok([E.WINDOW_INVALID].includes(conProto.code));
});

test('la evidencia rechaza ARN, account id, paths absolutos y volcados de ambiente', () => {
    const dir = dirTemporal();
    try {
        const sucias = [
            { ...ejemploEvidencia(), scope_logico: 'arn:aws:ssm:us-east-2:123456789012:parameter/x' },
            { ...ejemploEvidencia(), extra: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI' },
            { ...ejemploEvidencia(), extra: 'C:\\Workspaces\\Intrale\\platform' },
            { ...ejemploEvidencia(), extra: '/home/runner/.aws/credentials' },
            // La clave de abajo es el ejemplo publico de la documentacion de AWS:
            // esta puesta a proposito para probar que el patron la detecta. secret-scan:ignore
            { ...ejemploEvidencia(), extra: 'AKIAIOSFODNN7EXAMPLE' },   // secret-scan:ignore
        ];
        for (const evidence of sucias) {
            const err = capturarErrorSync(() => publishCalibrationArtifact({
                evidence, dir, fs, crypto,
            }));
            assert.equal(err.code, E.EVIDENCE_NOT_CLEAN);
        }
        // Nada quedó publicado por los intentos sucios.
        assert.deepEqual(fs.readdirSync(dir), []);
    } finally {
        limpiar(dir);
    }
});

function ejemploEvidencia() {
    return buildCalibrationEvidence({
        preflight: preflightValido(),
        window: windowValida(),
        counters: contadores(),
        formula: formulaValida(),
    });
}

// =============================================================================
// CA-4 · Canarios
// =============================================================================

test('canarios de payload del vault, ambiente y error del driver no aparecen en el artefacto', async () => {
    const dir = dirTemporal();
    const ambienteOriginal = process.env.CANARIO_AMBIENTE_5805;
    process.env.CANARIO_AMBIENTE_5805 = CANARIO_AMBIENTE;
    try {
        const parametros = {
            [buildParameterPath({
                prefix: PREFIX, projectId: PROJECT, hostId: HOST, scope: SCOPE, tier: 'host',
            })]: { valor: CANARIO_VAULT },
        };
        const driverVault = createInMemoryVaultDriver({ parameters: parametros });
        const vault = createSecretVault({
            config: {
                enabled: true,
                prefix: PREFIX,
                projectId: PROJECT,
                hostId: HOST,
                cache_ttl_seconds: 300,
                required_scopes: [SCOPE],
                shared_secrets: [],
                region: 'us-east-2',
            },
            driver: driverVault,
            now: () => WINDOW_START_MS,
        });

        // El driver resuelve secretos REALES (el canario viaja por el payload) y
        // devuelve sólo la categoría.
        const driver = async () => {
            const resuelto = await vault.resolveScope({ scopes: [SCOPE] });
            assert.equal(resuelto[SCOPE].valor, CANARIO_VAULT);   // el canario existe de verdad
            return { category: VAULT_TELEMETRY.PHYSICAL_READ };
        };

        const { evidence, artifact } = await runCalibration(depsBase({ dir, driver }));

        const publicado = fs.readFileSync(artifact.path, 'utf8');
        const serializado = JSON.stringify(evidence);

        for (const canario of [CANARIO_VAULT, CANARIO_AMBIENTE, CANARIO_DRIVER]) {
            assert.ok(!publicado.includes(canario), `canario literal en el artefacto: ${canario}`);
            assert.ok(!serializado.includes(canario));
            // Fragmentos: un canario partido tampoco puede filtrarse.
            for (const fragmento of [canario.slice(0, 12), canario.slice(-12)]) {
                assert.ok(!publicado.includes(fragmento), `fragmento en el artefacto: ${fragmento}`);
            }
            // Hash estable: tampoco viaja una huella correlacionable del valor.
            const hash = crypto.createHash('sha256').update(canario).digest('hex');
            assert.ok(!publicado.includes(hash));
            assert.ok(!publicado.includes(hash.slice(0, 16)));
        }
        // Ninguna variable de ambiente, en ninguna forma.
        assert.ok(!publicado.includes('CANARIO_AMBIENTE_5805'));
        assert.ok(!publicado.includes(os.tmpdir()));
    } finally {
        if (ambienteOriginal === undefined) delete process.env.CANARIO_AMBIENTE_5805;
        else process.env.CANARIO_AMBIENTE_5805 = ambienteOriginal;
        limpiar(dir);
    }
});

test('el canario tampoco aparece en el camino de excepcion', async () => {
    const dir = dirTemporal();
    try {
        const driver = async () => {
            const err = new Error(`falló la lectura: ${CANARIO_DRIVER}`);
            err.stack = `Error: ${CANARIO_DRIVER}\n    at C:\\Workspaces\\secreto.js:1:1`;
            err.payload = CANARIO_VAULT;
            throw err;
        };

        const err = await capturarError(() => runCalibration(depsBase({ dir, driver })));

        const serializado = `${err.name} ${err.code} ${err.message} ${JSON.stringify(err.detail)}`;
        for (const canario of [CANARIO_VAULT, CANARIO_DRIVER]) {
            assert.ok(!serializado.includes(canario), `canario en el error: ${canario}`);
            assert.ok(!serializado.includes(canario.slice(0, 12)));
        }
        assert.ok(!serializado.includes('C:\\Workspaces'));
        assert.equal(err.detail.field, 'driver');
        // Y la corrida fallida no dejó nada publicado.
        assert.deepEqual(fs.readdirSync(dir), []);
    } finally {
        limpiar(dir);
    }
});

// =============================================================================
// CA-1 / CA-4 · Publicación
// =============================================================================

test('el artefacto se publica atomicamente y con permisos minimos', () => {
    const evidence = ejemploEvidencia();
    const orden = [];
    const fsFake = {
        mkdirSync: () => { orden.push('mkdir'); },
        writeFileSync: (destino, contenido, opciones) => {
            orden.push('write');
            assert.ok(path.basename(destino).startsWith(`.${ARTIFACT_FILENAME}.`));
            assert.ok(path.basename(destino).endsWith('.tmp'));
            // Permisos mínimos EN LA CREACIÓN: el archivo nunca existe abierto.
            assert.equal(opciones.mode, 0o600);
            assert.equal(opciones.encoding, 'utf8');
            assert.equal(JSON.parse(contenido).head_sha, HEAD);
        },
        renameSync: (desde, hacia) => {
            orden.push('rename');
            assert.equal(path.basename(hacia), ARTIFACT_FILENAME);
            assert.notEqual(desde, hacia);
        },
        rmSync: () => { orden.push('rm'); },
        readdirSync: () => [],
    };

    const resultado = publishCalibrationArtifact({
        evidence, dir: path.join(os.tmpdir(), 'calib5805-fake'), fs: fsFake, crypto,
    });

    // El rename ocurre DESPUÉS de la escritura completa: no hay ventana donde el
    // nombre canónico apunte a un JSON a medio escribir.
    assert.deepEqual(orden, ['mkdir', 'write', 'rename']);
    assert.equal(resultado.filename, ARTIFACT_FILENAME);
    assert.ok(resultado.bytes > 0);
});

test('el nombre y la ruta del artefacto estan fijos en codigo', () => {
    const evidence = ejemploEvidencia();
    for (const dir of ['../../etc', 'relativo/audit', '', null, 42]) {
        const err = capturarErrorSync(() => publishCalibrationArtifact({
            evidence, dir, fs, crypto,
        }));
        assert.equal(err.code, E.ARTIFACT_DIR_INVALID);
    }
    // Un `..` sin normalizar en un directorio absoluto tampoco pasa.
    const raiz = path.parse(os.tmpdir()).root;
    const conTraversal = `${raiz}tmp${path.sep}..${path.sep}audit`;
    const traversal = capturarErrorSync(() => publishCalibrationArtifact({
        evidence, dir: conTraversal, fs, crypto,
    }));
    assert.equal(traversal.code, E.ARTIFACT_DIR_INVALID);
});

test('un fallo de validacion no deja artefacto con el nombre canonico', async () => {
    const dir = dirTemporal();
    try {
        // Evidencia de una corrida ANTERIOR + un temporal huérfano.
        const canonico = path.join(dir, ARTIFACT_FILENAME);
        fs.writeFileSync(canonico, JSON.stringify({ head_sha: 'b'.repeat(40) }), 'utf8');
        fs.writeFileSync(path.join(dir, `.${ARTIFACT_FILENAME}.999.dead.tmp`), '{}', 'utf8');

        const err = await capturarError(() => runCalibration(depsBase({
            dir, git: gitFake({ sucio: true }),
        })));
        assert.equal(err.code, E.WORKTREE_DIRTY);

        // CA-1: el directorio queda limpio. Una evidencia de otro HEAD no puede
        // sobrevivir a una corrida fallida y hacerse pasar por la nueva.
        assert.deepEqual(fs.readdirSync(dir), []);
        assert.equal(fs.existsSync(canonico), false);
    } finally {
        limpiar(dir);
    }
});

test('la corrida exitosa publica un JSON legible en la ruta canonica', async () => {
    const dir = dirTemporal();
    try {
        const { evidence, artifact } = await runCalibration(depsBase({ dir }));

        assert.equal(path.basename(artifact.path), ARTIFACT_FILENAME);
        const enDisco = JSON.parse(fs.readFileSync(artifact.path, 'utf8'));
        assert.deepEqual(enDisco, JSON.parse(JSON.stringify(evidence)));
        assert.equal(enDisco.head_sha, HEAD);
        assert.equal(enDisco.counts.total_resolutions, 16);
        // No quedan temporales.
        assert.deepEqual(fs.readdirSync(dir), [ARTIFACT_FILENAME]);

        if (process.platform !== 'win32') {
            // En POSIX los permisos son verificables de verdad.
            assert.equal(fs.statSync(artifact.path).mode & 0o777, 0o600);
        }
    } finally {
        limpiar(dir);
    }
});

// =============================================================================
// Requisito 3 de Security · env del proceso hijo
// =============================================================================

test('el env del proceso hijo contiene solo las variables allowlisted', () => {
    const ambiente = {
        PATH: '/usr/bin',
        HOME: '/home/agente',
        AWS_SECRET_ACCESS_KEY: CANARIO_AMBIENTE,
        ANTHROPIC_API_KEY: CANARIO_AMBIENTE,
        TELEGRAM_BOT_TOKEN: CANARIO_AMBIENTE,
        CANARIO_AMBIENTE_5805: CANARIO_AMBIENTE,
    };

    const proyectado = buildAllowlistedEnv(ambiente);
    assert.deepEqual(Object.keys(proyectado).sort(), ['HOME', 'PATH']);
    for (const clave of Object.keys(proyectado)) {
        assert.ok(GIT_ENV_ALLOWLIST.includes(clave));
    }
    assert.ok(!JSON.stringify(proyectado).includes(CANARIO_AMBIENTE));

    // Y el puerto real de git tampoco filtra: se captura el `env` efectivo.
    let capturado = null;
    const git = createGitPort({
        execFileSync: (file, args, opts) => {
            capturado = opts;
            assert.equal(file, 'git');
            assert.ok(Array.isArray(args));
            return `${HEAD}\n`;
        },
        cwd: '/repo',
        env: ambiente,
    });
    const salida = git(['rev-parse', 'HEAD']);

    assert.equal(salida.trim(), HEAD);
    assert.deepEqual(Object.keys(capturado.env).sort(), ['HOME', 'PATH']);
    assert.ok(!JSON.stringify(capturado.env).includes(CANARIO_AMBIENTE));
    // stderr NO se captura: puede traer paths absolutos del repo.
    assert.deepEqual(capturado.stdio, ['ignore', 'pipe', 'ignore']);
    assert.equal(capturado.cwd, '/repo');
});

test('el puerto de git exige argv como arreglo de strings', () => {
    const git = createGitPort({ execFileSync: () => '', cwd: '/repo' });
    for (const argv of ['rev-parse HEAD', null, ['rev-parse', 3]]) {
        const err = capturarErrorSync(() => git(argv));
        assert.equal(err.code, E.GIT_PORT_MISSING);
    }
});

// =============================================================================
// Orquestación · puertos obligatorios
// =============================================================================

test('runCalibration falla cerrado si falta cualquier puerto', async () => {
    const dir = dirTemporal();
    try {
        for (const puerto of ['git', 'clock', 'driver', 'fs', 'crypto']) {
            const deps = depsBase({ dir });
            delete deps[puerto];
            const err = await capturarError(() => runCalibration(deps));
            assert.equal(err.code, E.PORT_MISSING);
            assert.equal(err.detail.field, puerto);
        }
        const sinDeps = await capturarError(() => runCalibration(null));
        assert.equal(sinDeps.code, E.PORT_MISSING);
    } finally {
        limpiar(dir);
    }
});

test('el HEAD que sella la evidencia es el mismo que valido el preflight', async () => {
    const dir = dirTemporal();
    try {
        const git = gitFake();
        const { evidence } = await runCalibration(depsBase({ dir, git }));

        assert.equal(evidence.head_sha, HEAD);
        // El preflight corrió ANTES de medir: HEAD, estado del árbol y las cuatro
        // verificaciones de ancestro.
        assert.equal(git.llamadas[0], 'rev-parse HEAD');
        assert.equal(git.llamadas[1], 'status --porcelain');
        assert.equal(git.llamadas.filter((c) => c.startsWith('merge-base')).length, 4);
    } finally {
        limpiar(dir);
    }
});
