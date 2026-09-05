'use strict';

// =============================================================================
// #5207 — Segunda pasada con el perfil admin de sólo lectura
//
// EL PROBLEMA QUE RESUELVE
// ------------------------
// El CA-2 del paraguas exige outputs redactados que PRUEBEN PITR, CMK y
// CloudTrail. El perfil `kernel-runtime` no puede leer ninguno de los tres, y
// está bien que no pueda: es mínimo privilegio. Pero eso dejaba el CA-2 sin
// forma de cerrarse por herramienta — se cerraba pegando comandos a mano.
//
// La segunda pasada lee esos mismos controles con `kernel.iamAdminProfile`, el
// perfil admin de SÓLO LECTURA que `kernel-iam-verify` ya usa para el drift.
//
// LO QUE ESTOS TESTS PROTEGEN
// ---------------------------
// Que abrir esta puerta NO haya aflojado el fail-closed. La regla de fondo sigue
// siendo la misma que trajo #5210: **nada se declara cumplido sin haberlo
// observado**. Lo único que cambió es que ahora hay una identidad legítima capaz
// de observarlo. Si el perfil admin falta, falla, o devuelve algo que no permite
// afirmar el control, el gap tiene que volver a `null` ("no sé").
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');

const tv = require('../kernel-table-verify.js');

const CFG = Object.freeze({
    tableName: 'tabla-no-repudio',
    coordinationTableName: 'tabla-coordinacion',
    region: 'us-east-2',
    durable: false,
    iamAdminProfile: 'perfil-admin',
});

// `describe-table` que el runtime SÍ puede leer.
function describeTableOk(nombre) {
    return JSON.stringify({
        Table: {
            TableName: nombre,
            TableStatus: 'ACTIVE',
            DeletionProtectionEnabled: true,
            SSEDescription: {
                Status: 'ENABLED',
                SSEType: 'KMS',
                KMSMasterKeyArn: 'arn:aws:kms:us-east-2:000000000000:key/9d18ba4b-f8ca-4b48-add3-12edf72569f8',
            },
        },
    });
}

const DENIED = {
    code: 255,
    stdout: '',
    stderr: 'AccessDeniedException: User: arn:aws:iam::000000000000:user/intrale-kernel-runtime '
        + 'is not authorized to perform: dynamodb:DescribeContinuousBackups because no identity-based policy allows it',
};

// Runner del runtime: lee las tablas, deniega todo lo demás (el caso real).
function runnerRuntime() {
    return {
        profile: 'kernel-runtime',
        run(args) {
            if (args[1] === 'describe-table') {
                return Promise.resolve({ code: 0, stdout: describeTableOk(args[3]), stderr: '' });
            }
            return Promise.resolve(DENIED);
        },
    };
}

// Runner admin configurable: devuelve el payload que se le indique por verbo.
function runnerAdmin(porVerbo, registro = []) {
    return {
        profile: 'perfil-admin',
        run(args) {
            registro.push(args.join(' '));
            const verbo = `${args[0]} ${args[1]}`;
            const payload = porVerbo[verbo];
            if (payload === undefined) return Promise.resolve(DENIED);
            return Promise.resolve({ code: 0, stdout: JSON.stringify(payload), stderr: '' });
        },
    };
}

const ADMIN_COMPLETO = {
    'dynamodb describe-continuous-backups': {
        ContinuousBackupsDescription: {
            ContinuousBackupsStatus: 'ENABLED',
            PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'ENABLED', RecoveryPeriodInDays: 35 },
        },
    },
    'dynamodb describe-time-to-live': { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } },
    'kms describe-key': { KeyMetadata: { KeyManager: 'CUSTOMER', KeyState: 'Enabled', Enabled: true } },
    'kms list-aliases': { Aliases: [{ AliasName: 'alias/intrale-kernel-store' }] },
};

// -----------------------------------------------------------------------------
// 1. El fail-closed sigue en pie
// -----------------------------------------------------------------------------

test('#5207 · sin perfil admin configurado, TODO sigue siendo gap no verificado', async () => {
    const report = await tv.verifyKernelTables({
        config: { ...CFG, iamAdminProfile: null },
        runner: runnerRuntime(),
    });
    assert.ok(report.gaps.length > 0);
    assert.ok(report.gaps.every((g) => g.verified !== true),
        'sin identidad que observe, ningún control puede darse por cumplido');
    assert.strictEqual(report.perfilAdmin, null);
});

test('#5207 · si el perfil admin también deniega, el control vuelve a "no sé"', async () => {
    const report = await tv.verifyKernelTables({
        config: CFG,
        runner: runnerRuntime(),
        adminRunner: runnerAdmin({}), // deniega todo
    });
    const pitr = report.gaps.find((g) => g.key === 'pitr-no-repudio');
    assert.strictEqual(pitr.verified, null, 'un AccessDenied no puede volverse un verde');
    assert.strictEqual(pitr.evidencia, null);
});

test('#5207 · un output válido pero SIN el campo del control no alcanza para cerrarlo', async () => {
    // El comando devuelve 200 y JSON parseable, pero no trae el estado de PITR.
    // Un "salió bien" no es lo mismo que "observé el control".
    const report = await tv.verifyKernelTables({
        config: CFG,
        runner: runnerRuntime(),
        adminRunner: runnerAdmin({ 'dynamodb describe-continuous-backups': { ContinuousBackupsDescription: {} } }),
    });
    const pitr = report.gaps.find((g) => g.key === 'pitr-no-repudio');
    assert.strictEqual(pitr.verified, null);
});

test('#5207 · el fusible sigue rechazando un verde plantado a mano', () => {
    // Alguien edita el JSON y pone verified:true sin evidencia. Debe abortar.
    assert.throws(
        () => tv.assertNoUnverifiedClaims({
            gaps: [{ control: 'PITR', verified: true, evidencia: null, observadoCon: null }],
        }),
        /sin evidencia observada/,
    );
});

test('#5207 · el fusible acepta un verde que SÍ trae evidencia e identidad', () => {
    assert.strictEqual(
        tv.assertNoUnverifiedClaims({
            gaps: [{
                control: 'PITR',
                verified: true,
                evidencia: { pointInTimeRecovery: 'ENABLED' },
                observadoCon: 'perfil-admin',
            }],
        }),
        true,
    );
});

// -----------------------------------------------------------------------------
// 2. La segunda pasada cierra lo que el CA-2 pide
// -----------------------------------------------------------------------------

test('#5207 · con perfil admin se cierran PITR, TTL y propiedad de la CMK', async () => {
    const report = await tv.verifyKernelTables({
        config: CFG,
        runner: runnerRuntime(),
        adminRunner: runnerAdmin(ADMIN_COMPLETO),
    });

    const cerrados = report.gaps.filter((g) => g.verified === true).map((g) => g.key).sort();
    assert.deepStrictEqual(cerrados, [
        'cmk-alias', 'cmk-propiedad', 'pitr-coordinacion', 'pitr-no-repudio', 'ttl-coordinacion',
    ]);

    const pitr = report.gaps.find((g) => g.key === 'pitr-no-repudio');
    assert.deepStrictEqual(pitr.evidencia, { pointInTimeRecovery: 'ENABLED', periodoRetencionDias: 35 });
    assert.strictEqual(pitr.observadoCon, 'perfil-admin');
});

test('#5207 · la CMK se prueba CUSTOMER: es lo que describe-table no puede distinguir', async () => {
    const report = await tv.verifyKernelTables({
        config: CFG,
        runner: runnerRuntime(),
        adminRunner: runnerAdmin(ADMIN_COMPLETO),
    });
    const cmk = report.gaps.find((g) => g.key === 'cmk-propiedad');
    assert.strictEqual(cmk.evidencia.keyManager, 'CUSTOMER',
        'sin este dato, una clave aws/dynamodb pasaría por CMK propia');
});

test('#5207 · CloudTrail NO se cierra acá (lo prueba kernel-cloudtrail-provision --verify)', async () => {
    const report = await tv.verifyKernelTables({
        config: CFG,
        runner: runnerRuntime(),
        adminRunner: runnerAdmin({ ...ADMIN_COMPLETO, 'cloudtrail lookup-events': { Events: [] } }),
    });
    const ct = report.gaps.find((g) => g.key === 'cloudtrail');
    assert.strictEqual(ct.verified, null,
        'un lookup-events con 200 probaría muchísimo menos que la postura del destino');
});

test('#5207 · el comando publicado reproduce la evidencia (perfil admin, no runtime)', async () => {
    const report = await tv.verifyKernelTables({
        config: CFG,
        runner: runnerRuntime(),
        adminRunner: runnerAdmin(ADMIN_COMPLETO),
    });
    const pitr = report.gaps.find((g) => g.key === 'pitr-no-repudio');
    assert.match(pitr.comandoObservacion, /--profile perfil-admin$/,
        'publicar el perfil runtime mandaría a reproducirlo con una identidad que da AccessDenied');
});

// -----------------------------------------------------------------------------
// 3. Redacción y render
// -----------------------------------------------------------------------------

test('#5207 · la evidencia observada sale redactada (sin account id de 12 dígitos)', async () => {
    const report = await tv.verifyKernelTables({
        config: CFG,
        runner: runnerRuntime(),
        adminRunner: runnerAdmin({
            ...ADMIN_COMPLETO,
            'kms list-aliases': { Aliases: [{ AliasName: 'arn:aws:kms:us-east-2:000000000000:alias/x' }] },
        }),
    });
    const alias = report.gaps.find((g) => g.key === 'cmk-alias');
    assert.ok(!/\b\d{12}\b/.test(JSON.stringify(alias.evidencia)),
        `account id sin redactar: ${JSON.stringify(alias.evidencia)}`);
});

test('#5207 · el render separa lo verificado de lo que sigue siendo gap', async () => {
    const report = await tv.verifyKernelTables({
        config: CFG,
        runner: runnerRuntime(),
        adminRunner: runnerAdmin(ADMIN_COMPLETO),
    });
    const md = tv.renderMarkdown(report);

    assert.match(md, /Verificado con el perfil admin de sólo lectura/);
    assert.match(md, /pointInTimeRecovery=`ENABLED`/);
    // CloudTrail y rotación quedan como gap: no se los puede leer ni con admin.
    assert.match(md, /Gap de verificación — NO verificado/);
    assert.match(md, /Rastro de auditoría \(CloudTrail\)/);
});

test('#5207 · el reporte cuenta cuántos controles quedaron sin observar', async () => {
    const report = await tv.verifyKernelTables({
        config: CFG,
        runner: runnerRuntime(),
        adminRunner: runnerAdmin(ADMIN_COMPLETO),
    });
    // Quedan CloudTrail y rotación de la CMK.
    assert.strictEqual(report.gapsPendientes, 2);
    assert.strictEqual(report.gapsPendientes, report.gaps.filter((g) => g.verified !== true).length);
});

// -----------------------------------------------------------------------------
// 4. observeGapControl aislada
// -----------------------------------------------------------------------------

test('#5207 · observeGapControl devuelve null ante basura, no un objeto vacío', () => {
    for (const entrada of [null, undefined, 'texto', 42, {}]) {
        assert.strictEqual(tv.observeGapControl('pitr-no-repudio', entrada), null);
    }
});

test('#5207 · observeGapControl reporta el estado observado sin juzgarlo', () => {
    // PITR DISABLED en coordinación es la postura correcta (tabla efímera).
    // La función reporta el hecho; el juicio es del criterio, con la postura de
    // cada tabla a la vista. Devolver `null` acá escondería el dato.
    const r = tv.observeGapControl('pitr-coordinacion', {
        ContinuousBackupsDescription: {
            PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' },
        },
    });
    assert.deepStrictEqual(r, { pointInTimeRecovery: 'DISABLED', periodoRetencionDias: null });
});

test('#5207 · una key desconocida nunca se da por observada', () => {
    assert.strictEqual(tv.observeGapControl('control-inventado', { lo: 'que sea' }), null);
});
