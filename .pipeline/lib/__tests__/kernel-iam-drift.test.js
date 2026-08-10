'use strict';

// =============================================================================
// kernel-iam-drift.test.js — #5211, rebote de la fase `verificacion`
//
// POR QUÉ EXISTE ESTA SUITE
// -------------------------
// El entregable de #5211 rebotó porque su evidencia afirmaba un estado de AWS
// que AWS no tenía. La matriz declaraba que TODO el control plane estaba en
// `implicitDeny`; tres probes crudos contra la cuenta real devolvían
// `explicit deny in an identity-based policy: policy/IntraleKernelStore`.
//
// La causa raíz no fue un typo. Fue que el estado aplicado se DEDUJO leyendo el
// artefacto de `origin/main` en lugar de LEERLO de AWS, y la deducción se
// escribió a mano en dos lugares (el `.md` y `CONTROL_PLANE_PROBES`). La policy
// adjunta resultó ser un documento distinto —con un catch-all
// `DenyEverythingOutsideKernelTables` por `NotResource`— que el artefacto no
// modelaba en absoluto.
//
// Esta suite cierra la clase de bug, no el caso puntual:
//
//   1. El evaluador se ancla a OBSERVACIONES REALES (`OBSERVACIONES_AWS`), no a
//      lo que el artefacto dice que debería pasar.
//   2. `diffPolicyDocuments` detecta la dirección PELIGROSA del drift: statements
//      vigentes que aplicar el artefacto borraría.
//   3. Ningún resultado de control plane puede volver a estar hardcodeado.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    CONTROL_PLANE_PROBES,
    OUTCOME,
    VEREDICTO,
    evaluateExpectation,
    iamMatch,
    classifyFromPolicyDocument,
    maskPolicyDocument,
    diffPolicyDocuments,
    fetchAppliedPolicy,
    resolveResourceRef,
    loadArtifactPolicy,
} = require('../kernel-iam-verify');

const APLICADA = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, 'fixtures', 'kernel-iam-applied-v3.json'), 'utf8',
));

const ARN_NO_REPUDIO = 'arn:aws:dynamodb:REGION:ACCOUNT:table/TABLE';
const ARN_COORD = 'arn:aws:dynamodb:REGION:ACCOUNT:table/COORD_TABLE';
const ARN_CMK = 'arn:aws:kms:REGION:ACCOUNT:key/CMK_KEY_ID';
const ARN_TABLA_AJENA = 'arn:aws:dynamodb:REGION:ACCOUNT:table/otra-tabla-cualquiera';
const ARN_USER_RUNTIME = 'arn:aws:iam::ACCOUNT:user/intrale-kernel-runtime';

// ---------------------------------------------------------------------------
// El ancla empírica
// ---------------------------------------------------------------------------

// Cada fila se OBSERVÓ ejecutando el AWS CLI con el perfil `kernel-runtime`
// contra la cuenta real el 2026-08-06, y se transcribió del mensaje de error.
// AWS distingue las dos formas en el texto:
//   - "with an explicit deny in an identity-based policy"  → explicitDeny
//   - "because no identity-based policy allows the ... action" → implicitDeny
//
// Si el evaluador deja de reproducir alguna de estas filas, o modela mal el
// catch-all, esta suite falla. Es el test que faltaba: la versión anterior no
// tenía NADA que confrontara la evidencia declarada contra AWS.
const OBSERVACIONES_AWS = Object.freeze([
    // --- el par que lo explica todo -----------------------------------------
    // La MISMA acción, distinto recurso, distinto resultado. Un probe apuntado
    // sólo a la tabla ajena habría reportado el control como verificado.
    {
        action: 'dynamodb:UpdateContinuousBackups',
        resource: ARN_NO_REPUDIO,
        esperado: OUTCOME.IMPLICIT_DENY,
        nota: 'apagar PITR sobre la EVIDENCIA: hoy sólo implicitDeny',
    },
    {
        action: 'dynamodb:UpdateContinuousBackups',
        resource: ARN_TABLA_AJENA,
        esperado: OUTCOME.EXPLICIT_DENY,
        nota: 'la misma acción fuera de alcance: explicitDeny por el catch-all',
    },

    // --- control plane de DynamoDB -------------------------------------------
    { action: 'dynamodb:DeleteTable', resource: ARN_TABLA_AJENA, esperado: OUTCOME.EXPLICIT_DENY },
    { action: 'dynamodb:UpdateTable', resource: ARN_TABLA_AJENA, esperado: OUTCOME.EXPLICIT_DENY },
    { action: 'dynamodb:CreateTable', resource: ARN_NO_REPUDIO, esperado: OUTCOME.IMPLICIT_DENY },
    { action: 'dynamodb:DescribeContinuousBackups', resource: ARN_NO_REPUDIO, esperado: OUTCOME.IMPLICIT_DENY },
    // ListTables no admite permisos a nivel de recurso; AWS reporta `table/*`.
    {
        action: 'dynamodb:ListTables',
        resource: 'arn:aws:dynamodb:REGION:ACCOUNT:table/*',
        esperado: OUTCOME.EXPLICIT_DENY,
    },

    // --- IAM ------------------------------------------------------------------
    { action: 'iam:ListAttachedUserPolicies', resource: ARN_USER_RUNTIME, esperado: OUTCOME.EXPLICIT_DENY },
    { action: 'iam:AttachUserPolicy', resource: ARN_USER_RUNTIME, esperado: OUTCOME.EXPLICIT_DENY },
    { action: 'iam:CreateAccessKey', resource: ARN_USER_RUNTIME, esperado: OUTCOME.EXPLICIT_DENY },

    // --- KMS ------------------------------------------------------------------
    { action: 'kms:CreateKey', resource: '*', esperado: OUTCOME.EXPLICIT_DENY },
    { action: 'kms:ListAliases', resource: '*', esperado: OUTCOME.EXPLICIT_DENY },
    // Sobre la CMK propia el catch-all NO aplica (está en NotResource).
    { action: 'kms:DescribeKey', resource: ARN_CMK, esperado: OUTCOME.IMPLICIT_DENY },

    // --- plano de datos: lo que SÍ tiene que funcionar -------------------------
    { action: 'dynamodb:GetItem', resource: ARN_NO_REPUDIO, esperado: OUTCOME.ALLOWED },
    { action: 'dynamodb:PutItem', resource: ARN_NO_REPUDIO, esperado: OUTCOME.ALLOWED },
    { action: 'dynamodb:DeleteItem', resource: ARN_NO_REPUDIO, esperado: OUTCOME.EXPLICIT_DENY },
    { action: 'dynamodb:GetItem', resource: ARN_COORD, esperado: OUTCOME.ALLOWED },
    { action: 'dynamodb:DeleteItem', resource: ARN_COORD, esperado: OUTCOME.ALLOWED },
    { action: 'sts:GetCallerIdentity', resource: '*', esperado: OUTCOME.ALLOWED },
]);

test('#5211 · el evaluador reproduce las 19 observaciones reales contra AWS', () => {
    for (const o of OBSERVACIONES_AWS) {
        const r = classifyFromPolicyDocument(APLICADA, o.action, o.resource);
        assert.equal(r.outcome, o.esperado,
            `${o.action} sobre ${o.resource} → esperado ${o.esperado}, obtenido ${r.outcome}`
            + (o.nota ? ` (${o.nota})` : ''));
    }
});

test('#5211 · el catch-all por NotResource está modelado (era el statement invisible)', () => {
    // La versión anterior del módulo no tenía soporte de `NotAction`/`NotResource`.
    // Sin eso es IMPOSIBLE explicar por qué la misma acción da explicitDeny sobre
    // una tabla e implicitDeny sobre otra — y sin explicación, se inventa una.
    const dentro = classifyFromPolicyDocument(APLICADA, 'dynamodb:UpdateContinuousBackups', ARN_NO_REPUDIO);
    const fuera = classifyFromPolicyDocument(APLICADA, 'dynamodb:UpdateContinuousBackups', ARN_TABLA_AJENA);

    assert.notEqual(dentro.outcome, fuera.outcome,
        'el catch-all discrimina por recurso: si los dos dan lo mismo, no se está evaluando NotResource');
    assert.equal(fuera.sid, 'DenyEverythingOutsideKernelTables');
});

test('#5211 · un implicitDeny NO cierra un control de CA-3 (es el colapso que causó el rebote)', () => {
    assert.equal(evaluateExpectation('denyExplicito', OUTCOME.IMPLICIT_DENY), VEREDICTO.PENDIENTE);
    assert.equal(evaluateExpectation('denyExplicito', OUTCOME.ACCESS_DENIED), VEREDICTO.PENDIENTE);
    assert.equal(evaluateExpectation('denyExplicito', OUTCOME.EXPLICIT_DENY), VEREDICTO.OK);
    // Y lo contrario: autorizado donde se esperaba Deny NUNCA es "pendiente".
    assert.equal(evaluateExpectation('denyExplicito', OUTCOME.ALLOWED), VEREDICTO.FALLIDO);
    assert.equal(evaluateExpectation('denyExplicito', OUTCOME.CONDITION_FAILED), VEREDICTO.FALLIDO);
});

// ---------------------------------------------------------------------------
// Drift: la dirección peligrosa
// ---------------------------------------------------------------------------

test('#5211 · el artefacto versionado NO borraría ningún Deny vigente al aplicarse', () => {
    // ÉSTE es el test que faltaba y el que más importa. Aplicar una policy en IAM
    // es `create-policy-version`: REEMPLAZA el documento entero. El razonamiento
    // que dejó pasar el estado anterior —"el diff sólo agrega Deny, la postura
    // sólo puede mejorar"— es falso bajo reemplazo: el artefacto de entonces no
    // tenía `DenyEverythingOutsideKernelTables` ni `AllowIdentityCheck`, así que
    // aplicarlo habría DEBILITADO la postura y roto `sts:GetCallerIdentity`.
    const drift = diffPolicyDocuments(loadArtifactPolicy(), APLICADA);

    assert.deepEqual(drift.soloEnAplicada, [],
        'hay statements vigentes que el artefacto no representa: aplicarlo los borra');
    assert.deepEqual(drift.divergentes, [],
        'hay statements con el mismo Sid y distinto contenido: aplicarlo los pisa');
    assert.equal(drift.regresion, false);
});

test('#5211 · diffPolicyDocuments marca `regresion` cuando el artefacto pierde un Deny aplicado', () => {
    // Verificación por mutación: se le saca al artefacto el catch-all y el diff
    // TIENE que gritar. Si no grita, el test de arriba no prueba nada.
    const mutilado = JSON.parse(JSON.stringify(loadArtifactPolicy()));
    mutilado.Statement = mutilado.Statement.filter((s) => s.Sid !== 'DenyEverythingOutsideKernelTables');

    const drift = diffPolicyDocuments(mutilado, APLICADA);
    assert.equal(drift.regresion, true, 'sacar un Deny vigente del artefacto es una regresión');
    assert.deepEqual(drift.soloEnAplicada, [{ sid: 'DenyEverythingOutsideKernelTables', efecto: 'Deny' }]);
});

test('#5211 · el drift reporta el endurecimiento pendiente sin confundirlo con regresión', () => {
    const drift = diffPolicyDocuments(loadArtifactPolicy(), APLICADA);
    const sids = drift.soloEnArtefacto.map((s) => s.sid).sort();
    assert.deepEqual(sids, [
        'DenyDynamoDbAccountLevelControlPlane',
        'DenyDynamoDbControlPlane',
        'DenyIamSelfAdministration',
        'DenyKmsAdministration',
    ], 'los cuatro Deny de #5211 están versionados y todavía no aplicados');
    assert.equal(drift.sinDrift, false, 'mientras haya pendientes, no hay paridad');
});

test('#5211 · aplicar el artefacto SÍ cierra los controles que hoy quedan en implicitDeny', () => {
    // Comprobación hacia adelante: no alcanza con que el artefacto no rompa nada,
    // tiene que RESOLVER lo que declara resolver. Sin este test, el entregable
    // podría sumar cuatro Deny decorativos y la matriz seguiría en ⏳ para siempre.
    const artefacto = loadArtifactPolicy();
    const pendientesHoy = [
        ['dynamodb:UpdateContinuousBackups', ARN_NO_REPUDIO],
        ['dynamodb:UpdateTable', ARN_NO_REPUDIO],
        ['dynamodb:CreateTable', ARN_NO_REPUDIO],
        ['dynamodb:DeleteTable', ARN_NO_REPUDIO],
        ['kms:ScheduleKeyDeletion', ARN_CMK],
        ['kms:DisableKey', ARN_CMK],
        ['kms:PutKeyPolicy', ARN_CMK],
    ];
    for (const [action, resource] of pendientesHoy) {
        assert.equal(classifyFromPolicyDocument(APLICADA, action, resource).outcome,
            OUTCOME.IMPLICIT_DENY, `precondición: ${action} hoy es implicitDeny sobre ${resource}`);
        assert.equal(classifyFromPolicyDocument(artefacto, action, resource).outcome,
            OUTCOME.EXPLICIT_DENY, `tras aplicar, ${action} debe quedar en explicitDeny`);
    }
});

test('#5211 · aplicar el artefacto NO rompe el plano de datos (canario de fail-closed)', () => {
    // El riesgo simétrico: un Deny demasiado amplio deja el store inoperante y el
    // pipeline cae al primer read. Estas cuatro tienen que seguir autorizadas.
    const artefacto = loadArtifactPolicy();
    const imprescindibles = [
        ['dynamodb:GetItem', ARN_NO_REPUDIO],
        ['dynamodb:PutItem', ARN_NO_REPUDIO],
        ['dynamodb:GetItem', ARN_COORD],
        ['dynamodb:DeleteItem', ARN_COORD],
        ['sts:GetCallerIdentity', '*'],
    ];
    for (const [action, resource] of imprescindibles) {
        assert.equal(classifyFromPolicyDocument(artefacto, action, resource).outcome,
            OUTCOME.ALLOWED, `${action} sobre ${resource} quedaría bloqueado: el kernel no arranca`);
    }
});

// ---------------------------------------------------------------------------
// Prohibido volver a escribir el estado a mano
// ---------------------------------------------------------------------------

test('#5211 · ningún probe de control plane puede declarar un resultado hardcodeado', () => {
    // La regresión concreta que causó el rebote: entradas con
    // `evidenciaManual: 'implicitDeny · dynamodb:DeleteTable'`, un dato deducido
    // del repo que nadie confrontó con AWS. Un resultado escrito a mano no puede
    // desactualizarse — porque nunca estuvo actualizado.
    const PROHIBIDOS = ['evidenciaManual', 'explicitoTrasAplicar', 'outcome', 'resultado', 'veredicto'];
    for (const p of CONTROL_PLANE_PROBES) {
        for (const campo of PROHIBIDOS) {
            assert.equal(Object.hasOwn(p, campo), false,
                `"${p.id}" declara "${campo}": el resultado se evalúa contra la policy aplicada, no se escribe`);
        }
        for (const [k, v] of Object.entries(p)) {
            if (typeof v !== 'string') continue;
            assert.doesNotMatch(v, /implicitDeny|explicitDeny/,
                `"${p.id}".${k} contiene un veredicto en texto: ${v}`);
        }
        // Lo que SÍ tiene que declarar: qué evaluar y contra qué recurso.
        assert.ok(p.action && p.resourceRef, `"${p.id}" debe declarar action + resourceRef`);
        assert.ok(resolveResourceRef(p.resourceRef, { runtimePrincipal: 'x' }),
            `"${p.id}" usa un resourceRef que no resuelve: ${p.resourceRef}`);
        assert.ok(p.motivoNoEjecutable, `"${p.id}" debe explicar por qué no se ejecuta`);
    }
});

test('#5211 · sin policy aplicada legible, el control sale `desconocido` y nunca `sin drift`', async () => {
    // Fail-closed en el reporte. Un chequeo que no se pudo correr NO puede
    // leerse como un chequeo que pasó — que es, literalmente, el patrón que
    // este issue existe para eliminar.
    const sinConfig = await fetchAppliedPolicy({});
    assert.equal(sinConfig.disponible, false);
    assert.match(sinConfig.motivo, /iamPolicyName/);

    const sinPerfil = await fetchAppliedPolicy({ policyName: 'X' });
    assert.equal(sinPerfil.disponible, false);
    assert.match(sinPerfil.motivo, /iamAdminProfile/);

    // Y si el perfil existe pero no puede leer, tampoco inventa.
    const fakeRunner = {
        profile: 'fake',
        run: async () => ({ code: 255, stdout: '', stderr: 'AccessDenied' }),
    };
    const sinPermiso = await fetchAppliedPolicy({
        policyName: 'X', adminProfile: 'p', runner: fakeRunner,
    });
    assert.equal(sinPermiso.disponible, false);
    assert.equal(sinPermiso.documento, undefined);
});

// ---------------------------------------------------------------------------
// Redacción
// ---------------------------------------------------------------------------

test('#5211 CA-1/CA-4 · el documento aplicado se enmascara antes de salir del módulo', () => {
    const crudo = {
        Version: '2012-10-17',
        Statement: [{
            Sid: 'X',
            Effect: 'Deny',
            NotAction: ['sts:GetCallerIdentity'],
            NotResource: [
                'arn:aws:dynamodb:us-east-2:123456789012:table/tabla-real',
                // UUID sintético: el de la CMK real no se commitea ni como
                // insumo de test — es justamente lo que este test verifica que
                // el módulo enmascare.
                'arn:aws:kms:us-east-2:123456789012:key/00000000-1111-4222-8333-444444444444',
            ],
        }],
    };
    const masked = maskPolicyDocument(crudo, {
        region: 'us-east-2', tableName: 'tabla-real', coordinationTableName: 'otra', accountId: '123456789012',
    });
    const raw = JSON.stringify(masked);

    assert.doesNotMatch(raw, /\d{12}/, 'se filtró un account-id');
    assert.doesNotMatch(raw, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
        'se filtró el UUID de la CMK');
    assert.doesNotMatch(raw, /us-east-2/, 'se filtró la región');
    assert.doesNotMatch(raw, /tabla-real/, 'se filtró el nombre de tabla');
    assert.match(raw, /key\/CMK_KEY_ID/);
});

test('#5211 · iamMatch trata los comodines de IAM y escapa el resto del ARN', () => {
    assert.equal(iamMatch('*', 'lo que sea'), true);
    assert.equal(iamMatch('dynamodb:List*', 'dynamodb:ListTables'), true);
    assert.equal(iamMatch('dynamodb:List*', 'dynamodb:GetItem'), false);
    assert.equal(iamMatch('arn:aws:dynamodb:REGION:ACCOUNT:table/*',
        'arn:aws:dynamodb:REGION:ACCOUNT:table/TABLE'), true);
    // El punto es literal, no "cualquier carácter": si no se escapa, un patrón
    // deja de discriminar y un Deny se lee como aplicado sin serlo.
    assert.equal(iamMatch('a.c', 'abc'), false);
    assert.equal(iamMatch('a.c', 'a.c'), true);
    assert.equal(iamMatch('kms:Describe?ey', 'kms:DescribeKey'), true);
});
