// =============================================================================
// api-context-pack.test.js — Cobertura de la inyección de contexto + guardrail
// anti-alucinación para providers API-pelados del Commander.
//
// Contexto: cerebras/nvidia-nim se integran como API REST pelada (sin CLI
// agéntico, sin acceso al filesystem ni a los logs). Ante una pregunta de
// estado en vivo inventaban una explicación plausible pero falsa (incidente
// Cerebras/Whisper 2026-06-05). El pack les inyecta un guardrail + contexto del
// proyecto. Para providers agénticos el augment es no-op.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    API_PELADA_PROVIDERS,
    isApiPeladaProvider,
    buildContextPack,
    augmentSystemPromptForProvider,
    _GUARDRAIL,
} = require('../api-context-pack');

// fsImpl falso que devuelve una doc de proyecto controlada.
function fakeFs(docContent) {
    return {
        readFileSync(p, enc) {
            if (String(p).endsWith('CLAUDE.md')) {
                if (docContent == null) throw new Error('ENOENT');
                return docContent;
            }
            throw new Error('unexpected read: ' + p);
        },
    };
}

test('cerebras y nvidia-nim son API-pelados; los agénticos no', () => {
    assert.ok(isApiPeladaProvider('cerebras'));
    assert.ok(isApiPeladaProvider('nvidia-nim'));
    assert.ok(!isApiPeladaProvider('anthropic'));
    assert.ok(!isApiPeladaProvider('openai-codex'));
    assert.ok(!isApiPeladaProvider('gemini-google'));
    assert.ok(!isApiPeladaProvider(''));
    assert.ok(!isApiPeladaProvider(null));
    assert.ok(!isApiPeladaProvider(undefined));
});

test('augment para provider API-pelado prepende guardrail + contexto', () => {
    const persona = 'Sos el Commander.';
    const out = augmentSystemPromptForProvider(persona, 'cerebras', {
        root: '/repo',
        fsImpl: fakeFs('# CLAUDE.md\nMonorepo Kotlin Ktor + Compose.'),
    });
    assert.ok(out.startsWith(persona), 'la persona original queda al inicio');
    assert.ok(out.includes(_GUARDRAIL), 'incluye el guardrail anti-alucinación');
    assert.ok(out.includes('CONTEXTO DEL PROYECTO'), 'incluye el bloque de contexto');
    assert.ok(out.includes('Monorepo Kotlin'), 'incluye el extracto de CLAUDE.md');
    assert.ok(out.length > persona.length, 'el resultado es más largo que la persona');
});

test('augment es no-op para providers agénticos', () => {
    const persona = 'Sos el Commander.';
    for (const prov of ['anthropic', 'openai-codex', 'gemini-google']) {
        const out = augmentSystemPromptForProvider(persona, prov, {
            root: '/repo',
            fsImpl: fakeFs('# CLAUDE.md\nbla'),
        });
        assert.equal(out, persona, `no toca el system prompt de ${prov}`);
    }
});

test('el guardrail va aunque no se pueda leer CLAUDE.md', () => {
    const out = augmentSystemPromptForProvider('persona', 'cerebras', {
        root: '/repo',
        fsImpl: fakeFs(null), // readFileSync lanza ENOENT
    });
    assert.ok(out.includes(_GUARDRAIL), 'el guardrail es lo crítico y va siempre');
    assert.ok(!out.includes('fuente de verdad del repo'), 'sin doc no agrega el bloque de contexto');
});

test('buildContextPack trunca docs largas al cap', () => {
    const huge = '# CLAUDE.md\n' + 'x'.repeat(20000);
    const pack = buildContextPack({ root: '/repo', fsImpl: fakeFs(huge) });
    assert.ok(pack.includes('documento truncado'), 'marca el truncado');
    // El pack no arrastra los 20K chars completos.
    assert.ok(pack.length < 20000, 'el pack quedó por debajo del tamaño crudo');
});

test('guardrail menciona explícitamente no inventar estado en vivo', () => {
    // Defensa de regresión sobre el contenido del guardrail: si alguien lo
    // suaviza y saca el "no lo inventes", este test pega.
    assert.ok(/no lo inventes/i.test(_GUARDRAIL));
    assert.ok(/no ten[ée]s acceso/i.test(_GUARDRAIL));
});

test('API_PELADA_PROVIDERS contiene exactamente cerebras y nvidia-nim', () => {
    assert.deepEqual([...API_PELADA_PROVIDERS].sort(), ['cerebras', 'nvidia-nim']);
});
