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

// Runner admin configurable. La clave puede ser el verbo (`kms describe-key`) o
// el verbo calificado por tabla (`dynamodb describe-continuous-backups|tabla-x`):
// las dos tablas NO tienen la misma postura esperada —no-repudio exige PITR,
// coordinación exige que NO lo tenga— así que un fixture que devuelva lo mismo
// para ambas no representa ningún ambiente real.
function runnerAdmin(porVerbo, registro = []) {
    return {
        profile: 'perfil-admin',
        run(args) {
            registro.push(args.join(' '));
            const verbo = `${args[0]} ${args[1]}`;
            const idx = args.indexOf('--table-name');
            const calificado = idx !== -1 ? `${verbo}|${args[idx + 1]}` : null;
            const payload = calificado !== null && porVerbo[calificado] !== undefined
                ? porVerbo[calificado]
                : porVerbo[verbo];
            if (payload === undefined) return Promise.resolve(DENIED);
            return Promise.resolve({ code: 0, stdout: JSON.stringify(payload), stderr: '' });
        },
    };
}

const pitr = (estado, dias = null) => ({
    ContinuousBackupsDescription: {
        ContinuousBackupsStatus: 'ENABLED',
        PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: estado, RecoveryPeriodInDays: dias },
    },
});

// El ambiente que CUMPLE, con la postura documentada de cada tabla:
// no-repudio con PITR `ENABLED` (35 días), coordinación con PITR y TTL
// `DISABLED` a propósito (es efímera: restaurarla reinstalaría claims ya
// liberados). Ver `docs/pipeline/kernel-cutover-evidencia-5207.md` §4.
const ADMIN_COMPLETO = {
    'dynamodb describe-continuous-backups|tabla-no-repudio': pitr('ENABLED', 35),
    'dynamodb describe-continuous-backups|tabla-coordinacion': pitr('DISABLED'),
    'dynamodb describe-time-to-live': { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } },
    'kms describe-key': { KeyMetadata: { KeyManager: 'CUSTOMER', KeyState: 'Enabled', Enabled: true } },
    'kms list-aliases': { Aliases: [{ AliasName: 'alias/intrale-kernel-store' }] },
    'kms get-key-rotation-status': { KeyRotationEnabled: true },
};

// El ambiente ADVERSO del rechazo rev-1: los tres controles del CA-2 en rojo.
// PITR apagado JUSTO en la tabla de no-repudio, la clave administrada por AWS
// (`aws/dynamodb`) en vez de una CMK propia, y la rotación deshabilitada.
const ADMIN_ADVERSO = {
    'dynamodb describe-continuous-backups|tabla-no-repudio': pitr('DISABLED'),
    'dynamodb describe-continuous-backups|tabla-coordinacion': pitr('DISABLED'),
    'dynamodb describe-time-to-live': { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } },
    'kms describe-key': { KeyMetadata: { KeyManager: 'AWS', KeyState: 'Enabled', Enabled: true } },
    'kms list-aliases': { Aliases: [{ AliasName: 'alias/aws/dynamodb' }] },
    'kms get-key-rotation-status': { KeyRotationEnabled: false },
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

test('#5207 · el fusible acepta un verde con evidencia, identidad Y postura cumplida', () => {
    assert.strictEqual(
        tv.assertNoUnverifiedClaims({
            gaps: [{
                control: 'PITR',
                verified: true,
                evidencia: { pointInTimeRecovery: 'ENABLED' },
                observadoCon: 'perfil-admin',
                postura: { esperado: 'PointInTimeRecoveryStatus = ENABLED', cumple: true },
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
        'cmk-alias', 'cmk-propiedad', 'cmk-rotacion',
        'pitr-coordinacion', 'pitr-no-repudio', 'ttl-coordinacion',
    ]);

    const noRepudio = report.gaps.find((g) => g.key === 'pitr-no-repudio');
    assert.deepStrictEqual(noRepudio.evidencia, { pointInTimeRecovery: 'ENABLED', periodoRetencionDias: 35 });
    assert.strictEqual(noRepudio.observadoCon, 'perfil-admin');
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
    assert.match(md, /Gap de verificación — NO verificado/);
    // CloudTrail sigue nombrado en el artefacto, pero en la sección de delegados
    // (#5207 rebote rev-2): no es un gap de observación.
    assert.match(md, /Rastro de auditoría \(CloudTrail\)/);
    assert.match(md, /### Delegado a otra herramienta/);
});

test('#5207 · el reporte cuenta cuántos controles quedaron sin observar', async () => {
    const report = await tv.verifyKernelTables({
        config: CFG,
        runner: runnerRuntime(),
        adminRunner: runnerAdmin(ADMIN_COMPLETO),
    });
    // Todo lo que este verificador resuelve quedó cerrado. CloudTrail no cuenta:
    // está delegado, y contarlo hacía `ca2Cerrado` imposible (rebote rev-2).
    assert.strictEqual(report.gapsPendientes, 0);
    assert.strictEqual(
        report.gapsPendientes,
        report.gaps.filter((g) => g.estado !== 'delegado' && g.verified !== true).length,
    );
    assert.strictEqual(report.posturasIncumplidas, 0);
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

// -----------------------------------------------------------------------------
// 5. Rebote rev-1 — observar un control NO es demostrarlo
//
// El review reprodujo el escenario adverso EJECUTANDO el módulo: un ambiente con
// PITR `DISABLED` en la tabla de NO-REPUDIO, la clave `aws/dynamodb` en vez de
// una CMK propia y la rotación apagada —los tres controles del CA-2 en rojo—
// salía con `gapsPendientes: 1`, todos los controles en `verified: true`, el
// fusible sin tirar, y un markdown que rotulaba el ambiente como demostrado.
//
// Es el modo de falla que #5210 cerró ("no pude verlo" ≠ "está bien") corrido un
// casillero. Pesa más porque este artefacto es lo que firma un operador.
// -----------------------------------------------------------------------------

async function reporteAdverso() {
    return tv.verifyKernelTables({
        config: CFG,
        runner: runnerRuntime(),
        adminRunner: runnerAdmin(ADMIN_ADVERSO),
    });
}

test('#5207 rev-1 · PITR DISABLED en la tabla de NO-REPUDIO no cierra el control', async () => {
    const report = await reporteAdverso();
    const g = report.gaps.find((x) => x.key === 'pitr-no-repudio');
    assert.strictEqual(g.verified, false, 'leerlo no alcanza: el valor leído tiene que cumplir');
    assert.strictEqual(g.estado, 'observado-incumple');
    assert.strictEqual(g.postura.cumple, false);
    assert.match(g.postura.esperado, /ENABLED/);
    // La evidencia se conserva: el veredicto cambia, el dato observado no.
    assert.strictEqual(g.evidencia.pointInTimeRecovery, 'DISABLED');
});

test('#5207 rev-1 · la clave aws/dynamodb no pasa por CMK propia ni por sus alias', async () => {
    const report = await reporteAdverso();
    const propiedad = report.gaps.find((x) => x.key === 'cmk-propiedad');
    const alias = report.gaps.find((x) => x.key === 'cmk-alias');
    assert.strictEqual(propiedad.verified, false, 'KeyManager=AWS es exactamente lo que el CA-2 descarta');
    assert.strictEqual(alias.verified, false, '`alias/aws/dynamodb` no es un alias propio del kernel');
});

test('#5207 rev-1 · la rotación deshabilitada no cierra el control de rotación', async () => {
    const report = await reporteAdverso();
    const g = report.gaps.find((x) => x.key === 'cmk-rotacion');
    assert.strictEqual(g.verified, false);
    assert.strictEqual(g.evidencia.rotacionAutomatica, false);
});

test('#5207 rev-1 · un ambiente que falla el CA-2 NO produce gapsPendientes casi en cero', async () => {
    const report = await reporteAdverso();
    // 4 incumplen: PITR no-repudio, CMK propiedad, CMK alias, rotación.
    // CloudTrail NO suma: está delegado, no es un pendiente de este módulo.
    assert.strictEqual(report.posturasIncumplidas, 4);
    assert.strictEqual(report.gapsPendientes, 4,
        'el número que decide si el CA-2 está cerrado tiene que contar los incumplimientos');
    assert.strictEqual(report.ca2Cerrado, false);
});

test('#5207 rev-1 · el markdown de un ambiente en rojo NO dice que el control está demostrado', async () => {
    const md = tv.renderMarkdown(await reporteAdverso());
    assert.match(md, /INCUMPLE la postura esperada/);
    assert.match(md, /\*\*CA-2 NO cerrado:\*\*/);
    // La sección de verificados no puede listar un control que incumple.
    const seccionVerificados = md.split('### Observado e INCUMPLE')[0];
    assert.ok(!/keyManager=`AWS`/.test(seccionVerificados),
        'una CMK administrada por AWS no puede aparecer entre los controles verificados');
    assert.ok(!/rotacionAutomatica=`false`/.test(seccionVerificados),
        'la rotación apagada no puede aparecer entre los controles verificados');
});

test('#5207 rev-1 · el ambiente que cumple sigue cerrando el CA-2', async () => {
    // El contrapeso del test anterior: endurecer el veredicto no puede volverlo
    // imposible de satisfacer. Con la postura documentada de cada tabla, todo lo
    // observable cierra y sólo queda CloudTrail (que se prueba en otro módulo).
    const report = await tv.verifyKernelTables({
        config: CFG, runner: runnerRuntime(), adminRunner: runnerAdmin(ADMIN_COMPLETO),
    });
    assert.strictEqual(report.posturasIncumplidas, 0);
    assert.strictEqual(report.gaps.filter((g) => g.estado === 'observado-cumple').length, 6);
    const md = tv.renderMarkdown(report);
    assert.ok(!/INCUMPLE la postura esperada/.test(md));
});

test('#5207 rev-1 · un control observado SIN postura declarada tampoco se cierra', async () => {
    // Fail-closed sobre el propio catálogo: si mañana se agrega un probe y se
    // olvida su postura, el default es NO darlo por cumplido.
    assert.strictEqual(tv.evaluarPostura('control-sin-postura', { algo: 1 }), null);
    const gap = { key: 'control-sin-postura', control: 'X' };
    assert.throws(
        () => tv.assertNoUnverifiedClaims({ gaps: [{ ...gap, verified: true, evidencia: { a: 1 }, observadoCon: 'admin' }] }),
        /NO DECLARADA/,
    );
});

// -----------------------------------------------------------------------------
// 6. Rebote rev-2 — `ca2Cerrado` tiene que poder ser `true`
//
// El review del 2026-09-05 ejecutó el módulo sobre el ambiente PERFECTO (PITR
// ENABLED en no-repudio, DISABLED en coordinación, TTL DISABLED, CMK CUSTOMER
// con alias propio y rotación activa, ambas tablas OK) y obtuvo:
//
//     verificable: true · ca2Cerrado: FALSE · gapsPendientes: 1
//
// `ca2Cerrado` era una constante `false`: `buildGapProbes` sondeaba `cloudtrail`,
// `observeGapControl` caía en `default: return null` para esa key y `POSTURAS` no
// la declaraba, así que el control quedaba `no-observado` PARA SIEMPRE. El
// artefacto que firma un operador decía "CA-2 NO cerrado" con todo en verde, y
// la rama `**CA-2 cerrado:**` del markdown era código muerto.
//
// La causa de fondo era una distinción que faltaba: "no pude observarlo" ≠ "no
// me toca observarlo acá". CloudTrail SE PRUEBA, con
// `kernel-cloudtrail-provision --verify` (11 controles de postura del destino),
// como documenta el propio PR. Ahora es un control DELEGADO: fuera del cómputo,
// con sección propia, y sin poder cerrarse acá.
// -----------------------------------------------------------------------------

test('#5207 rev-2 · el ambiente que cumple TODAS las posturas cierra el CA-2', async () => {
    // El caso positivo que era incubrible: si este test no puede pasar, el
    // booleano de cierre no significa nada.
    const report = await tv.verifyKernelTables({
        config: CFG, runner: runnerRuntime(), adminRunner: runnerAdmin(ADMIN_COMPLETO),
    });
    assert.strictEqual(report.verificable, true);
    assert.strictEqual(report.gapsPendientes, 0);
    assert.strictEqual(report.posturasIncumplidas, 0);
    assert.strictEqual(report.ca2Cerrado, true,
        'un booleano de cierre que nunca puede ser true reproduce la desalineación que vino a cerrar');
});

test('#5207 rev-2 · el markdown del ambiente que cumple emite el bloque CA-2 cerrado', async () => {
    const report = await tv.verifyKernelTables({
        config: CFG, runner: runnerRuntime(), adminRunner: runnerAdmin(ADMIN_COMPLETO),
    });
    const md = tv.renderMarkdown(report);
    assert.match(md, /\*\*CA-2 cerrado:\*\*/, 'la rama de cierre del render no puede ser código muerto');
    assert.ok(!/\*\*CA-2 NO cerrado:\*\*/.test(md));
    // El cierre no se declara total: lo delegado sigue debiendo su prueba.
    assert.match(md, /control\(es\) delegado\(s\) a otra herramienta/);
});

test('#5207 rev-2 · CloudTrail queda en estado delegado, no en gap de observación', async () => {
    const report = await tv.verifyKernelTables({
        config: CFG, runner: runnerRuntime(), adminRunner: runnerAdmin(ADMIN_COMPLETO),
    });
    const ct = report.gaps.find((g) => g.key === 'cloudtrail');
    assert.strictEqual(ct.estado, 'delegado');
    assert.strictEqual(ct.verified, null, 'delegar no es declarar cumplido');
    assert.match(ct.delegadoA.herramienta, /kernel-cloudtrail-provision\.js --verify/);
    // La remediación apunta a la herramienta, no al texto "Sin clasificar".
    assert.match(ct.remediacion, /kernel-cloudtrail-provision\.js --verify/);
    assert.ok(!/Sin clasificar/.test(ct.remediacion));
});

test('#5207 rev-2 · el control delegado no se sondea contra AWS', async () => {
    // Correr `lookup-events` para tirar el resultado publicaba `deny: 'none'`
    // con remediación de permisos sobre un comando que había salido 200.
    const llamadasRuntime = [];
    const runner = {
        profile: 'kernel-runtime',
        run(args) {
            llamadasRuntime.push(args.join(' '));
            if (args[1] === 'describe-table') {
                return Promise.resolve({ code: 0, stdout: describeTableOk(args[3]), stderr: '' });
            }
            return Promise.resolve(DENIED);
        },
    };
    const llamadasAdmin = [];
    await tv.verifyKernelTables({
        config: CFG, runner, adminRunner: runnerAdmin(ADMIN_COMPLETO, llamadasAdmin),
    });
    assert.ok(!llamadasRuntime.some((c) => c.includes('lookup-events')),
        'el runtime no debe gastar una llamada cuyo resultado se descarta');
    assert.ok(!llamadasAdmin.some((c) => c.includes('lookup-events')),
        'el perfil admin tampoco: el control se prueba en la otra herramienta');
});

test('#5207 rev-2 · la tabla de gaps NO lista un control delegado', async () => {
    const md = tv.renderMarkdown(await tv.verifyKernelTables({
        config: CFG, runner: runnerRuntime(), adminRunner: runnerAdmin(ADMIN_COMPLETO),
    }));
    // Sólo el cuerpo de la sección: el bloque de cierre que viene después SÍ
    // nombra al delegado a propósito (no se declara un cierre total).
    const seccionGap = md.split('### Gap de verificación')[1].split('**CA-2')[0];
    assert.ok(!/CloudTrail/.test(seccionGap),
        'la leyenda "ningún control de esta tabla está verificado" no puede aplicarle a un control que se prueba en otro lado');
    assert.match(seccionGap, /Sin gaps de observación/);
    // Y aparece en su sección propia, antes del gap.
    assert.match(md.split('### Gap de verificación')[0], /### Delegado a otra herramienta[\s\S]*CloudTrail/);
});

test('#5207 rev-2 · el fusible aborta si alguien marca un delegado como cerrado', () => {
    assert.throws(
        () => tv.assertNoUnverifiedClaims({
            gaps: [{
                control: 'Rastro de auditoría (CloudTrail)',
                estado: 'delegado',
                verified: true,
                evidencia: { events: 1 },
                observadoCon: 'perfil-admin',
                postura: { esperado: 'x', cumple: true },
                delegadoA: { herramienta: 'node .pipeline/lib/kernel-cloudtrail-provision.js --verify' },
            }],
        }),
        /está delegado/,
    );
});

test('#5207 rev-2 · un comando que salió 0 sin el campo del control se distingue de un deny', async () => {
    // El síntoma derivado del rechazo: `deny: 'none'`, `detalle: null` y una
    // remediación que mandaba a "revisar el mensaje crudo" que no existía.
    const report = await tv.verifyKernelTables({
        config: CFG,
        runner: runnerRuntime(),
        adminRunner: runnerAdmin({
            ...ADMIN_COMPLETO,
            // 200 con JSON válido, pero sin `TimeToLiveStatus`.
            'dynamodb describe-time-to-live': { TimeToLiveDescription: {} },
        }),
    });
    const ttl = report.gaps.find((g) => g.key === 'ttl-coordinacion');
    assert.strictEqual(ttl.verified, null, 'un HTTP 200 no es una observación: el fail-closed no se toca');
    assert.strictEqual(ttl.estado, 'observado-sin-lectura');
    assert.match(ttl.remediacion, /output NO trae el campo/);
    assert.ok(!/Sin clasificar/.test(ttl.remediacion),
        '"el comando anduvo pero no resuelve el control" no puede leerse como "no pude leerlo"');
    // Y sigue contando como pendiente: no cerrarlo es el default.
    assert.strictEqual(report.ca2Cerrado, false);
    // El `deny` publicado es el de la sonda del RUNTIME; quien llegó a correr el
    // comando fue el admin. Sin decirlo, `implicitDeny` al lado de "corrió sin
    // error" se lee como una contradicción del artefacto.
    assert.strictEqual(ttl.corrioSinObservarCon, 'perfil-admin');
    const md = tv.renderMarkdown(report);
    assert.match(md, /el comando salió 0 con `perfil-admin`, pero el output no trae el campo del control/);
});

test('#5207 rev-2 · si el runtime no puede leer el control, el estado sigue siendo no-observado', async () => {
    // Contraprueba del test anterior: el gap clásico de #5210 no se disfraza de
    // "salió 0 sin el campo".
    const report = await tv.verifyKernelTables({
        config: CFG,
        runner: runnerRuntime(),
        adminRunner: runnerAdmin({}), // deniega todo
    });
    const pitr = report.gaps.find((g) => g.key === 'pitr-no-repudio');
    assert.strictEqual(pitr.estado, 'no-observado');
    assert.match(pitr.remediacion, /Falta un Allow|Deny explícito/);
});

test('#5207 rev-2 · el reporte publica qué controles quedaron delegados y a qué herramienta', async () => {
    const report = await tv.verifyKernelTables({
        config: CFG, runner: runnerRuntime(), adminRunner: runnerAdmin(ADMIN_COMPLETO),
    });
    assert.deepStrictEqual(report.controlesDelegados.map((d) => d.key), ['cloudtrail']);
    assert.match(report.controlesDelegados[0].herramienta, /kernel-cloudtrail-provision\.js --verify/);
    // Delegar tiene que ser visible en el JSON: si no, "no está" y "lo prueba
    // otro" se vuelven indistinguibles para quien audita el artefacto.
    assert.ok(report.controlesDelegados[0].porQue.length > 0);
});

test('#5207 rev-2 · cuentaComoPendiente excluye delegados y nada más', () => {
    assert.strictEqual(tv.cuentaComoPendiente({ estado: 'delegado', verified: null }), false);
    assert.strictEqual(tv.cuentaComoPendiente({ estado: 'no-observado', verified: null }), true);
    assert.strictEqual(tv.cuentaComoPendiente({ estado: 'observado-sin-lectura', verified: null }), true);
    assert.strictEqual(tv.cuentaComoPendiente({ estado: 'observado-incumple', verified: false }), true);
    assert.strictEqual(tv.cuentaComoPendiente({ estado: 'observado-sin-postura', verified: false }), true);
    assert.strictEqual(tv.cuentaComoPendiente({ estado: 'observado-cumple', verified: true }), false);
});

test('#5207 rev-2 · un delegado nuevo no se cuela sin declarar su herramienta', () => {
    // Fail-closed sobre el propio catálogo: el mecanismo saca controles del
    // cómputo del CA-2, así que cada delegación tiene que decir dónde se prueba
    // y por qué. Un `delegadoA` vacío sería una exención silenciosa.
    for (const [key, d] of Object.entries(tv.CONTROLES_DELEGADOS)) {
        assert.ok(d.herramienta && d.herramienta.trim().length > 0, `${key} sin herramienta`);
        assert.ok(d.porQue && d.porQue.trim().length > 20, `${key} sin justificación`);
    }
    // Y el probe delegado tiene que apuntar al catálogo, no a un literal suelto.
    const probes = tv.buildGapProbes(
        { tableName: 't', coordinationTableName: 'c', region: 'us-east-2' },
        null,
    );
    const ct = probes.find((p) => p.key === 'cloudtrail');
    assert.strictEqual(ct.delegadoA, tv.CONTROLES_DELEGADOS.cloudtrail);
});

test('#5207 rev-1 · un alias propio que contiene "/aws/" más adentro NO se confunde con uno de AWS', () => {
    // El anclado importa: `alias/aws/dynamodb` es de AWS, `alias/intrale/aws/x` no.
    assert.strictEqual(tv.evaluarPostura('cmk-alias', { aliases: ['alias/aws/dynamodb'] }).cumple, false);
    assert.strictEqual(tv.evaluarPostura('cmk-alias', { aliases: ['alias/intrale/aws/kernel'] }).cumple, true);
    // También en forma de ARN, que es como puede venir de `list-aliases`.
    assert.strictEqual(
        tv.evaluarPostura('cmk-alias', { aliases: ['arn:aws:kms:us-east-2:<ACCT>:alias/aws/dynamodb'] }).cumple,
        false,
    );
});
