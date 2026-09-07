'use strict';

// =============================================================================
// Tests del break-glass del corte del fallback (#5460 · CA-28).
//
// Cubren: funciona sin Telegram, exige identidad local autorizada, no filtra
// secretos, y NO saltea la cobertura positiva.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

const breakGlass = require('../vault-cut-breakglass');
const { RESULT, EXIT_CODE, CONFIRM_PHRASE } = breakGlass;

const T0 = Date.parse('2026-08-28T10:00:00.000Z');

// Canarios: si alguno aparece en stdout o en el audit, hay filtración.
const CANARIOS = [
    'AKIAIOSFODNN7EXAMPLE',
    'DESKTOP-TOTQAUE',
    'C:\\Users\\Administrator',
    '987654321',
    'arn:aws:secretsmanager:us-east-1:123456789012:secret:intrale',
];

function fixture(t, overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breakglass-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, yaml.dump({
        vault: {
            enabled: true,
            bootstrap_fallback: true,
            cut_fallback: {
                authorization_ttl_seconds: 300,
                operation_timeout_ms: 1000,
                runbook: 'docs/operacion-pipeline.md#corte-fallback-vault',
            },
        },
    }));
    const auditPath = path.join(dir, 'audit', 'vault-cut-fallback.jsonl');

    // Allowlist inyectada: no se depende del singleton de producción.
    const allowlist = require('../operator-allowlist').createAllowlist({
        operators: [{ id: 'leo', role: 'primary' }, { id: 'suplente', role: 'backup' }],
    });

    return {
        dir, configPath, auditPath, allowlist,
        readConfig: () => yaml.load(fs.readFileSync(configPath, 'utf8')),
        readAudit: () => (fs.existsSync(auditPath)
            ? fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
            : []),
        rawAudit: () => (fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : ''),
        opts: {
            operatorId: 'leo',
            confirmation: `${CONFIRM_PHRASE}\n`,
            evaluateCoverage: () => ({ estado: 'cumple' }),
            allowlist,
            configPath,
            auditPath,
            runbook: 'docs/operacion-pipeline.md#corte-fallback-vault',
            now: () => T0,
            ...overrides,
        },
    };
}

// =============================================================================
// Identidad local
// =============================================================================

test('sólo un operador `primary` de la allowlist en código autoriza el corte', () => {
    const allowlist = require('../operator-allowlist').createAllowlist({
        operators: [{ id: 'leo', role: 'primary' }, { id: 'suplente', role: 'backup' }],
    });
    assert.equal(breakGlass.authorizeLocalIdentity('leo', allowlist).ok, true);
    assert.equal(breakGlass.authorizeLocalIdentity('suplente', allowlist).reason, 'not-primary');
    assert.equal(breakGlass.authorizeLocalIdentity('mallory', allowlist).reason, 'unknown-operator');
});

test('identidad ausente, vacía o no-string se rechaza (fail-closed)', () => {
    const allowlist = require('../operator-allowlist').createAllowlist({ operators: [{ id: 'leo', role: 'primary' }] });
    for (const id of ['', '   ', null, undefined, 42, {}, []]) {
        assert.equal(breakGlass.authorizeLocalIdentity(id, allowlist).ok, false, `id: ${JSON.stringify(id)}`);
    }
});

test('una allowlist vacía no autoriza a nadie', () => {
    const vacia = require('../operator-allowlist').createAllowlist({ operators: [] });
    assert.equal(breakGlass.authorizeLocalIdentity('leo', vacia).ok, false);
});

test('un no autorizado NO corta y el fallback queda intacto', async (t) => {
    const fx = fixture(t, { operatorId: 'mallory' });
    const out = await breakGlass.runBreakGlass(fx.opts);
    assert.equal(out.result, RESULT.UNAUTHORIZED);
    assert.equal(out.exitCode, EXIT_CODE[RESULT.UNAUTHORIZED]);
    assert.equal(fx.readConfig().vault.bootstrap_fallback, true);
});

test('el rechazo por identidad ocurre ANTES de mirar la cobertura', async (t) => {
    let evaluada = false;
    const fx = fixture(t, {
        operatorId: 'mallory',
        evaluateCoverage: () => { evaluada = true; return { estado: 'cumple' }; },
    });
    await breakGlass.runBreakGlass(fx.opts);
    assert.equal(evaluada, false,
        'un no autorizado no debe poder inferir el estado del vault por el codigo de salida');
});

// =============================================================================
// Segundo factor: la frase por stdin
// =============================================================================

test('la frase exacta confirma; cualquier variante no', () => {
    assert.equal(breakGlass.isConfirmed(CONFIRM_PHRASE), true);
    assert.equal(breakGlass.isConfirmed(`  ${CONFIRM_PHRASE}\r\n`), true);
    for (const mala of ['cortar fallback', 'CORTAR  FALLBACK', 'CORTAR FALLBACK!', 'si', '', null, undefined, {}]) {
        assert.equal(breakGlass.isConfirmed(mala), false, `frase: ${JSON.stringify(mala)}`);
    }
});

test('sin la frase no se corta, aunque la identidad sea válida', async (t) => {
    const fx = fixture(t, { confirmation: 'si dale\n' });
    const out = await breakGlass.runBreakGlass(fx.opts);
    assert.equal(out.result, RESULT.NOT_CONFIRMED);
    assert.equal(fx.readConfig().vault.bootstrap_fallback, true);
});

// =============================================================================
// La cobertura NO se saltea
// =============================================================================

test('el break-glass NO es un --force: sin cobertura positiva no corta', async (t) => {
    for (const estado of ['no_cumple', 'no_verificado', 'cualquier_cosa', null]) {
        const fx = fixture(t, { evaluateCoverage: () => ({ estado }) });
        const out = await breakGlass.runBreakGlass(fx.opts);
        assert.equal(out.result, RESULT.COVERAGE_INCOMPLETE, `estado: ${estado}`);
        assert.equal(fx.readConfig().vault.bootstrap_fallback, true);
    }
});

test('un evaluador de cobertura que explota se trata como cobertura insuficiente', async (t) => {
    const fx = fixture(t, { evaluateCoverage: () => { throw new Error('sidecar roto'); } });
    const out = await breakGlass.runBreakGlass(fx.opts);
    assert.equal(out.result, RESULT.COVERAGE_INCOMPLETE);
    assert.equal(fx.readConfig().vault.bootstrap_fallback, true);
});

test('la cobertura se REVALIDA dentro del ejecutor, no sólo en el preflight', async (t) => {
    let llamadas = 0;
    const fx = fixture(t, {
        evaluateCoverage: () => { llamadas += 1; return { estado: 'cumple' }; },
    });
    await breakGlass.runBreakGlass(fx.opts);
    assert.ok(llamadas >= 2,
        'la cobertura tiene que reevaluarse dentro del lock, inmediatamente antes de persistir');
});

// =============================================================================
// Corte real — sin Telegram en ningún lado
// =============================================================================

test('corta de verdad sin ningún canal de Telegram involucrado', async (t) => {
    const fx = fixture(t);
    const out = await breakGlass.runBreakGlass(fx.opts);

    assert.equal(out.result, RESULT.CUT);
    assert.equal(out.exitCode, 0);
    assert.equal(fx.readConfig().vault.bootstrap_fallback, false);

    // El evento del corte y el del break-glass conviven en el mismo JSONL.
    const eventos = fx.readAudit().map((e) => e.event);
    assert.ok(eventos.includes('fallback_cut'));
    assert.ok(eventos.includes('breakglass_cut'));
});

test('un segundo break-glass sobre un fallback ya cortado es idempotente', async (t) => {
    const fx = fixture(t);
    await breakGlass.runBreakGlass(fx.opts);
    const out = await breakGlass.runBreakGlass(fx.opts);
    assert.equal(out.result, RESULT.ALREADY_CUT);
    assert.equal(out.exitCode, 0);
    assert.equal(fx.readConfig().vault.bootstrap_fallback, false);
});

test('el audit del break-glass marca el canal y el operador, y nada más', async (t) => {
    const fx = fixture(t);
    await breakGlass.runBreakGlass(fx.opts);
    const bg = fx.readAudit().find((e) => e.event === 'breakglass_cut');
    assert.equal(bg.channel, 'break-glass');
    assert.equal(bg.operator, 'leo');
    assert.equal(bg.ok, true);
    assert.equal(bg.result, RESULT.CUT);
    assert.deepEqual(Object.keys(bg).sort(),
        ['channel', 'event', 'ok', 'operator', 'result', 'runbook', 'ts']);
});

test('un fallo del ejecutor conserva el fallback y no propaga el mensaje del error', async (t) => {
    const fx = fixture(t, {
        executeCut: async () => {
            const e = new Error('EACCES C:\\Users\\Administrator\\.pipeline\\config.yaml');
            e.code = 'persist_failed';
            throw e;
        },
    });
    const out = await breakGlass.runBreakGlass(fx.opts);
    assert.equal(out.result, RESULT.PRECONDITION_FAILED);
    assert.equal(fx.readConfig().vault.bootstrap_fallback, true);
    assert.equal(JSON.stringify(out).includes('Administrator'), false);
});

test('un error sin `code` conocido es INDETERMINADO, no un éxito', async (t) => {
    const fx = fixture(t, { executeCut: async () => { throw new Error('boom'); } });
    const out = await breakGlass.runBreakGlass(fx.opts);
    assert.equal(out.result, RESULT.UNAVAILABLE);
    assert.equal(fx.readConfig().vault.bootstrap_fallback, true);
});

test('`audit_pending` con estado aplicado NO miente: reporta el corte hecho', async (t) => {
    const fx = fixture(t, {
        executeCut: async () => {
            const e = new Error('audit pendiente');
            e.code = 'audit_pending';
            e.stateApplied = true;
            throw e;
        },
    });
    const out = await breakGlass.runBreakGlass(fx.opts);
    assert.equal(out.result, RESULT.CUT);
});

// =============================================================================
// No filtración
// =============================================================================

test('ni la salida ni el audit filtran secretos, ARNs, hostnames o chat ids', async (t) => {
    const fx = fixture(t, {
        // Los canarios entran por todas las vías que un caller controla.
        operatorId: 'leo',
        runbook: CANARIOS[4],
        evaluateCoverage: () => ({ estado: 'cumple', motivo: CANARIOS.join(' ') }),
    });
    const out = await breakGlass.runBreakGlass(fx.opts);
    const texto = breakGlass.formatBreakGlassOutcome(out);
    const superficie = `${texto}\n${JSON.stringify(out)}\n${fx.rawAudit()}`;

    for (const canario of CANARIOS) {
        assert.equal(superficie.includes(canario), false, `se filtró: ${canario}`);
    }
});

test('el runbook hostil se sanea también en la salida del break-glass', () => {
    const texto = breakGlass.formatBreakGlassOutcome({
        result: RESULT.CUT, runbook: '../../.aws/credentials',
    });
    assert.equal(texto.includes('.aws'), false);
    assert.match(texto, /Runbook: docs\//);
});

test('el copy cubre todos los resultados del enum sin dejar "undefined"', () => {
    for (const result of Object.values(RESULT)) {
        const texto = breakGlass.formatBreakGlassOutcome({ result });
        assert.equal(texto.includes('undefined'), false, `result: ${result}`);
    }
    // Un resultado desconocido tampoco: degrada a indeterminado.
    assert.match(breakGlass.formatBreakGlassOutcome({ result: 'inventado' }), /INDETERMINADO/);
});

test('cada resultado del enum tiene un código de salida estable y distinto de 0 salvo el éxito', () => {
    for (const result of Object.values(RESULT)) {
        assert.equal(typeof EXIT_CODE[result], 'number', `sin exit code: ${result}`);
    }
    assert.equal(EXIT_CODE[RESULT.CUT], 0);
    assert.equal(EXIT_CODE[RESULT.ALREADY_CUT], 0);
    for (const fallo of [RESULT.UNAUTHORIZED, RESULT.NOT_CONFIRMED, RESULT.COVERAGE_INCOMPLETE,
        RESULT.PRECONDITION_FAILED, RESULT.UNAVAILABLE]) {
        assert.notEqual(EXIT_CODE[fallo], 0, `deberia fallar: ${fallo}`);
    }
});

test('un audit que no se puede escribir no impide reportar el resultado', async (t) => {
    // `configPath` es un ARCHIVO: crear un directorio adentro falla siempre.
    const fx = fixture(t);
    const out = await breakGlass.runBreakGlass({
        ...fx.opts, auditPath: path.join(fx.configPath, 'sub', 'audit.jsonl'),
    });
    assert.equal(out.audited, false);
    assert.equal(typeof out.result, 'string');
});

// =============================================================================
// CLI
// =============================================================================

test('la CLI toma el operador de --operator o de PIPELINE_OPERATOR_ID', () => {
    const cli = require('../../vault-cut-breakglass');
    assert.equal(cli.parseArgs(['--operator', 'leo']).operatorId, 'leo');
    assert.equal(cli.parseArgs(['--operator=leo']).operatorId, 'leo');
    assert.equal(cli.parseArgs(['--help']).help, true);
});

test('la CLI NO acepta la frase de confirmación por argv', () => {
    const cli = require('../../vault-cut-breakglass');
    const parsed = cli.parseArgs(['--operator', 'leo', CONFIRM_PHRASE, `--confirm=${CONFIRM_PHRASE}`]);
    assert.deepEqual(Object.keys(parsed).sort(), ['help', 'operatorId']);
    assert.equal(JSON.stringify(parsed).includes(CONFIRM_PHRASE), false);
});

test('la ayuda de la CLI documenta que la frase va por stdin y que la cobertura no se saltea', () => {
    const cli = require('../../vault-cut-breakglass');
    assert.match(cli.HELP, /STDIN/);
    assert.match(cli.HELP, /NO la saltea/);
    assert.match(cli.HELP, /primary/);
});
