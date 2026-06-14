// Tests de lib/config-schema.js (#3941, EP5-H4)
// node --test
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const {
    validateConfig,
    redactErrors,
    formatErrors,
    ConfigSchemaViolation,
    PROVIDER_ENUM,
} = require('../config-schema');

// Config mínimo VÁLIDO con todas las claves críticas bien tipadas.
function validConfig() {
    return {
        circuit_breaker: {
            infra_escalate_threshold: 5,
            auto_resume_ok_threshold: 3,
        },
        resource_limits: {
            green_max_percent: 50,
            yellow_max_percent: 65,
            orange_max_percent: 80,
            red_max_percent: 90,
            priority_windows_activation_threshold: 3,
            max_concurrent_devs: 1,
        },
        concurrencia: { po: 2, 'backend-dev': 3 },
        handoff: { enabled: false, kill_switch: false, inject_in_phases: ['criterios'] },
        pipelines: {
            desarrollo: {
                fases: ['dev', 'build'],
                skills_por_fase: { dev: ['pipeline-dev'], build: ['build'] },
            },
        },
    };
}

test('config válido pasa la validación', () => {
    const { valid, errors } = validateConfig(validConfig());
    assert.strictEqual(valid, true);
    assert.deepStrictEqual(errors, []);
});

test('el config.yaml REAL del repo pasa la validación (no falsos positivos)', () => {
    const configPath = path.join(__dirname, '..', '..', 'config.yaml');
    const raw = yaml.load(fs.readFileSync(configPath, 'utf8'));
    const { valid, errors } = validateConfig(raw);
    assert.strictEqual(valid, true, 'config.yaml real debe validar: ' + formatErrors(errors));
});

test('clave extra NO crítica pasa (schema lenient global)', () => {
    const cfg = validConfig();
    cfg.una_feature_nueva = { cualquier: 'cosa', anidada: { x: 1 } };
    cfg.circuit_breaker.un_campo_nuevo = 42; // extra dentro de bloque crítico → lenient
    const { valid } = validateConfig(cfg);
    assert.strictEqual(valid, true);
});

test('typo en clave crítica del circuit breaker es rechazado (clave requerida faltante)', () => {
    const cfg = validConfig();
    delete cfg.circuit_breaker.auto_resume_ok_threshold;
    cfg.circuit_breaker.auto_resume_ok_treshold = 3; // typo
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => e.keyword === 'required' && /auto_resume_ok_threshold/.test(e.detail)));
});

test('tipo equivocado en umbral del circuit breaker es rechazado', () => {
    const cfg = validConfig();
    cfg.circuit_breaker.infra_escalate_threshold = 'cinco';
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => e.keyword === 'type'));
});

test('typo en ventana de prioridad (resource_limits) es rechazado', () => {
    const cfg = validConfig();
    delete cfg.resource_limits.priority_windows_activation_threshold;
    cfg.resource_limits.priority_windows_activaton_threshold = 3; // typo
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => /priority_windows_activation_threshold/.test(e.detail)));
});

test('porcentaje fuera de rango (0-100) es rechazado', () => {
    const cfg = validConfig();
    cfg.resource_limits.green_max_percent = 150;
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => e.keyword === 'maximum'));
});

test('valor no entero en concurrencia es rechazado', () => {
    const cfg = validConfig();
    cfg.concurrencia['backend-dev'] = 'tres';
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => e.keyword === 'type'));
});

test('typo en handoff (enabled) es rechazado', () => {
    const cfg = validConfig();
    delete cfg.handoff.enabled;
    cfg.handoff.enable = false; // typo
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => /enabled/.test(e.detail)));
});

test('pipeline sin skills_por_fase es rechazado', () => {
    const cfg = validConfig();
    delete cfg.pipelines.desarrollo.skills_por_fase;
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => /skills_por_fase/.test(e.detail)));
});

test('provider inválido en multi_provider.order es rechazado (SEC-4)', () => {
    const cfg = validConfig();
    cfg.multi_provider = { order: ['claude', 'provider-inexistente'] };
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => e.keyword === 'enum'));
});

test('multi_provider.order con providers válidos pasa', () => {
    const cfg = validConfig();
    cfg.multi_provider = { order: [...PROVIDER_ENUM] };
    const { valid } = validateConfig(cfg);
    assert.strictEqual(valid, true);
});

test('config no-objeto (string) es rechazado como corrupción de raíz', () => {
    const { valid } = validateConfig('no soy un objeto');
    assert.strictEqual(valid, false);
});

test('SEC-2: los errores NO contienen el valor crudo del input', () => {
    const cfg = validConfig();
    const SECRETO = 'sk-super-secret-token-1234567890';
    cfg.circuit_breaker.infra_escalate_threshold = SECRETO; // valor crudo sensible
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    const serialized = JSON.stringify(errors) + '|' + formatErrors(errors);
    assert.ok(!serialized.includes(SECRETO), 'el valor crudo NO debe aparecer en los errores');
    // Pero sí debe indicar path + tipo esperado.
    assert.ok(errors.some((e) => e.path.includes('infra_escalate_threshold') && /integer/.test(e.detail)));
});

test('valor por debajo del mínimo en circuit breaker es rechazado', () => {
    const cfg = validConfig();
    cfg.circuit_breaker.auto_resume_ok_threshold = 0; // mínimo es 1
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => e.keyword === 'minimum' && /mínimo permitido: 1/.test(e.detail)));
});

test('SEC-2: redactErrors tolera input no-array', () => {
    assert.deepStrictEqual(redactErrors(null), []);
    assert.deepStrictEqual(redactErrors(undefined), []);
});

test('redactErrors mapea cada keyword a un detalle SIN valor crudo (additionalProperties/default)', () => {
    const synthetic = [
        { instancePath: '/x', keyword: 'additionalProperties', params: { additionalProperty: 'clave_extra' } },
        { instancePath: '/y', keyword: 'pattern', params: {}, message: 'must match pattern' }, // default branch
        { instancePath: '', keyword: 'type', params: { type: 'integer' } }, // path raíz → '(root)'
    ];
    const out = redactErrors(synthetic);
    assert.strictEqual(out[0].detail, "clave no permitida: 'clave_extra'");
    assert.strictEqual(out[1].detail, 'must match pattern');
    assert.strictEqual(out[2].path, '(root)');
});

test('formatErrors devuelve string vacío sin errores', () => {
    assert.strictEqual(formatErrors([]), '');
    assert.strictEqual(formatErrors(null), '');
});

test('ConfigSchemaViolation tiene name estable y guarda errores', () => {
    const err = new ConfigSchemaViolation('boom', [{ path: '/x', keyword: 'type', detail: 'tipo esperado: integer' }]);
    assert.strictEqual(err.name, 'ConfigSchemaViolation');
    assert.ok(err instanceof Error);
    assert.strictEqual(err.errors.length, 1);
});
