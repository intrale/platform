// =============================================================================
// permission-validator.test.js — Tests del validador y la matriz canónica.
//
// Issue #3082 (S4 multi-provider) — CAs 8-15 + paridad (CA-18).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const permissionValidator = require('../permission-validator');

function makeTmpOverridesFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-overrides-'));
    return path.join(dir, 'permission-overrides.jsonl');
}

// ============================================================================
// CAPABILITY_MATRIX + grantedCapabilities
// ============================================================================

test('CAPABILITY_MATRIX es frozen — la celda anthropic/bypassPermissions no se puede mutar', () => {
    assert.throws(() => {
        permissionValidator.CAPABILITY_MATRIX.anthropic.bypassPermissions.add('arbitrary');
    });
});

test('grantedCapabilities devuelve Set válido para anthropic/bypassPermissions', () => {
    const granted = permissionValidator.grantedCapabilities('anthropic', 'bypassPermissions');
    assert.ok(granted instanceof Set);
    assert.ok(granted.has('file_read'));
    assert.ok(granted.has('file_write_repo'));
    assert.ok(granted.has('bash'));
    assert.ok(granted.has('tool_use_gated'));
});

test('grantedCapabilities devuelve null para (provider, mode) desconocido', () => {
    assert.equal(permissionValidator.grantedCapabilities('anthropic', 'no-such-mode'), null);
    assert.equal(permissionValidator.grantedCapabilities('no-such-provider', 'any'), null);
});

test('anthropic/plan tiene capability set restringido — NO tiene bash ni file_write_repo (CA-1)', () => {
    const plan = permissionValidator.grantedCapabilities('anthropic', 'plan');
    assert.ok(plan.has('file_read'));
    assert.ok(plan.has('network_out'));
    assert.equal(plan.has('bash'), false);
    assert.equal(plan.has('file_write_repo'), false);
    assert.equal(plan.has('tool_use_gated'), false);
});

test('openai-codex/full-auto concede el set autónomo completo incluyendo tool_use_gated (CA-19 resuelto #3820)', () => {
    const codex = permissionValidator.grantedCapabilities('openai-codex', 'full-auto');
    assert.ok(codex.has('file_read'));
    assert.ok(codex.has('bash'));
    assert.ok(codex.has('child_spawn'));
    assert.ok(codex.has('tool_use_gated'));
    assert.ok(codex.has('long_running_watcher'));
    // Sigue SIN conceder lo que ningún provider del pipeline concede al spawn.
    assert.equal(codex.has('file_write_outside_repo'), false);
    assert.equal(codex.has('bash_elevated'), false);
    assert.equal(codex.has('network_in'), false);
});

test('free providers (gemini/cerebras/nvidia-nim) en bypassPermissions tienen celda con set autónomo (#3820 defecto #2)', () => {
    for (const p of ['gemini-google', 'cerebras', 'nvidia-nim']) {
        const granted = permissionValidator.grantedCapabilities(p, 'bypassPermissions');
        assert.ok(granted instanceof Set, `${p} debe tener celda bypassPermissions`);
        assert.ok(granted.has('file_read'), `${p} concede file_read`);
        assert.ok(granted.has('file_write_repo'), `${p} concede file_write_repo`);
        assert.ok(granted.has('bash'), `${p} concede bash`);
        assert.ok(granted.has('tool_use_gated'), `${p} concede tool_use_gated`);
        assert.equal(granted.has('file_write_outside_repo'), false, `${p} NO concede escritura fuera del repo`);
    }
});

// ============================================================================
// NON_DEGRADABLE_SKILLS
// ============================================================================

test('NON_DEGRADABLE_SKILLS contiene los 5 skills críticos (CA-S6 / CA-11)', () => {
    assert.ok(permissionValidator.NON_DEGRADABLE_SKILLS.has('security'));
    assert.ok(permissionValidator.NON_DEGRADABLE_SKILLS.has('review'));
    assert.ok(permissionValidator.NON_DEGRADABLE_SKILLS.has('builder'));
    assert.ok(permissionValidator.NON_DEGRADABLE_SKILLS.has('tester'));
    assert.ok(permissionValidator.NON_DEGRADABLE_SKILLS.has('backend-dev'));
});

test('NON_DEGRADABLE_SKILLS es frozen — no se puede agregar runtime', () => {
    assert.throws(() => {
        permissionValidator.NON_DEGRADABLE_SKILLS.add('new-skill');
    });
});

// ============================================================================
// validateSpawn — happy path
// ============================================================================

test('validateSpawn aprueba skill con capabilities subset de granted (anthropic/bypass)', () => {
    const r = permissionValidator.validateSpawn({
        skill: 'qa',
        provider: 'anthropic',
        mode: 'bypassPermissions',
        requiredCapabilities: ['file_read', 'bash', 'tool_use_gated'],
    });
    assert.equal(r.ok, true);
    assert.equal(r.source, 'matrix');
});

test('validateSpawn aprueba skill con required_permissions vacíos', () => {
    const r = permissionValidator.validateSpawn({
        skill: 'cualquiera',
        provider: 'anthropic',
        mode: 'bypassPermissions',
        requiredCapabilities: [],
    });
    assert.equal(r.ok, true);
});

// ============================================================================
// validateSpawn — fail-CLOSED scenarios
// ============================================================================

test('validateSpawn rechaza con capability fuera del catálogo (CA-9 — capability_unknown)', () => {
    const r = permissionValidator.validateSpawn({
        skill: 'qa',
        provider: 'anthropic',
        mode: 'bypassPermissions',
        requiredCapabilities: ['file_read', 'fake_unknown_capability'],
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'capability_unknown');
    assert.match(r.message, /\[FAIL-CLOSED\]/);
});

test('validateSpawn rechaza con mode desconocido para el provider (CA-9 — mode_unknown)', () => {
    const r = permissionValidator.validateSpawn({
        skill: 'qa',
        provider: 'anthropic',
        mode: 'fake-mode-zero',
        requiredCapabilities: ['file_read'],
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'mode_unknown');
    assert.match(r.message, /\[FAIL-CLOSED\]/);
});

test('validateSpawn rechaza skill non-degradable cuando faltan capabilities — NO admite override (CA-11/CA-12)', () => {
    // codex/default es read-only (file_read + network_out): NO concede bash ni
    // tool_use_gated. security es NON_DEGRADABLE → fail-CLOSED por capacidad real
    // faltante, sin posibilidad de override. (El rechazo es capability-based, no
    // por jerarquía de confianza del provider.)
    const r = permissionValidator.validateSpawn({
        skill: 'security', // NON_DEGRADABLE
        provider: 'openai-codex',
        mode: 'default',
        requiredCapabilities: ['file_read', 'bash', 'tool_use_gated'],
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'non_degradable');
    assert.match(r.message, /NON_DEGRADABLE/);
    assert.match(r.message, /no admite override/);
});

test('validateSpawn aprueba skill non-degradable cuando todas las capabilities están concedidas (regresión)', () => {
    const r = permissionValidator.validateSpawn({
        skill: 'security',
        provider: 'anthropic',
        mode: 'bypassPermissions',
        requiredCapabilities: ['file_read', 'bash', 'tool_use_gated'],
    });
    assert.equal(r.ok, true);
});

// ============================================================================
// Mensaje de fail-CLOSED — formato CA-10 asserteable por regex
// ============================================================================

test('formato mensaje fail-CLOSED cumple CA-10 (3 acciones, capability faltante, anchor doc) — skill normal', () => {
    // anthropic/plan es read-only: concede file_read + network_out, NO tool_use_gated.
    // Caso fail-CLOSED genuino y permanente para un skill normal (no non-degradable).
    const r = permissionValidator.validateSpawn({
        skill: 'qa',
        provider: 'anthropic',
        mode: 'plan',
        requiredCapabilities: ['file_read', 'tool_use_gated'],
    });
    assert.equal(r.ok, false);
    const m = r.message;
    // CA-10: las 3 acciones
    assert.match(m, /1\) Cambiar provider del skill en agent-models\.json/);
    assert.match(m, /2\) Crear override temporal: node \.pipeline\/scripts\/override-permission\.js/);
    assert.match(m, /3\) Consultar tabla canónica: docs\/pipeline-multi-provider\/permission-mapping\.md/);
    // Anchor estable al doc
    assert.match(m, /#capability-matrix/);
    // Capability faltante visible
    assert.match(m, /Capability faltante: 'tool_use_gated'/);
});

test('formato mensaje fail-CLOSED para NON_DEGRADABLE omite acción de override (CA-12)', () => {
    // tester es NON_DEGRADABLE; en anthropic/plan le faltan capabilities (bash).
    const r = permissionValidator.validateSpawn({
        skill: 'tester',
        provider: 'anthropic',
        mode: 'plan',
        requiredCapabilities: ['file_read', 'bash', 'tool_use_gated', 'long_running_watcher'],
    });
    assert.equal(r.ok, false);
    const m = r.message;
    assert.match(m, /NON_DEGRADABLE/);
    // NO debe ofrecer la acción de override
    assert.equal(/Crear override temporal/.test(m), false);
});

test('NON_DEGRADABLE en provider != anthropic SÍ corre si concede todas las capabilities (cadena del operador #3820)', () => {
    // Corrección 2026-06-04: se eliminó el portón FULL_TRUST_PROVIDERS. codex/full-auto
    // concede el set autónomo completo incl. tool_use_gated; security es NON_DEGRADABLE
    // pero el portero confía en la cadena que configuró el operador y valida sólo
    // capacidad técnica → autoriza.
    const r = permissionValidator.validateSpawn({
        skill: 'security',
        provider: 'openai-codex',
        mode: 'full-auto',
        requiredCapabilities: ['file_read', 'bash', 'tool_use_gated'],
    });
    assert.equal(r.ok, true);
    assert.equal(r.source, 'matrix');
});

test('mensaje fail-CLOSED es greppable por skill y por capability (G6)', () => {
    const r = permissionValidator.validateSpawn({
        skill: 'qa',
        provider: 'anthropic',
        mode: 'plan',
        requiredCapabilities: ['tool_use_gated'],
    });
    assert.match(r.message, /Skill 'qa'/);
    assert.match(r.message, /Capability faltante: 'tool_use_gated'/);
});

// ============================================================================
// recordOverride / findActiveOverride / revokeOverride / TTL
// ============================================================================

test('recordOverride escribe entry en JSONL y devuelve hash_self válido', () => {
    const file = makeTmpOverridesFile();
    const entry = permissionValidator.recordOverride({
        skill: 'qa',
        provider: 'openai-codex',
        mode_requerido: 'bypassPermissions',
        mode_otorgado: 'full-auto',
        capabilities_diff: ['tool_use_gated'],
        justificacion: 'Override de prueba con justificación suficientemente larga.',
        autor: 'test@intrale.com.ar',
        ttl_horas: 24,
        overridesPath: file,
    });
    assert.equal(typeof entry.hash_self, 'string');
    assert.equal(entry.hash_self.length, 64);
    assert.equal(entry.type, 'permission_override');
    assert.ok(fs.existsSync(file));
});

test('recordOverride rechaza skill NON_DEGRADABLE (CA-12)', () => {
    const file = makeTmpOverridesFile();
    assert.throws(() => {
        permissionValidator.recordOverride({
            skill: 'security',
            provider: 'openai-codex',
            mode_otorgado: 'full-auto',
            capabilities_diff: [],
            justificacion: 'Tratando de overridear security — esto debe fallar.',
            autor: 'test@intrale.com.ar',
            ttl_horas: 24,
            overridesPath: file,
        });
    }, /NON_DEGRADABLE/);
});

test('recordOverride rechaza ttl_horas fuera de [1, 168]', () => {
    const file = makeTmpOverridesFile();
    const base = {
        skill: 'qa',
        provider: 'openai-codex',
        mode_otorgado: 'full-auto',
        capabilities_diff: [],
        justificacion: 'Justificación con suficiente largo para superar el mínimo.',
        autor: 'test@intrale.com.ar',
        overridesPath: file,
    };
    assert.throws(() => permissionValidator.recordOverride({ ...base, ttl_horas: 0 }), /ttl_horas/);
    assert.throws(() => permissionValidator.recordOverride({ ...base, ttl_horas: 200 }), /ttl_horas/);
});

test('recordOverride rechaza justificacion < 30 chars', () => {
    const file = makeTmpOverridesFile();
    assert.throws(() => {
        permissionValidator.recordOverride({
            skill: 'qa',
            provider: 'openai-codex',
            mode_otorgado: 'full-auto',
            capabilities_diff: [],
            justificacion: 'corta',
            autor: 'test@intrale.com.ar',
            ttl_horas: 24,
            overridesPath: file,
        });
    }, /justificacion/);
});

test('findActiveOverride devuelve null si el archivo no existe', () => {
    const file = makeTmpOverridesFile();
    const r = permissionValidator.findActiveOverride({
        skill: 'qa',
        provider: 'openai-codex',
        overridesPath: file,
    });
    assert.equal(r, null);
});

test('findActiveOverride devuelve null para NON_DEGRADABLE incluso si hay entry (defensa)', () => {
    const file = makeTmpOverridesFile();
    // Escribimos manualmente un override "trampa" pretendiendo ser security
    const auditLog = require('../audit-log');
    auditLog.appendChained({
        file,
        entry: {
            type: 'permission_override',
            skill: 'security',
            provider: 'openai-codex',
            mode_otorgado: 'full-auto',
            ttl_horas: 24,
            created_at: Date.now(),
        },
    });
    const r = permissionValidator.findActiveOverride({
        skill: 'security',
        provider: 'openai-codex',
        overridesPath: file,
    });
    assert.equal(r, null, 'NON_DEGRADABLE skill no debe tener override activo, ni siquiera si el archivo tiene una entry trampa');
});

test('findActiveOverride respeta TTL — expirado devuelve null (CA-15)', () => {
    const file = makeTmpOverridesFile();
    const created = Date.now() - 25 * 3600 * 1000; // 25h atrás
    permissionValidator.recordOverride({
        skill: 'qa',
        provider: 'openai-codex',
        mode_otorgado: 'full-auto',
        capabilities_diff: ['tool_use_gated'],
        justificacion: 'Override expirado para testear TTL en findActiveOverride.',
        autor: 'test@intrale.com.ar',
        ttl_horas: 24,
        overridesPath: file,
        nowMs: created,
    });
    const r = permissionValidator.findActiveOverride({
        skill: 'qa',
        provider: 'openai-codex',
        overridesPath: file,
    });
    assert.equal(r, null);
});

test('findActiveOverride devuelve entry válida si está dentro del TTL', () => {
    const file = makeTmpOverridesFile();
    permissionValidator.recordOverride({
        skill: 'qa',
        provider: 'openai-codex',
        mode_otorgado: 'full-auto',
        capabilities_diff: ['tool_use_gated'],
        justificacion: 'Override fresco — debe estar activo durante la ejecución del test.',
        autor: 'test@intrale.com.ar',
        ttl_horas: 24,
        overridesPath: file,
    });
    const r = permissionValidator.findActiveOverride({
        skill: 'qa',
        provider: 'openai-codex',
        overridesPath: file,
    });
    assert.ok(r);
    assert.equal(r.skill, 'qa');
    assert.equal(r.provider, 'openai-codex');
});

test('revokeOverride marca un override como revocado — findActiveOverride lo deja de encontrar', () => {
    const file = makeTmpOverridesFile();
    const entry = permissionValidator.recordOverride({
        skill: 'qa',
        provider: 'openai-codex',
        mode_otorgado: 'full-auto',
        capabilities_diff: ['tool_use_gated'],
        justificacion: 'Override para revocar — la entry vive 5 ms antes de revocarse.',
        autor: 'test@intrale.com.ar',
        ttl_horas: 24,
        overridesPath: file,
    });
    // Pre-condición: el override está activo.
    const before = permissionValidator.findActiveOverride({
        skill: 'qa', provider: 'openai-codex', overridesPath: file,
    });
    assert.ok(before);
    // Acto: revocar.
    permissionValidator.revokeOverride({
        targetHash: entry.hash_self,
        motivo: 'Test de revocación inmediata.',
        autor: 'test@intrale.com.ar',
        overridesPath: file,
    });
    // Post: ya no se encuentra activo.
    const after = permissionValidator.findActiveOverride({
        skill: 'qa', provider: 'openai-codex', overridesPath: file,
    });
    assert.equal(after, null);
});

test('validateSpawn con override activo aprueba (source = override) y registra el hash', () => {
    const file = makeTmpOverridesFile();
    // anthropic/plan es read-only (no concede bash); qa no es non-degradable, así
    // que un override por (qa, anthropic) puede autorizar el spawn igualmente.
    permissionValidator.recordOverride({
        skill: 'qa',
        provider: 'anthropic',
        mode_otorgado: 'plan',
        capabilities_diff: ['bash'],
        justificacion: 'Override de prueba para autorizar bash en anthropic/plan.',
        autor: 'test@intrale.com.ar',
        ttl_horas: 24,
        overridesPath: file,
    });
    const r = permissionValidator.validateSpawn({
        skill: 'qa',
        provider: 'anthropic',
        mode: 'plan',
        requiredCapabilities: ['file_read', 'bash'],
        overridesPath: file,
    });
    assert.equal(r.ok, true);
    assert.equal(r.source, 'override');
    assert.equal(typeof r.override_hash, 'string');
});

// ============================================================================
// Tests de paridad (CA-18) — sample del producto cartesiano (skill × provider × mode)
// ============================================================================

const PARITY_CASES = [
    // [skill, providerMode, requiredCaps, expectedOk, expectedReasonIfFail]
    ['qa', ['anthropic', 'bypassPermissions'], ['file_read', 'tool_use_gated', 'long_running_watcher'], true, null],
    ['qa', ['anthropic', 'plan'], ['file_read', 'bash'], false, 'capability_missing'],
    ['guru', ['anthropic', 'bypassPermissions'], ['file_read', 'bash', 'network_out'], true, null],
    ['guru', ['openai-codex', 'full-auto'], ['file_read', 'bash', 'network_out'], true, null],
    // #3820 / corrección 2026-06-04: sin portón de confianza plena, estos NON_DEGRADABLE
    // corren en codex/full-auto porque concede todas sus capabilities (cadena del operador).
    ['security', ['openai-codex', 'full-auto'], ['file_read', 'bash', 'tool_use_gated'], true, null],
    ['review', ['openai-codex', 'full-auto'], ['file_read', 'bash', 'tool_use_gated'], true, null],
    ['builder', ['openai-codex', 'full-auto'], ['file_read', 'bash', 'tool_use_gated', 'long_running_watcher'], true, null],
    ['tester', ['openai-codex', 'full-auto'], ['file_read', 'tool_use_gated', 'long_running_watcher'], true, null],
    // Pero si el provider de la cadena NO concede algo (codex/default es read-only),
    // el NON_DEGRADABLE sigue fail-CLOSED por capacidad real faltante.
    ['security', ['openai-codex', 'default'], ['file_read', 'bash', 'tool_use_gated'], false, 'non_degradable'],
    ['ux', ['anthropic', 'plan'], ['file_read'], true, null],
    ['ux', ['anthropic', 'plan'], ['file_read', 'file_write_repo'], false, 'capability_missing'],
];

for (const [skill, [provider, mode], required, expectedOk, expectedReason] of PARITY_CASES) {
    test(`paridad: ${skill}@${provider}/${mode} con [${required.join(',')}] → ok=${expectedOk}${expectedReason ? '/'+expectedReason : ''}`, () => {
        const r = permissionValidator.validateSpawn({
            skill, provider, mode, requiredCapabilities: required,
        });
        assert.equal(r.ok, expectedOk);
        if (!expectedOk) {
            assert.equal(r.reason, expectedReason);
        }
    });
}

// ============================================================================
// Validación de input
// ============================================================================

test('validateSpawn rechaza args inválidos con reason=invalid_args', () => {
    assert.equal(permissionValidator.validateSpawn({ provider: 'anthropic', mode: 'bypassPermissions', requiredCapabilities: [] }).reason, 'invalid_args');
    assert.equal(permissionValidator.validateSpawn({ skill: 'q', mode: 'bypassPermissions', requiredCapabilities: [] }).reason, 'invalid_args');
    assert.equal(permissionValidator.validateSpawn({ skill: 'q', provider: 'anthropic', requiredCapabilities: [] }).reason, 'invalid_args');
    assert.equal(permissionValidator.validateSpawn({ skill: 'q', provider: 'anthropic', mode: 'bypassPermissions', requiredCapabilities: 'not-array' }).reason, 'invalid_args');
});
