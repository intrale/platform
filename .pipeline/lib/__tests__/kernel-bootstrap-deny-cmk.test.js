'use strict';

// =============================================================================
// kernel-bootstrap-deny-cmk.test.js — regresión encontrada en el cutover (#5126)
//
// EL BUG QUE FIJA ESTE TEST
// ------------------------
// La policy de runtime cierra con un Deny catch-all:
//
//   { Effect: Deny, NotAction: [sts:GetCallerIdentity], NotResource: [<tablas>] }
//
// Con cifrado AWS-owned era inocuo. Al pasar las tablas a una CMK propia dejó de
// serlo: con `SSEType: KMS`, leer o escribir un ítem implica que DynamoDB llame
// a `kms:Decrypt`/`kms:GenerateDataKey` en nombre del runtime. Esa llamada se
// evalúa contra el ARN de la **CMK**, que no es ninguna de las dos tablas ⇒ cae
// en el catch-all ⇒ Deny explícito. Y un Deny explícito le gana a cualquier
// Allow, incluido el de una policy de KMS separada.
//
// Se manifestó así, contra AWS real:
//
//   AccessDeniedException: KMS key access denied error: ... user/intrale-kernel-runtime
//   is not authorized to perform: kms:Decrypt on resource: arn:aws:kms:...
//   with an explicit deny in an identity-based policy: .../IntraleKernelStore
//
// Lo insidioso es que el síntoma aparece **al leer un ítem**, no al aplicar la
// policy: `create-policy-version` sale ok y el store queda inaccesible. Por eso
// se fija como test y no como comentario.
// =============================================================================

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { renderPolicy } = require('../kernel-aws-bootstrap');

const CFG = Object.freeze({
    region: 'us-east-2',
    table: 'intrale-kernel-state',
    coordinationTable: 'intrale-kernel-coordination',
});

const ACCOUNT = '000000000000';
const CMK_ARN = `arn:aws:kms:${CFG.region}:${ACCOUNT}:key/9d18ba4b-f8ca-4b48-add3-12edf72569f8`;

function denyCatchAll(doc) {
    return (doc.Statement || []).find((s) => s.Effect === 'Deny' && s.NotResource);
}

test('#5126 · con CMK, el ARN de la clave queda exceptuado del Deny catch-all', () => {
    const doc = renderPolicy(CFG, ACCOUNT, CMK_ARN);
    const deny = denyCatchAll(doc);

    assert.ok(deny, 'falta el Deny catch-all: es lo que contiene el radio de daño');
    assert.ok(
        deny.NotResource.includes(CMK_ARN),
        'el ARN de la CMK debe estar en NotResource; sin eso el runtime no puede descifrar y la tabla queda inaccesible',
    );
});

test('#5126 · sin CMK la policy no inventa un ARN de clave', () => {
    // Antes de que exista la CMK, el NotResource lleva sólo las dos tablas. Un
    // placeholder o un ARN inventado acá abriría el Deny sobre algo indefinido.
    const doc = renderPolicy(CFG, ACCOUNT, null);
    const deny = denyCatchAll(doc);

    assert.equal(deny.NotResource.length, 2);
    assert.ok(!deny.NotResource.some((r) => r.includes(':kms:')));
});

test('#5126 · exceptuar la CMK no debilita el Deny de mutacion sobre el no-repudio', () => {
    const doc = renderPolicy(CFG, ACCOUNT, CMK_ARN);
    const mutate = (doc.Statement || []).find(
        (s) => s.Effect === 'Deny' && s.Resource && String(s.Resource).includes(CFG.table),
    );

    assert.ok(mutate, 'falta el Deny de mutación sobre la tabla de no-repudio');
    assert.ok(!mutate.Condition, 'ese Deny debe ser incondicional (#5124): con Condition no aplica nunca');

    // Las 7 acciones que en DynamoDB permiten pisar o borrar un ítem.
    for (const action of [
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:BatchWriteItem',
        'dynamodb:TransactWriteItems',
        'dynamodb:PartiQLUpdate',
        'dynamodb:PartiQLDelete',
        'dynamodb:PartiQLInsert',
    ]) {
        assert.ok(mutate.Action.includes(action), `el Deny de mutación debe cubrir ${action}`);
    }
});

test('#5126 · exceptuar la CMK no alcanza a las tablas de negocio', () => {
    const doc = renderPolicy(CFG, ACCOUNT, CMK_ARN);
    const deny = denyCatchAll(doc);

    // El catch-all sigue cubriendo todo lo que no sean las dos tablas del kernel
    // más la CMK. Las tablas de negocio quedan denegadas explícitamente.
    for (const biz of ['business', 'users', 'order', 'userbusinessprofile']) {
        const arn = `arn:aws:dynamodb:${CFG.region}:${ACCOUNT}:table/${biz}`;
        assert.ok(!deny.NotResource.includes(arn), `${biz} no debe estar exceptuada del Deny`);
    }
    assert.equal(deny.NotResource.length, 3, 'sólo las 2 tablas del kernel y la CMK');
});

test('#5126 · el runtime no gana permisos de administracion de la clave', () => {
    const doc = renderPolicy(CFG, ACCOUNT, CMK_ARN);

    // renderPolicy exceptúa la CMK del Deny, pero NO concede nada sobre ella: el
    // Allow vive en la policy separada IntraleKernelKms, acotado por ViaService.
    const allowsKms = (doc.Statement || []).some((s) => {
        if (s.Effect !== 'Allow') return false;
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.some((a) => String(a).startsWith('kms:'));
    });
    assert.equal(allowsKms, false, 'renderPolicy no debe conceder acciones kms:*');
});
