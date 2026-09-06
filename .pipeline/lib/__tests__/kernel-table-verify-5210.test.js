'use strict';

// =============================================================================
// kernel-table-verify-5210.test.js — Verificador read-only de las tablas del
// kernel (#5210).
//
// Cobertura por criterio:
//   CA-1 : config.yaml real tiene las tres claves pobladas y `durable:false`.
//   CA-2 : `summarizeTable` sólo aprueba con los cuatro controles OBSERVADOS.
//   CA-3 : `classifyDeny` separa implicitDeny de explicitDeny (decide el remedio)
//          y ningún gap puede declararse cumplido (`assertNoUnverifiedClaims`).
//   CA-4 : la tabla de coordinación se mantiene DISTINTA de la de no-repudio.
//   CA-5 : con `durable:false` el pipeline no construye store ni toca DynamoDB.
//   CA-7 : allowlist read-only — el módulo no puede aprovisionar nada.
//   A03/A05/A09 : sin shell, sin hardcode, con redacción.
//
// Los fakes evitan cualquier llamada real a AWS: la suite corre offline.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const v = require('../kernel-table-verify');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.yaml');

// --- Fixtures ---------------------------------------------------------------

const ACCT = '123456789012';
const KEY_ARN = `arn:aws:kms:us-east-2:${ACCT}:key/aaaa1111-bbbb-2222-cccc-333344445555`;

function describeTablePayload(overrides = {}) {
    return {
        Table: {
            TableName: 'intrale-kernel-state',
            TableStatus: 'ACTIVE',
            TableArn: `arn:aws:dynamodb:us-east-2:${ACCT}:table/intrale-kernel-state`,
            BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
            SSEDescription: { Status: 'ENABLED', SSEType: 'KMS', KMSMasterKeyArn: KEY_ARN },
            DeletionProtectionEnabled: true,
            ...overrides,
        },
    };
}

// Mensajes REALES del AWS CLI (capturados con el perfil `kernel-runtime`,
// con el account id sustituido). Se guardan textuales a propósito: si AWS
// cambia el wording, esta suite lo detecta antes que una auditoría.
const DENY_IMPLICITO = `An error occurred (AccessDeniedException) when calling the DescribeContinuousBackups operation: `
    + `User: arn:aws:iam::${ACCT}:user/intrale-kernel-runtime is not authorized to perform: `
    + `dynamodb:DescribeContinuousBackups on resource: arn:aws:dynamodb:us-east-2:${ACCT}:table/intrale-kernel-state `
    + `because no identity-based policy allows the dynamodb:DescribeContinuousBackups action`;

const DENY_EXPLICITO = `An error occurred (AccessDeniedException) when calling the LookupEvents operation: `
    + `User: arn:aws:iam::${ACCT}:user/intrale-kernel-runtime is not authorized to perform: `
    + `cloudtrail:LookupEvents with an explicit deny in an identity-based policy: `
    + `arn:aws:iam::${ACCT}:policy/IntraleKernelStore`;

const CFG_OK = {
    tableName: 'intrale-kernel-state',
    coordinationTableName: 'intrale-kernel-coordination',
    region: 'us-east-2',
    durable: false,
};

/**
 * Runner fake: responde describe-table con éxito y deniega todo lo demás.
 * Registra cada comando para poder afirmar QUÉ se invocó (y qué no).
 */
function fakeAwsRunner(opts = {}) {
    const calls = [];
    return {
        profile: 'kernel-runtime',
        calls,
        async run(args) {
            calls.push(args.join(' '));
            const verb = `${args[0]} ${args[1]}`;
            if (verb === 'dynamodb describe-table') {
                const idx = args.indexOf('--table-name');
                const name = args[idx + 1];
                if (opts.tablaFaltante === name) {
                    return { code: 255, stdout: '', stderr: `An error occurred (ResourceNotFoundException): Requested resource not found` };
                }
                return {
                    code: 0,
                    stdout: JSON.stringify(describeTablePayload({
                        TableName: name,
                        TableArn: `arn:aws:dynamodb:us-east-2:${ACCT}:table/${name}`,
                        ...(opts.tableOverrides || {}),
                    })),
                    stderr: '',
                };
            }
            if (verb === 'cloudtrail lookup-events' || verb === 'kms list-aliases') {
                return { code: 254, stdout: '', stderr: DENY_EXPLICITO };
            }
            return { code: 254, stdout: '', stderr: DENY_IMPLICITO };
        },
    };
}

// --- CA-3: clasificación del deny -------------------------------------------

test('CA-3: un deny por falta de Allow se clasifica implicitDeny', () => {
    const r = v.classifyDeny(DENY_IMPLICITO);
    assert.equal(r.type, 'implicitDeny');
    assert.equal(r.action, 'dynamodb:DescribeContinuousBackups');
    assert.equal(r.policy, null, 'un implicitDeny no nombra policy: no hay Deny que editar');
});

test('CA-3: un Deny explícito se clasifica explicitDeny y nombra la policy', () => {
    const r = v.classifyDeny(DENY_EXPLICITO);
    assert.equal(r.type, 'explicitDeny');
    assert.equal(r.action, 'cloudtrail:LookupEvents');
    assert.match(r.policy, /policy\/IntraleKernelStore$/);
    // La distinción no es cosmética: con explicitDeny agregar permisos NO
    // destraba nada, y confundirlo manda al operador a una remediación inútil.
    assert.notEqual(r.type, 'implicitDeny');
});

test('CA-3: sin denegación devuelve none, y un error ajeno no se disfraza de deny', () => {
    assert.equal(v.classifyDeny('').type, 'none');
    assert.equal(v.classifyDeny('An error occurred (ResourceNotFoundException)').type, 'error');
});

test('CA-3: un NotFound NO es evidencia de permisos (no se clasifica como deny)', () => {
    // Trampa metodológica real: la primera corrida del PO contra un key ID
    // enmascarado devolvió NotFoundException y podía leerse como "no tengo
    // permiso". Son cosas distintas y el verificador no debe confundirlas.
    const r = v.classifyDeny('An error occurred (NotFoundException) when calling the DescribeKey operation');
    assert.equal(r.type, 'error');
    assert.equal(r.action, null);
});

// --- CA-3: prohibido declarar cumplido lo no observado ----------------------

test('CA-3: assertNoUnverifiedClaims aborta si un gap se marca como verificado', () => {
    const report = { gaps: [{ control: 'PITR', verified: true }] };
    assert.throws(() => v.assertNoUnverifiedClaims(report), /sin evidencia observada/);
    // Y el render se apoya en el mismo fusible: un verde falso nunca llega a un doc.
    assert.throws(() => v.renderMarkdown({ ...report, config: CFG_OK, perfil: 'x', tables: [] }), /sin evidencia observada/);
});

test('CA-3: los gaps del reporte real quedan en verified:null, nunca en true', async () => {
    const report = await v.verifyKernelTables({ runner: fakeAwsRunner(), config: CFG_OK });
    assert.ok(report.gaps.length > 0, 'debe sondear los controles no verificables');
    for (const g of report.gaps) {
        assert.notEqual(g.verified, true, `el control "${g.control}" no puede declararse cumplido`);
        assert.equal(g.verified, null);
    }
    const controles = report.gaps.map((g) => g.control).join(' | ');
    assert.match(controles, /PITR/);
    assert.match(controles, /CMK/);
    assert.match(controles, /CloudTrail/);
    assert.doesNotThrow(() => v.assertNoUnverifiedClaims(report));
});

test('CA-3: cada gap trae la remediación que corresponde a su tipo de deny', async () => {
    const report = await v.verifyKernelTables({ runner: fakeAwsRunner(), config: CFG_OK });
    const explicito = report.gaps.find((g) => g.deny === 'explicitDeny');
    const implicito = report.gaps.find((g) => g.deny === 'implicitDeny');
    assert.match(explicito.remediacion, /NO alcanza/);
    assert.match(implicito.remediacion, /agregando el permiso read-only/);
});

// --- CA-2: sólo se aprueba lo observado -------------------------------------

test('CA-2: una tabla ACTIVE con SSE KMS y deletion protection queda verificada', () => {
    const s = v.summarizeTable(describeTablePayload(), { tableName: 'intrale-kernel-state', region: 'us-east-2' });
    assert.equal(s.verified, true);
    assert.deepEqual(s.missing, []);
    assert.equal(s.status, 'ACTIVE');
    assert.equal(s.sse.type, 'KMS');
    assert.equal(s.deletionProtection, true);
});

test('CA-2: SSE administrado por AWS (sin SSEDescription) NO se aprueba', () => {
    // Una tabla sin `SSEDescription` está cifrada con la clave propia de DynamoDB,
    // que NO es lo que el criterio pide demostrar.
    const s = v.summarizeTable(describeTablePayload({ SSEDescription: undefined }));
    assert.equal(s.verified, false);
    assert.match(s.missing.join(' '), /SSEDescription\.Status esperado ENABLED/);
});

test('CA-2: deletion protection ausente se reporta "no observado", no false', () => {
    const payload = describeTablePayload();
    delete payload.Table.DeletionProtectionEnabled;
    const s = v.summarizeTable(payload);
    assert.equal(s.deletionProtection, null, 'ausente ≠ false: asumir el default sería inferir');
    assert.equal(s.verified, false);
    assert.match(s.missing.join(' '), /observado ausente/);
});

test('CA-2: una tabla que no está ACTIVE o con SSE distinto de KMS falla', () => {
    assert.equal(v.summarizeTable(describeTablePayload({ TableStatus: 'CREATING' })).verified, false);
    const aes = v.summarizeTable(describeTablePayload({
        SSEDescription: { Status: 'ENABLED', SSEType: 'AES256' },
    }));
    assert.equal(aes.verified, false);
    assert.match(aes.missing.join(' '), /SSEType esperado KMS/);
});

test('CA-2: describe-table sin Table => no existe, no verificada', () => {
    const s = v.summarizeTable({}, { tableName: 'intrale-kernel-state' });
    assert.equal(s.exists, false);
    assert.equal(s.verified, false);
});

test('CA-2: una tabla de otra región no se da por buena', () => {
    const s = v.summarizeTable(describeTablePayload(), { region: 'us-west-1' });
    assert.equal(s.verified, false);
    assert.match(s.missing.join(' '), /región esperada us-west-1/);
});

test('CA-2: si una tabla no existe el reporte global NO queda verificable', async () => {
    const runner = fakeAwsRunner({ tablaFaltante: 'intrale-kernel-coordination' });
    const report = await v.verifyKernelTables({ runner, config: CFG_OK });
    assert.equal(report.verificable, false);
    const coord = report.tables.find((t) => t.rol === 'coordinación');
    assert.equal(coord.exists, false);
});

// --- A09: redacción ---------------------------------------------------------

test('A09: la redacción borra el account id pero preserva región y recurso', () => {
    const out = v.redactAwsEvidence(`arn:aws:dynamodb:us-east-2:${ACCT}:table/intrale-kernel-state`);
    assert.ok(!out.includes(ACCT), 'el account id no puede quedar en la evidencia');
    assert.match(out, /<ACCT>/);
    // Sin región ni nombre de tabla la evidencia no probaría nada — por eso NO
    // se usa `redactSecretValue`, que borra el ARN entero.
    assert.match(out, /us-east-2/);
    assert.match(out, /table\/intrale-kernel-state/);
});

test('A09: el UUID de la CMK se trunca conservando el prefijo correlacionable', () => {
    const out = v.redactAwsEvidence(KEY_ARN);
    assert.ok(!out.includes('333344445555'), 'el UUID completo de la clave no se publica');
    assert.match(out, /key\/aaaa1111-<REDACTED>/);
});

test('A09: una credencial embebida se redacta aunque venga junto a un ARN', () => {
    const out = v.redactAwsEvidence(`user AKIAIOSFODNN7EXAMPLE en arn:aws:iam::${ACCT}:user/intrale-kernel-runtime`);
    assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'));
    assert.ok(!out.includes(ACCT));
});

test('A09: el reporte completo no filtra account id ni UUID de clave', async () => {
    const report = await v.verifyKernelTables({ runner: fakeAwsRunner(), config: CFG_OK });
    const dump = JSON.stringify(report);
    assert.ok(!dump.includes(ACCT), 'account id filtrado en el reporte');
    assert.ok(!dump.includes('333344445555'), 'UUID de CMK filtrado en el reporte');
    // El markdown se renderiza desde el mismo reporte ya redactado.
    assert.ok(!v.renderMarkdown(report).includes(ACCT));
});

// --- CA-7 / A03: allowlist read-only ----------------------------------------

test('CA-7: el runner rechaza cualquier comando que no sea de lectura', async () => {
    const spawnSpy = () => { throw new Error('no debería spawnear'); };
    const runner = v.createReadOnlyAwsRunner({ spawn: spawnSpy });
    // Aprovisionar es alcance de #5203, no de este módulo.
    await assert.rejects(
        () => runner.run(['dynamodb', 'create-table', '--table-name', 'x']),
        /fuera de la allowlist read-only/,
    );
    await assert.rejects(() => runner.run(['dynamodb', 'delete-table']), /allowlist/);
    await assert.rejects(() => runner.run(['dynamodb', 'update-continuous-backups']), /allowlist/);
    await assert.rejects(() => runner.run(['kms', 'create-key']), /allowlist/);
});

test('CA-7: la allowlist sólo contiene verbos de lectura', () => {
    for (const cmd of v.READONLY_COMMANDS) {
        assert.match(cmd, /^(dynamodb|kms|cloudtrail) (describe|list|get|lookup)-/, `verbo mutante en la allowlist: ${cmd}`);
    }
});

test('CA-7: la verificación real sólo emitió comandos de lectura', async () => {
    const runner = fakeAwsRunner();
    await v.verifyKernelTables({ runner, config: CFG_OK });
    assert.ok(runner.calls.length > 0);
    for (const call of runner.calls) {
        const verb = call.split(' ').slice(0, 2).join(' ');
        assert.ok(v.READONLY_COMMANDS.includes(verb), `comando no permitido: ${verb}`);
    }
});

test('A03: el spawn se hace sin shell y con args como array', async () => {
    let capturado = null;
    const fakeSpawn = (cmd, args, opts) => {
        capturado = { cmd, args, opts };
        return {
            stdout: { on: (_e, cb) => cb('{}') },
            stderr: { on: () => {} },
            on: (evt, cb) => { if (evt === 'close') cb(0); },
        };
    };
    const runner = v.createReadOnlyAwsRunner({ spawn: fakeSpawn, profile: 'kernel-runtime' });
    await runner.run(['dynamodb', 'describe-table', '--table-name', 'intrale-kernel-state']);
    assert.equal(capturado.cmd, 'aws');
    assert.equal(capturado.opts.shell, false, 'shell:true habilitaría inyección de comandos');
    assert.ok(Array.isArray(capturado.args));
    assert.deepEqual(capturado.args.slice(-4), ['--profile', 'kernel-runtime', '--output', 'json']);
});

// --- A05 / CA-4: config fail-closed y separación de tablas ------------------

test('A05: sin config no se verifica nada (fail-closed, sin hardcode)', () => {
    assert.throws(
        () => v.readKernelTablesConfig({ kernelConfig: {} }),
        /faltan claves de config/,
    );
    assert.throws(
        () => v.readKernelTablesConfig({ kernelConfig: { tableName: 'a', coordinationTableName: 'b' } }),
        /kernel\.region/,
    );
});

test('CA-4: dos tablas iguales es fail-closed (coordinación no hereda la inmutabilidad)', () => {
    assert.throws(
        () => v.readKernelTablesConfig({
            kernelConfig: { tableName: 'misma', coordinationTableName: 'misma', region: 'us-east-2' },
        }),
        /MISMA tabla/,
    );
});

test('CA-4: el verificador sondea el TTL de coordinación, no el de no-repudio', () => {
    const probes = v.buildGapProbes(CFG_OK, KEY_ARN);
    const ttl = probes.filter((p) => p.args[1] === 'describe-time-to-live');
    assert.equal(ttl.length, 1, 'el TTL sólo aplica a la tabla de coordinación');
    assert.ok(ttl[0].args.includes('intrale-kernel-coordination'));
    // La tabla de no-repudio NO debe tener TTL: un TTL ahí sería una ruta de
    // borrado sobre evidencia append-only.
    assert.ok(!ttl[0].args.includes('intrale-kernel-state'));
});

// --- CA-1 / CA-5: config.yaml real ------------------------------------------

test('CA-1: config.yaml real tiene las tres claves pobladas y tablas distintas', () => {
    const cfg = v.readKernelTablesConfig({ configPath: CONFIG_PATH });
    assert.ok(cfg.tableName.length > 0);
    assert.ok(cfg.coordinationTableName.length > 0);
    assert.ok(cfg.region.length > 0);
    assert.notEqual(cfg.tableName, cfg.coordinationTableName);
});

// #5208 — La aserción original de #5210 era `durable === false`, y era correcta
// MIENTRAS #5210/#5207 sólo preparaban infraestructura: poblar los nombres de
// tabla no podía encender nada. #5208 es la historia que ejecutó el cutover y
// encendió el switch con evidencia positiva (runbook §8), así que lo que hay que
// proteger ahora es otra cosa: que el encendido esté COMPLETO y que la ventana
// de cutover NO haya quedado abierta.
test('#5208: config.yaml real tiene kernel.durable encendido y la ventana de cutover CERRADA', () => {
    const cfg = v.readKernelTablesConfig({ configPath: CONFIG_PATH });
    assert.equal(cfg.durable, true, 'el cutover de #5208 dejó el camino durable encendido');

    // La ventana abierta es un falso verde permanente (runbook §5): dentro de
    // ella una degradación aborta el arranque, y fuera vuelve a ser best-effort.
    // Dejarla `true` en régimen deja el pipeline en mantenimiento para siempre.
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const m = raw.match(/^\s*cutover_window:\s*(\S+)/m);
    assert.ok(m, 'la clave `cutover_window` debe existir en config.yaml (la creó #5135)');
    assert.equal(m[1], 'false', 'la ventana de cutover tiene que quedar CERRADA al terminar');
});

test('CA-5: con durable:false el bootstrap resuelve por filesystem y no instancia el store', async () => {
    // Contra-prueba del riesgo real de #5210: teniendo `tableName` y `region`
    // poblados, ¿alcanza eso para que algo hable con DynamoDB? No: el único
    // switch es `durable`.
    //
    // #5208 — El `kernelConfig` se INYECTA en vez de leerse del config real.
    // Antes el test leía `readKernelConfig({})`, así que la propiedad que
    // verificaba ("con durable:false no se instancia el store") quedaba atada al
    // valor global del flag: al encenderlo, el test dejaba de probar su propio
    // invariante. Inyectándolo, la contra-prueba de #5210 sigue viva con el
    // cutover ya hecho.
    const bootstrap = require('../project-bootstrap');
    const real = v.readKernelTablesConfig({ configPath: CONFIG_PATH });
    assert.ok(real.tableName, 'la tabla está configurada…');

    let storeInstanciado = false;
    await bootstrap.durableRegisterProduct(
        { projectId: 'demo' },
        {},
        {
            kernelConfig: { durable: false, tableName: real.tableName, region: real.region },
            createKernelStore: () => { storeInstanciado = true; return {}; },
        },
    ).catch(() => {});
    assert.equal(storeInstanciado, false, 'durable:false NUNCA debe instanciar el store durable');
});
