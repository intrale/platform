// =============================================================================
// agent-system-prompt-api-pelada.test.js — Paridad agente ↔ Commander.
//
// Contexto: el Commander ya aumenta su system prompt con guardrail
// anti-alucinación + contexto del proyecto cuando cae a un provider integrado
// como API REST pelada (cerebras, nvidia-nim) — incidente Cerebras/Whisper
// 2026-06-05, PR #3838. Este test bloquea la regresión de que el spawn de un
// AGENTE del pipeline (sherlock, devs, qa, etc.) haga lo mismo: cuando la
// resolución de provider devuelve un API-pelado, su system prompt también debe
// llevar el pack; y para los agénticos (anthropic/openai-codex/gemini-google)
// debe quedar intacto (no-op).
//
// Replica la lógica de wiring de pulpo.js (función de spawn del agente):
//   systemContent = augmentSystemPromptForProvider(`${base}\n\n${rol}`,
//                       dispatchResolution.provider, { root: ROOT });
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    augmentSystemPromptForProvider,
    isApiPeladaProvider,
    _GUARDRAIL,
} = require('../../commander/api-context-pack');

// fsImpl falso con una doc de proyecto controlada (no dependemos del CLAUDE.md
// real del repo para que el test sea hermético).
function fakeFs(docContent) {
    return {
        readFileSync(p) {
            if (String(p).endsWith('CLAUDE.md')) {
                if (docContent == null) throw new Error('ENOENT');
                return docContent;
            }
            throw new Error('unexpected read: ' + p);
        },
    };
}

// Reproduce el snippet de wiring de pulpo.js para el spawn del agente.
function buildAgentSystemContent(base, rol, dispatchResolution, opts) {
    const effectiveProvider = (dispatchResolution && dispatchResolution.provider) || null;
    return augmentSystemPromptForProvider(`${base}\n\n${rol}`, effectiveProvider, opts);
}

const BASE = '# _base.md\nReglas comunes de todos los agentes.';
const ROL = '# sherlock.md\nSos el verificador del pipeline.';

test('agente con provider API-pelado (cerebras) recibe guardrail + contexto', () => {
    const out = buildAgentSystemContent(BASE, ROL, { provider: 'cerebras' }, {
        root: '/repo',
        fsImpl: fakeFs('# CLAUDE.md\nMonorepo Kotlin Ktor + Compose.'),
    });
    assert.ok(out.startsWith(`${BASE}\n\n${ROL}`), 'el rol original queda al inicio');
    assert.ok(out.includes(_GUARDRAIL), 'incluye el guardrail anti-alucinación');
    assert.ok(out.includes('CONTEXTO DEL PROYECTO'), 'incluye el bloque de contexto');
    assert.ok(out.includes('Monorepo Kotlin'), 'incluye el extracto de CLAUDE.md');
});

test('agente con nvidia-nim también recibe el pack', () => {
    const out = buildAgentSystemContent(BASE, ROL, { provider: 'nvidia-nim' }, {
        root: '/repo',
        fsImpl: fakeFs('# CLAUDE.md\nbla'),
    });
    assert.ok(out.includes(_GUARDRAIL));
});

test('agente con provider agéntico no toca el system prompt (no-op)', () => {
    for (const prov of ['anthropic', 'openai-codex', 'gemini-google']) {
        const out = buildAgentSystemContent(BASE, ROL, { provider: prov }, {
            root: '/repo',
            fsImpl: fakeFs('# CLAUDE.md\nbla'),
        });
        assert.equal(out, `${BASE}\n\n${ROL}`, `no toca el system prompt con ${prov}`);
    }
});

test('resolución sin provider (null) es no-op seguro', () => {
    const out = buildAgentSystemContent(BASE, ROL, null, {
        root: '/repo',
        fsImpl: fakeFs('# CLAUDE.md\nbla'),
    });
    assert.equal(out, `${BASE}\n\n${ROL}`);
    assert.ok(!isApiPeladaProvider(null));
});

test('el guardrail va aunque CLAUDE.md no se pueda leer', () => {
    const out = buildAgentSystemContent(BASE, ROL, { provider: 'cerebras' }, {
        root: '/repo',
        fsImpl: fakeFs(null),
    });
    assert.ok(out.includes(_GUARDRAIL), 'el guardrail es lo crítico y va siempre');
    assert.ok(out.startsWith(`${BASE}\n\n${ROL}`), 'el rol queda intacto al inicio');
});
