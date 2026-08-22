// =============================================================================
// __tests__/provider-death-classifier.test.js — Issue #4648.
//
// Cobertura de la clasificación provider-death vs agent-death (CA-1, CA-5 y
// escenarios Gherkin del issue). Función PURA: sin IO, sin fixtures.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyPrematureDeath } = require('../provider-death-classifier');

test('muerte <15s code=1 con provider fallback → provider-death (no penaliza al issue)', () => {
    // Gherkin: Anthropic gateado, fallback gemini-google muere al spawn en 5s.
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 5, hasVerdict: false,
        source: 'fallback', provider: 'gemini-google',
    });
    assert.equal(v.kind, 'provider-death');
    assert.match(v.reason, /gemini-google/);
});

test('muerte <15s code=1 con primary disponible → agent-death (SÍ penaliza — CA-5)', () => {
    // Gherkin: Anthropic disponible, qa:#4632 muere en 3s por su propio código.
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 3, hasVerdict: false,
        source: 'primary', provider: 'anthropic',
    });
    assert.equal(v.kind, 'agent-death');
});

test('source ausente (resolver falló) → agent-death (fail-closed conservador)', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 4, hasVerdict: false,
        source: null, provider: null,
    });
    assert.equal(v.kind, 'agent-death');
});

test('exit 0 → normal (no es muerte prematura) aunque sea fallback', () => {
    const v = classifyPrematureDeath({
        code: 0, elapsedSec: 5, hasVerdict: false,
        source: 'fallback', provider: 'gemini-google',
    });
    assert.equal(v.kind, 'normal');
    assert.equal(v.reason, 'not_premature');
});

test('vivió ≥ umbral → normal aunque code≠0 y fallback', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 40, hasVerdict: false,
        source: 'fallback', provider: 'gemini-google',
    });
    assert.equal(v.kind, 'normal');
});

test('con veredicto válido → normal (no muerte prematura, #2524)', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 2, hasVerdict: true,
        source: 'fallback', provider: 'gemini-google',
    });
    assert.equal(v.kind, 'normal');
    assert.equal(v.reason, 'verdict');
});

test('source dispatch-fallback también cuenta como provider-death', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 6, hasVerdict: false,
        source: 'dispatch-fallback', provider: 'cerebras',
    });
    assert.equal(v.kind, 'provider-death');
});

test('provider deterministic nunca es provider-death (skill Node puro)', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 2, hasVerdict: false,
        source: 'fallback', provider: 'deterministic',
    });
    assert.equal(v.kind, 'agent-death');
});

test('umbral configurable (prematureSec)', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 20, hasVerdict: false,
        source: 'fallback', provider: 'gemini-google',
        prematureSec: 30,
    });
    assert.equal(v.kind, 'provider-death');
});

// =============================================================================
// #6238 — credential-death: la TERCERA causa. Los 9 casos de arriba son la
// línea de base de no-regresión (CA-9) y NO se modifican; acá sólo se agrega.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const FIXTURES = path.join(__dirname, 'fixtures', 'credential-death');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const CRED_TAIL = () => fixture('real-frame-a-plus-b.jsonl');

test('#6238 credential-death con source primary (el caso del incidente 2026-08-20)', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 2, hasVerdict: false,
        source: 'primary', provider: 'anthropic',
        logTail: CRED_TAIL(),
    });
    assert.equal(v.kind, 'credential-death');
    assert.equal(v.reason, 'credential_rejected:authentication_failed');
    assert.equal(v.token, 'authentication_failed');
    assert.equal(v.signature, 'A+B');
});

test('#6238 credential-death con source fallback (la credencial no depende del origen)', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 2, hasVerdict: false,
        source: 'fallback', provider: 'openai-codex',
        logTail: CRED_TAIL(),
    });
    assert.equal(v.kind, 'credential-death');
});

test('#6238 precedencia: credential-death gana sobre provider-death', () => {
    // Mismas condiciones que dispararían provider-death (fallback + provider
    // LLM), pero con la firma de credencial en el tail.
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 3, hasVerdict: false,
        source: 'fallback', provider: 'gemini-google',
        logTail: CRED_TAIL(),
    });
    assert.equal(v.kind, 'credential-death');
    assert.notEqual(v.kind, 'provider-death');
});

test('#6238 precedencia: credential-death gana sobre agent-death', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 3, hasVerdict: false,
        source: 'primary', provider: 'anthropic',
        logTail: fixture('real-frame-a.jsonl'),
    });
    assert.equal(v.kind, 'credential-death');
    assert.equal(v.signature, 'A');
});

test('#6238 hasVerdict gana: no es muerte prematura aunque el tail traiga la firma', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 2, hasVerdict: true,
        source: 'primary', provider: 'anthropic',
        logTail: CRED_TAIL(),
    });
    assert.equal(v.kind, 'normal');
    assert.equal(v.reason, 'verdict');
});

test('#6238 elapsedSec >= umbral gana: normal aunque el tail traiga la firma', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 40, hasVerdict: false,
        source: 'primary', provider: 'anthropic',
        logTail: CRED_TAIL(),
    });
    assert.equal(v.kind, 'normal');
    assert.equal(v.reason, 'not_premature');
});

test('#6238 exit 0 gana: normal aunque el tail traiga la firma', () => {
    const v = classifyPrematureDeath({
        code: 0, elapsedSec: 2, hasVerdict: false,
        source: 'primary', provider: 'anthropic',
        logTail: CRED_TAIL(),
    });
    assert.equal(v.kind, 'normal');
});

test('#6238 anti-envenenamiento: el body de #6238 en el tail NO es credential-death', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 3, hasVerdict: false,
        source: 'primary', provider: 'anthropic',
        logTail: fixture('issue-6238-body.jsonl'),
    });
    assert.equal(v.kind, 'agent-death');
});

test('#6238 anti-inyección: la frase en un tool_result de tercero NO apaga el provider', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 3, hasVerdict: false,
        source: 'primary', provider: 'anthropic',
        logTail: fixture('poisoned-tool-result.jsonl'),
    });
    assert.equal(v.kind, 'agent-death');
});

test('#6238 5xx terminal (sólo frame B) sigue siendo provider-death por fallback', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 4, hasVerdict: false,
        source: 'fallback', provider: 'gemini-google',
        logTail: fixture('frame-b-only-5xx.jsonl'),
    });
    assert.equal(v.kind, 'provider-death');
});

test('#6238 fail-closed: detector que TIRA → agent-death, nunca throw (CA-7)', () => {
    const boom = { detectCredentialDeath() { throw new Error('detector roto'); } };
    let v;
    assert.doesNotThrow(() => {
        v = classifyPrematureDeath({
            code: 1, elapsedSec: 2, hasVerdict: false,
            source: 'primary', provider: 'anthropic',
            logTail: CRED_TAIL(), detector: boom,
        });
    });
    assert.equal(v.kind, 'agent-death');
});

test('#6238 fail-closed: detector que TIRA en un spawn por fallback → provider-death', () => {
    const boom = { detectCredentialDeath() { throw new Error('detector roto'); } };
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 2, hasVerdict: false,
        source: 'fallback', provider: 'gemini-google',
        logTail: CRED_TAIL(), detector: boom,
    });
    assert.equal(v.kind, 'provider-death');
});

test('#6238 fail-closed: logTail ausente/vacío/no-string preserva la conducta pre-#6238', () => {
    for (const tail of [undefined, null, '', 0, {}, []]) {
        const prim = classifyPrematureDeath({
            code: 1, elapsedSec: 2, hasVerdict: false,
            source: 'primary', provider: 'anthropic', logTail: tail,
        });
        assert.equal(prim.kind, 'agent-death', `logTail=${JSON.stringify(tail)}`);
        const fb = classifyPrematureDeath({
            code: 1, elapsedSec: 2, hasVerdict: false,
            source: 'fallback', provider: 'gemini-google', logTail: tail,
        });
        assert.equal(fb.kind, 'provider-death', `logTail=${JSON.stringify(tail)}`);
    }
});

test('#6238 credential-death también aplica al provider deterministic si el tail trae la firma', () => {
    // Caso teórico (el skill determinístico no usa credenciales), pero la
    // precedencia debe ser consistente: la firma manda.
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 2, hasVerdict: false,
        source: 'fallback', provider: 'deterministic',
        logTail: CRED_TAIL(),
    });
    assert.equal(v.kind, 'credential-death');
});
