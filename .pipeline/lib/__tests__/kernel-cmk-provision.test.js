'use strict';

// =============================================================================
// kernel-cmk-provision.test.js — CMK del store durable (#5126 · runbook §3)
//
// Testea la parte que se puede testear sin AWS: las guardas y la forma de las
// policies. Un documento de policy no falla al leerse — si miente, miente en
// silencio hasta que alguien pierde acceso o gana de más.
// =============================================================================

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
    assertGuards,
    buildKeyPolicy,
    buildKmsIamPolicy,
    assertNoWildcardPrincipal,
    DEFAULTS,
} = require('../kernel-cmk-provision');

const CFG = Object.freeze({
    region: 'us-east-2',
    table: 'intrale-kernel-state',
    coordinationTable: 'intrale-kernel-coordination',
    user: 'intrale-kernel-runtime',
    alias: 'alias/intrale-kernel-store',
});

const ACCOUNT = '000000000000';

// ─── guardas ────────────────────────────────────────────────────────────────

test('#5126 · aborta si una tabla cae fuera del prefijo del kernel', () => {
    // Contiene el radio de daño de un nombre copiado de un recurso productivo.
    for (const bad of ['business', 'users', 'order']) {
        assert.throws(() => assertGuards({ ...CFG, table: bad }), /G1/);
        assert.throws(() => assertGuards({ ...CFG, coordinationTable: bad }), /G1/);
    }
});

test('#5126 · aborta con principals de produccion o fuera del prefijo', () => {
    for (const bad of ['claude-code', 'root', 'admin', 'deploy-lambda']) {
        assert.throws(() => assertGuards({ ...CFG, user: bad }), /G4/);
    }
});

test('#5126 · aborta con un alias mal formado', () => {
    for (const bad of ['intrale-kernel-store', 'alias/', 'alias/con espacio', '']) {
        assert.throws(() => assertGuards({ ...CFG, alias: bad }), /alias/);
    }
    assert.doesNotThrow(() => assertGuards(CFG));
});

// ─── key policy ─────────────────────────────────────────────────────────────

test('#5126 runbook §3 · la key policy no lleva Principal comodin', () => {
    const p = buildKeyPolicy(CFG, ACCOUNT);
    // buildKeyPolicy ya valida internamente; se re-verifica sobre el resultado.
    assert.doesNotThrow(() => assertNoWildcardPrincipal(p));

    for (const st of p.Statement) {
        const principal = st.Principal && st.Principal.AWS;
        assert.ok(principal, `el statement ${st.Sid} debe declarar un Principal`);
        assert.ok(!String(principal).includes('*'),
            `el statement ${st.Sid} tiene un Principal comodín`);
        assert.ok(String(principal).startsWith('arn:aws:iam::'),
            `el Principal de ${st.Sid} debe ser un ARN explícito`);
    }
});

test('#5126 runbook §3 · assertNoWildcardPrincipal detecta las tres formas de comodin', () => {
    for (const principal of ['*', { AWS: '*' }, { AWS: ['arn:aws:iam::1:root', '*'] }]) {
        assert.throws(
            () => assertNoWildcardPrincipal({ Statement: [{ Sid: 'x', Principal: principal }] }),
            /comod/i,
        );
    }
});

test('#5126 runbook §3 · el uso de la clave esta acotado por kms:ViaService a DynamoDB', () => {
    const p = buildKeyPolicy(CFG, ACCOUNT);
    const use = p.Statement.find((s) => s.Sid === 'RuntimeUseViaDynamoDBOnly');
    assert.ok(use, 'falta el statement de uso del runtime');

    // Sin esta condición, una credencial robada del runtime podría usar la CMK
    // para descifrar por fuera de DynamoDB.
    const via = use.Condition && use.Condition.StringEquals && use.Condition.StringEquals['kms:ViaService'];
    assert.equal(via, `dynamodb.${CFG.region}.amazonaws.com`);

    // El runtime NO administra la clave: sin estos permisos no puede deshabilitarla
    // ni cambiar su policy, que es lo que sostiene el kill-switch del rollback.
    const actions = Array.isArray(use.Action) ? use.Action : [use.Action];
    for (const forbidden of ['kms:*', 'kms:PutKeyPolicy', 'kms:DisableKey', 'kms:ScheduleKeyDeletion']) {
        assert.ok(!actions.includes(forbidden), `el runtime no debe tener ${forbidden}`);
    }
});

test('#5126 · la administracion de la clave queda declarada (una CMK sin admin es irrecuperable)', () => {
    const p = buildKeyPolicy(CFG, ACCOUNT);
    const admin = p.Statement.find((s) => s.Sid === 'AdminDelegatedToAccountIAM');
    assert.ok(admin, 'sin statement de administración la CMK queda inadministrable para siempre');
    assert.equal(admin.Principal.AWS, `arn:aws:iam::${ACCOUNT}:root`);
});

// ─── policy IAM de KMS ──────────────────────────────────────────────────────

test('#5126 · la policy IAM de KMS apunta a la CMK concreta, sin wildcard de recurso', () => {
    const keyArn = `arn:aws:kms:${CFG.region}:${ACCOUNT}:key/abcd-1234`;
    const p = buildKmsIamPolicy(CFG, keyArn);
    const st = p.Statement[0];

    assert.equal(st.Effect, 'Allow');
    assert.equal(st.Resource, keyArn, 'debe acotar por Resource a la CMK, no usar "*"');
    assert.equal(
        st.Condition.StringEquals['kms:ViaService'],
        `dynamodb.${CFG.region}.amazonaws.com`,
    );

    const actions = st.Action;
    assert.deepEqual([...actions].sort(), ['kms:Decrypt', 'kms:DescribeKey', 'kms:GenerateDataKey'].sort());
});

test('#5126 · los defaults apuntan a los recursos del kernel', () => {
    assert.ok(DEFAULTS.table.startsWith('intrale-kernel-'));
    assert.ok(DEFAULTS.coordinationTable.startsWith('intrale-kernel-'));
    assert.notEqual(DEFAULTS.table, DEFAULTS.coordinationTable);
    assert.ok(DEFAULTS.alias.startsWith('alias/'));
});
