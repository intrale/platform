// =============================================================================
// provider-policy.test.js — #7597 · CA-3 / CA-5
//
// Reglas de la política de proveedores: vencimiento de términos, `canEnable`
// y derivación de scopes. TODOS los casos inyectan `now`: ninguno depende del
// reloj real (sin bomba de tiempo en CI cuando venzan los términos reales).
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pp = require('../provider-policy');
const bce = require('../build-child-env');

const PIPELINE_DIR = path.resolve(__dirname, '..', '..');
const NOW = Date.parse('2026-10-01T12:00:00Z');
const SIGN = 'https://github.com/intrale/platform/issues/6860#issuecomment-5723188265';

function fixturePolicy(over = {}) {
    const base = {
        version: '2026-09-23',
        doc_ref: 'docs/legal/proveedores-ia.md',
        terms_max_validity_days: 120,
        exempt_providers: ['deterministic'],
        providers: {
            'fake-llm': {
                code: { access: 'read', note: 'fixture' },
                data: {
                    issues: { allowed: true, roles: ['perf'] },
                    logs: { allowed: false },
                    telegram: { allowed: false },
                    qa_evidence: { allowed: false },
                    handoff: { allowed: false },
                },
                env: { allowed_scopes: ['telegram-hooks'], fs_reach: 'worktree', permission_mode: 'restricted', tools: ['git'] },
                terms: { verified_at: '2026-09-16', expires_at: '2026-12-15', sources: ['https://example.com/terms'] },
                roles_allowed: [{ role: 'perf', signoff_ref: SIGN }],
                known_exposures: ['#7041'],
            },
        },
        open_differences: [],
    };
    return { ...base, ...over };
}

// Matriz en memoria: `perf` sin credenciales, `po` con github (default).
const MATRIX = {
    providers: { 'fake-llm': {}, deterministic: {} },
    skills: {
        perf: { provider: 'fake-llm' },
        po: { provider: 'fake-llm' },
        tester: { provider: 'deterministic' },
    },
};

// ─── termsStatus ─────────────────────────────────────────────────────────────

test('termsStatus: vigente antes del vencimiento', () => {
    const r = pp.termsStatus('fake-llm', { now: NOW, policy: fixturePolicy() });
    assert.equal(r.state, 'vigente');
    assert.equal(r.reason, 'ok');
    assert.equal(r.expires_at, '2026-12-15');
});

test('termsStatus: expires_at es inclusivo (vence al terminar el día UTC)', () => {
    const lastDay = Date.parse('2026-12-15T23:59:59Z');
    const nextDay = Date.parse('2026-12-16T00:00:00Z');
    assert.equal(pp.termsStatus('fake-llm', { now: lastDay, policy: fixturePolicy() }).state, 'vigente');
    const r = pp.termsStatus('fake-llm', { now: nextDay, policy: fixturePolicy() });
    assert.equal(r.state, 'vencido');
    assert.equal(r.reason, 'expired');
});

test('termsStatus: fecha inválida ⇒ vencido (fail-closed)', () => {
    const entry = { terms: { verified_at: '2026-09-16', expires_at: '2026-02-30' } };
    const r = pp.termsStatus(entry, { now: NOW });
    assert.equal(r.state, 'vencido');
    assert.equal(r.reason, 'invalid');
});

test('termsStatus: fecha ausente ⇒ vencido (fail-closed)', () => {
    assert.deepEqual(
        { ...pp.termsStatus({ terms: { verified_at: '2026-09-16' } }, { now: NOW }) },
        { state: 'vencido', reason: 'missing', verified_at: null, expires_at: null },
    );
    assert.equal(pp.termsStatus({}, { now: NOW }).state, 'vencido');
});

test('termsStatus: proveedor sin entrada ⇒ vencido', () => {
    const r = pp.termsStatus('no-existe', { now: NOW, policy: fixturePolicy() });
    assert.equal(r.state, 'vencido');
    assert.equal(r.reason, 'no_entry');
});

// ─── canEnable ───────────────────────────────────────────────────────────────

test('canEnable: par válido ⇒ ok', () => {
    const r = pp.canEnable('fake-llm', 'perf', { now: NOW, policy: fixturePolicy(), agentModels: MATRIX });
    assert.deepEqual(r, { ok: true, reasons: [] });
});

test('canEnable: deterministic está exento', () => {
    const r = pp.canEnable('deterministic', 'tester', { now: NOW, policy: fixturePolicy(), agentModels: MATRIX });
    assert.deepEqual(r, { ok: true, reasons: [] });
});

test('canEnable: proveedor sin entrada ⇒ prohibido con la frase de UX-4', () => {
    const r = pp.canEnable('otro', 'perf', { now: NOW, policy: fixturePolicy(), agentModels: MATRIX });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reasons, ['El proveedor otro no tiene entrada en la política: se trata como prohibido.']);
});

test('canEnable: rol no listado ⇒ prohibido', () => {
    const policy = fixturePolicy();
    policy.providers['fake-llm'].env.allowed_scopes = ['telegram-hooks', 'github'];
    const r = pp.canEnable('fake-llm', 'po', { now: NOW, policy, agentModels: MATRIX });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reasons, ['El rol po no está habilitado para fake-llm en la política.']);
});

test('canEnable: habilitación sin signoff_ref ⇒ prohibido', () => {
    const policy = fixturePolicy();
    policy.providers['fake-llm'].roles_allowed = [{ role: 'perf' }];
    const r = pp.canEnable('fake-llm', 'perf', { now: NOW, policy, agentModels: MATRIX });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reasons, ['La habilitación de perf en fake-llm no tiene sign-off del operador.']);
});

test('canEnable: signoff_ref que no es un comentario de GitHub ⇒ prohibido', () => {
    const policy = fixturePolicy();
    policy.providers['fake-llm'].roles_allowed = [{ role: 'perf', signoff_ref: 'https://evil.example/ok' }];
    assert.equal(pp.canEnable('fake-llm', 'perf', { now: NOW, policy, agentModels: MATRIX }).ok, false);
});

test('canEnable: scope efectivo que excede allowed_scopes ⇒ una razón por scope', () => {
    const policy = fixturePolicy();
    policy.providers['fake-llm'].roles_allowed.push({ role: 'po', signoff_ref: SIGN });
    const r = pp.canEnable('fake-llm', 'po', { now: NOW, policy, agentModels: MATRIX });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reasons, ['El rol po recibe el scope github, que fake-llm no tiene permitido.']);
});

test('canEnable: requires_credentials declarado en la matriz manda sobre el default', () => {
    const policy = fixturePolicy();
    const matrix = { ...MATRIX, skills: { ...MATRIX.skills, perf: { provider: 'fake-llm', requires_credentials: ['aws'] } } };
    const r = pp.canEnable('fake-llm', 'perf', { now: NOW, policy, agentModels: matrix });
    assert.deepEqual(r.reasons, ['El rol perf recibe el scope aws, que fake-llm no tiene permitido.']);
});

test('canEnable: términos vencidos ⇒ no se aceptan habilitaciones nuevas', () => {
    const r = pp.canEnable('fake-llm', 'perf', {
        now: Date.parse('2026-12-20T00:00:00Z'), policy: fixturePolicy(), agentModels: MATRIX,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reasons, ['Los términos de fake-llm están vencidos (15/12/2026): no se aceptan habilitaciones nuevas.']);
});

test('canEnable: las razones salen en el orden del checklist del doc', () => {
    const policy = fixturePolicy();
    const r = pp.canEnable('fake-llm', 'po', { now: Date.parse('2027-01-01T00:00:00Z'), policy, agentModels: MATRIX });
    assert.equal(r.reasons.length, 3);
    assert.match(r.reasons[0], /no está habilitado/);
    assert.match(r.reasons[1], /recibe el scope github/);
    assert.match(r.reasons[2], /vencidos/);
});

// ─── effectiveScopesForRole (SR-2: derivado, no copiado) ─────────────────────

function fakeOperatorEnv() {
    // Valores sintéticos `FAKE-`; declaración productiva para que buildChildEnv
    // no purgue credenciales (ver build-child-env-least-privilege.test.js).
    const env = { PIPELINE_AMBIENTE: 'productivo', PATH: '/usr/bin' };
    for (const vars of Object.values(bce.CREDENTIAL_SCOPES)) for (const v of vars) env[v] = `FAKE-${v}`;
    return env;
}

function scopesPresentes(env) {
    const out = new Set();
    for (const [scope, vars] of Object.entries(bce.CREDENTIAL_SCOPES)) {
        if (vars.some((v) => env[v] !== undefined)) out.add(scope);
    }
    return out;
}

test('effectiveScopesForRole coincide con lo que buildChildEnv inyecta (unión de fases) para toda la matriz real', () => {
    const models = JSON.parse(fs.readFileSync(path.join(PIPELINE_DIR, 'agent-models.json'), 'utf8'));
    const env = fakeOperatorEnv();
    for (const [role, cfg] of Object.entries(models.skills)) {
        if (cfg.provider === 'deterministic') continue;
        const observed = new Set();
        for (const fase of Object.keys(bce.SCOPES_BY_FASE)) {
            const child = bce.buildChildEnv({
                skill: role, pipelineDir: PIPELINE_DIR, processEnv: env, fase, warn: () => {},
                skillConfigOverride: { provider: 'anthropic' },
            });
            for (const s of scopesPresentes(child)) observed.add(s);
        }
        const derived = new Set(pp.effectiveScopesForRole(role, { pipelineDir: PIPELINE_DIR }));
        assert.deepEqual([...observed].sort(), [...derived].sort(), `scopes de ${role}`);
    }
});

test('effectiveScopesForRole incluye siempre SCOPES_ALWAYS_ON y lee DEFAULT_REQUIRES_BY_SKILL', () => {
    const s = pp.effectiveScopesForRole('qa', { agentModels: { skills: { qa: {} } } });
    for (const always of bce.SCOPES_ALWAYS_ON) assert.ok(s.includes(always));
    for (const d of bce.DEFAULT_REQUIRES_BY_SKILL.qa) assert.ok(s.includes(d));
});

// ─── Carga y validación fail-closed ──────────────────────────────────────────

function withPolicyFile(content, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-policy-'));
    try {
        if (content !== undefined) fs.writeFileSync(path.join(dir, 'provider-policy.json'), content);
        return fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('loadPolicy: archivo ausente ⇒ política vacía (todo prohibido)', () => {
    withPolicyFile(undefined, (dir) => {
        const pol = pp.loadPolicy({ pipelineDir: dir });
        assert.equal(pol._loaded, false);
        assert.deepEqual(pol.providers, {});
        assert.equal(pp.canEnable('anthropic', 'po', { now: NOW, policy: pol }).ok, false);
        // Sin política ni deterministic queda exento: fail-closed completo.
        assert.equal(pp.canEnable('deterministic', 'tester', { now: NOW, policy: pol }).ok, false);
    });
});

test('loadPolicy: JSON inválido ⇒ política vacía con diagnóstico', () => {
    withPolicyFile('{ esto no es json', (dir) => {
        const pol = pp.loadPolicy({ pipelineDir: dir });
        assert.equal(pol._loaded, false);
        assert.match(pol._errors[0], /no es JSON válido/);
    });
});

test('loadPolicy: política que no valida ⇒ política vacía (no parcial)', () => {
    const bad = fixturePolicy();
    bad.providers['fake-llm'].env.allowed_scopes = ['root-access'];
    withPolicyFile(JSON.stringify(bad), (dir) => {
        const pol = pp.loadPolicy({ pipelineDir: dir });
        assert.equal(pol._loaded, false);
        assert.ok(pol._errors.some((e) => /root-access.*CREDENTIAL_SCOPES/.test(e)));
    });
});

test('validatePolicy: la política real del repo es válida', () => {
    const real = JSON.parse(fs.readFileSync(path.join(PIPELINE_DIR, 'provider-policy.json'), 'utf8'));
    assert.deepEqual(pp.validatePolicy(real), []);
});

test('validatePolicy: rechaza campos extra, enums fuera de rango y vigencias largas', () => {
    const p = fixturePolicy();
    p.providers['fake-llm'].extra = true;
    p.providers['fake-llm'].env.fs_reach = 'everywhere';
    p.providers['fake-llm'].terms.expires_at = '2027-09-16';
    const errs = pp.validatePolicy(p);
    assert.ok(errs.some((e) => /campo no permitido 'extra'/.test(e)));
    assert.ok(errs.some((e) => /fs_reach/.test(e)));
    assert.ok(errs.some((e) => /vigencia mayor a 120 días/.test(e)));
});

test('validatePolicy: roles de una categoría de datos tienen que estar habilitados', () => {
    const p = fixturePolicy();
    p.providers['fake-llm'].data.issues.roles = ['perf', 'qa'];
    assert.ok(pp.validatePolicy(p).some((e) => /data\.issues: el rol 'qa' no está en roles_allowed/.test(e)));
});

test('validatePolicy: known_exposures sólo admite referencias a issues', () => {
    const p = fixturePolicy();
    p.providers['fake-llm'].known_exposures = ['falta aislar el home del operador'];
    assert.ok(pp.validatePolicy(p).some((e) => /known_exposures/.test(e)));
});

// ─── diffRolesAllowed (insumo del registro de auditoría) ─────────────────────

test('diffRolesAllowed: reporta altas con su signoff y bajas', () => {
    const from = fixturePolicy();
    const to = fixturePolicy();
    to.providers['fake-llm'].roles_allowed = [{ role: 'ux', signoff_ref: SIGN }];
    assert.deepEqual(pp.diffRolesAllowed(from, to), [
        { provider: 'fake-llm', role: 'perf', signoff_ref: null, kind: 'removed' },
        { provider: 'fake-llm', role: 'ux', signoff_ref: SIGN, kind: 'added' },
    ]);
});

test('diffRolesAllowed: tolera políticas nulas (archivo creado o borrado)', () => {
    const to = fixturePolicy();
    assert.deepEqual(pp.diffRolesAllowed(null, to), [
        { provider: 'fake-llm', role: 'perf', signoff_ref: SIGN, kind: 'added' },
    ]);
    assert.deepEqual(pp.diffRolesAllowed(to, null).map((c) => c.kind), ['removed']);
});

test('formatDateDMY arma DD/MM/AAAA sin locale y rechaza fechas imposibles', () => {
    assert.equal(pp.formatDateDMY('2026-12-15'), '15/12/2026');
    assert.equal(pp.formatDateDMY('2026-02-30'), null);
    assert.equal(pp.formatDateDMY(undefined), null);
});
