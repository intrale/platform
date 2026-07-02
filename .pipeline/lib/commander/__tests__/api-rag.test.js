// =============================================================================
// api-rag.test.js — Cobertura del retrieval acotado (RAG) para providers
// API-pelados del Commander (issue #3837).
//
// El módulo recupera material REAL del repo (logs + CLAUDE.md) relacionado con
// la pregunta y lo compone sobre el context-pack estático, para que cerebras/
// nvidia-nim funden su respuesta en hechos y no alucinen (incidente Cerebras/
// Whisper 2026-06-05). Los tests ejercitan filesystem REAL (temp dirs) para que
// las garantías SEC-2 (path-traversal) y SEC-1 (data-residency + redacción) se
// validen contra el comportamiento real, no contra un fs falso.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rag = require('../api-rag');

// -----------------------------------------------------------------------------
// Helper: crea un repo temporal con estructura controlada. `files` es un mapa
// { relPath: contenido }. Crea los directorios intermedios.
// -----------------------------------------------------------------------------
function makeTempRepo(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-test-'));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
    }
    return root;
}

function cleanup(root) {
    try {
        fs.rmSync(root, { recursive: true, force: true });
    } catch { /* best-effort */ }
}

// Sidecar de exclusiones mínimo (mismo shape que el canónico) para no depender
// del archivo real del repo en los tests de scan. Bloquea .env/secrets para
// non_anthropic (SEC-1a).
function fakeResidencyOk() {
    return {
        loadExclusionsOrThrow() {
            return {
                default_policy: {
                    anthropic: 'passthrough',
                    deterministic: 'passthrough',
                    non_anthropic: 'filter',
                },
                exclusions: [
                    { pattern: '**/.env*', providers: ['non_anthropic'], motivo: 'env' },
                    { pattern: '**/secrets/**', providers: ['non_anthropic'], motivo: 'secrets' },
                    { pattern: '**/credentials.json', providers: ['non_anthropic'], motivo: 'creds' },
                ],
            };
        },
        // Delegamos al filtro real para el matcheo de globs (comportamiento honesto).
        filterPathsForProvider: require('../../data-residency-filter').filterPathsForProvider,
    };
}

// -----------------------------------------------------------------------------
// extractKeywords
// -----------------------------------------------------------------------------
test('extractKeywords descarta stopwords, cortos y duplicados', () => {
    const kws = rag._extractKeywords('¿Por qué falló el dispatch de Whisper? falló falló');
    assert.ok(kws.includes('whisper'), 'incluye keyword relevante (minúscula de "Whisper")');
    assert.ok(kws.includes('dispatch'), 'incluye keyword relevante');
    assert.ok(!kws.some((k) => /[A-Z]/.test(k)), 'todas las keywords en minúscula');
    assert.ok(!kws.includes('por'), 'descarta stopword "por"');
    assert.ok(!kws.includes('que'), 'descarta stopword "que"');
    // dedup: "falló" aparece 3 veces, una sola en el resultado
    assert.equal(kws.filter((k) => k === 'falló').length, 1);
});

test('extractKeywords devuelve [] para input vacío o no-string', () => {
    assert.deepEqual(rag._extractKeywords(''), []);
    assert.deepEqual(rag._extractKeywords(null), []);
    assert.deepEqual(rag._extractKeywords(undefined), []);
    assert.deepEqual(rag._extractKeywords(42), []);
});

// -----------------------------------------------------------------------------
// CA-3 — no-op para providers agénticos (ni toca el filesystem)
// -----------------------------------------------------------------------------
test('no-op para provider agéntico (anthropic): devuelve "" sin tocar fs/residency', () => {
    let touched = false;
    const spyResidency = {
        loadExclusionsOrThrow() { touched = true; return { exclusions: [] }; },
        filterPathsForProvider() { touched = true; return { allowed: [] }; },
    };
    const out = rag.augmentPromptWithRag({
        prompt: '¿por qué falló el dispatch?',
        provider: 'anthropic',
        root: '/no/existe',
        residencyImpl: spyResidency,
    });
    assert.equal(out, '');
    assert.equal(touched, false, 'no invoca residency ni grep para agénticos');
});

test('no-op para openai-codex y gemini-google', () => {
    for (const p of ['openai-codex', 'gemini-google', '', null, undefined]) {
        assert.equal(rag.augmentPromptWithRag({ prompt: 'falló X', provider: p, root: '/x' }), '');
    }
});

// -----------------------------------------------------------------------------
// CA-1 — happy path: RAG trae material real citable
// -----------------------------------------------------------------------------
test('happy path: cerebras obtiene material real de logs/ con la keyword', () => {
    const root = makeTempRepo({
        'logs/commander.log': 'El dispatch de Whisper terminó OK en 1200ms, sin timeout.',
        'logs/otro.log': 'contenido irrelevante sin la palabra clave buscada',
        'CLAUDE.md': '# Proyecto\nMonorepo Kotlin.',
    });
    try {
        const out = rag.augmentPromptWithRag({
            prompt: '¿por qué falló el dispatch de Whisper?',
            provider: 'cerebras',
            root,
            residencyImpl: fakeResidencyOk(),
            cache: new Map(),
        });
        assert.ok(out, 'devuelve bloque no vacío');
        assert.ok(out.includes('Whisper'), 'cita material real del log');
        assert.ok(out.includes('logs/commander.log'), 'incluye la referencia al archivo');
        assert.ok(out.includes(rag._RAG_FENCE), 'envuelto en delimitadores de referencia (SEC-4)');
        assert.ok(/no son|referencia|no.*instrucciones/i.test(out), 'marca material como referencia, no instrucciones');
    } finally {
        cleanup(root);
    }
});

// -----------------------------------------------------------------------------
// SEC-1 — sanitización de secrets embebidos en el contenido
// -----------------------------------------------------------------------------
test('SEC-1: un secreto en el log NO llega al bloque (redactado)', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const root = makeTempRepo({
        'logs/dispatch.log': `dispatch de Whisper usó la key ${secret} para firmar la request`,
    });
    try {
        const out = rag.augmentPromptWithRag({
            prompt: 'contame del dispatch de Whisper',
            provider: 'cerebras',
            root,
            residencyImpl: fakeResidencyOk(),
            cache: new Map(),
        });
        assert.ok(out, 'devuelve bloque');
        assert.ok(!out.includes(secret), 'el secreto fue redactado');
        assert.ok(out.includes('[REDACTED]'), 'aparece el marcador de redacción');
        assert.ok(out.includes('Whisper'), 'el resto del material real sigue presente');
    } finally {
        cleanup(root);
    }
});

// -----------------------------------------------------------------------------
// SEC-1a — data-residency: path excluido nunca aparece
// -----------------------------------------------------------------------------
test('SEC-1a: un archivo .env/secrets bloqueado por data-residency nunca se lee', () => {
    const root = makeTempRepo({
        'logs/.env.local': 'dispatch Whisper SECRET_TOKEN=superclave-de-produccion',
        'logs/secrets/creds.txt': 'dispatch Whisper contraseña=hunter2',
        'logs/ok.log': 'dispatch de Whisper corrió normal',
    });
    try {
        const out = rag.augmentPromptWithRag({
            prompt: 'dispatch Whisper',
            provider: 'cerebras',
            root,
            residencyImpl: fakeResidencyOk(),
            cache: new Map(),
        });
        assert.ok(out, 'hay material del archivo permitido');
        assert.ok(!out.includes('superclave-de-produccion'), '.env bloqueado nunca aparece');
        assert.ok(!out.includes('hunter2'), 'secrets/ bloqueado nunca aparece');
        assert.ok(out.includes('logs/ok.log'), 'sólo el archivo permitido se incluye');
    } finally {
        cleanup(root);
    }
});

// -----------------------------------------------------------------------------
// SEC-6 — degradación: filtro no disponible → bloque vacío (fail-closed)
// -----------------------------------------------------------------------------
test('SEC-6: si loadExclusionsOrThrow tira, devuelve "" (fail-closed)', () => {
    const root = makeTempRepo({ 'logs/x.log': 'dispatch Whisper real' });
    try {
        const out = rag.augmentPromptWithRag({
            prompt: 'dispatch Whisper',
            provider: 'cerebras',
            root,
            residencyImpl: {
                loadExclusionsOrThrow() { throw new Error('sidecar corrupto'); },
                filterPathsForProvider() { throw new Error('no debería llamarse'); },
            },
            cache: new Map(),
        });
        assert.equal(out, '', 'degrada al context-pack estático sin romper');
    } finally {
        cleanup(root);
    }
});

test('SEC-6: si filterPathsForProvider tira, devuelve "" (fail-closed)', () => {
    const root = makeTempRepo({ 'logs/x.log': 'dispatch Whisper real' });
    try {
        const out = rag.augmentPromptWithRag({
            prompt: 'dispatch Whisper',
            provider: 'cerebras',
            root,
            residencyImpl: {
                loadExclusionsOrThrow() { return { exclusions: [], default_policy: {} }; },
                filterPathsForProvider() { throw new Error('boom en el filtro'); },
            },
            cache: new Map(),
        });
        assert.equal(out, '');
    } finally {
        cleanup(root);
    }
});

test('SEC-6: sin matches (keyword ausente) → "" (degradación honesta CA-4)', () => {
    const root = makeTempRepo({ 'logs/x.log': 'nada relacionado a la pregunta del usuario' });
    try {
        const out = rag.augmentPromptWithRag({
            prompt: 'contame del componente Xyzzy inexistente',
            provider: 'cerebras',
            root,
            residencyImpl: fakeResidencyOk(),
            cache: new Map(),
        });
        assert.equal(out, '');
    } finally {
        cleanup(root);
    }
});

// -----------------------------------------------------------------------------
// SEC-2 — anti path-traversal: el keyword nunca controla DÓNDE se lee
// -----------------------------------------------------------------------------
test('SEC-2: el material fuera de RAG_ROOTS nunca se lee, aunque el keyword matchee', () => {
    const root = makeTempRepo({
        'logs/in.log': 'dispatch Whisper adentro de logs',
        'sensible/afuera.txt': 'dispatch Whisper AFUERA de las raíces permitidas',
        'src/codigo.js': 'dispatch Whisper en código fuente no allowlisteado',
    });
    try {
        const out = rag.augmentPromptWithRag({
            prompt: 'dispatch Whisper',
            provider: 'cerebras',
            root,
            residencyImpl: fakeResidencyOk(),
            cache: new Map(),
        });
        assert.ok(out.includes('adentro de logs'), 'lee sólo dentro de RAG_ROOTS');
        assert.ok(!out.includes('AFUERA'), 'no lee fuera de las raíces (sensible/)');
        assert.ok(!out.includes('código fuente'), 'no lee src/ (no allowlisteado)');
    } finally {
        cleanup(root);
    }
});

test('SEC-2: keyword con secuencia de traversal no escapa las raíces', () => {
    const root = makeTempRepo({
        'logs/real.log': 'aca hay dispatch de verdad',
        'topsecret.txt': 'esto es un secreto fuera del árbol permitido',
    });
    try {
        // El keyword "../../topsecret" se usa SÓLO como needle sobre contenido;
        // jamás como path. No debe leer topsecret.txt.
        const out = rag.augmentPromptWithRag({
            prompt: 'buscá ../../topsecret y dispatch',
            provider: 'cerebras',
            root,
            residencyImpl: fakeResidencyOk(),
            cache: new Map(),
        });
        assert.ok(!out.includes('secreto fuera del árbol'), 'no hay arbitrary file read vía keyword');
    } finally {
        cleanup(root);
    }
});

// -----------------------------------------------------------------------------
// SEC-5 — cache: material sanitizado, TTL 5 min
// -----------------------------------------------------------------------------
test('SEC-5: segunda llamada dentro del TTL usa cache (no re-escanea)', () => {
    const root = makeTempRepo({ 'logs/c.log': 'dispatch Whisper cacheable' });
    const cache = new Map();
    let clock = 1000;
    const now = () => clock;
    try {
        const first = rag.augmentPromptWithRag({
            prompt: 'dispatch Whisper', provider: 'cerebras', root,
            residencyImpl: fakeResidencyOk(), cache, now,
        });
        assert.ok(first.includes('cacheable'));
        // Mutamos el archivo; dentro del TTL debe devolver el bloque cacheado (viejo).
        fs.writeFileSync(path.join(root, 'logs/c.log'), 'dispatch Whisper MODIFICADO', 'utf8');
        clock += 60 * 1000; // +1 min, dentro del TTL de 5 min
        const second = rag.augmentPromptWithRag({
            prompt: 'dispatch Whisper', provider: 'cerebras', root,
            residencyImpl: fakeResidencyOk(), cache, now,
        });
        assert.equal(second, first, 'devuelve el bloque cacheado');
        assert.ok(!second.includes('MODIFICADO'), 'no re-escaneó (usó cache)');
        // Pasado el TTL, re-escanea.
        clock += 5 * 60 * 1000; // +5 min → expira
        const third = rag.augmentPromptWithRag({
            prompt: 'dispatch Whisper', provider: 'cerebras', root,
            residencyImpl: fakeResidencyOk(), cache, now,
        });
        assert.ok(third.includes('MODIFICADO'), 'tras expirar el TTL re-escanea material fresco');
    } finally {
        cleanup(root);
    }
});

// -----------------------------------------------------------------------------
// Presupuesto de chars
// -----------------------------------------------------------------------------
test('el bloque respeta el cap MAX_RAG_CHARS', () => {
    const big = 'dispatch Whisper ' + 'x'.repeat(20000);
    const root = makeTempRepo({
        'logs/a.log': big,
        'logs/b.log': big,
        'logs/c.log': big,
    });
    try {
        const out = rag.augmentPromptWithRag({
            prompt: 'dispatch Whisper', provider: 'cerebras', root,
            residencyImpl: fakeResidencyOk(), cache: new Map(),
        });
        // El cuerpo de snippets no debe exceder groseramente el presupuesto
        // (el wrapper agrega el preámbulo fijo, acotado).
        assert.ok(out.length < rag.MAX_RAG_CHARS + 1200, `bloque acotado (${out.length} chars)`);
    } finally {
        cleanup(root);
    }
});

// -----------------------------------------------------------------------------
// Integración con el sidecar REAL del repo (SEC-1a end-to-end)
// -----------------------------------------------------------------------------
test('integración: con el sidecar real, .env queda bloqueado para cerebras', () => {
    const root = makeTempRepo({
        'logs/app.env': 'dispatch Whisper TOKEN=no-deberia-verse',   // matchea **/.env* ? No: .env* es prefijo
        'logs/.env.prod': 'dispatch Whisper SUPERSECRETO=nunca',
        'logs/real.log': 'dispatch Whisper corrió bien',
    });
    try {
        const out = rag.augmentPromptWithRag({
            prompt: 'dispatch Whisper', provider: 'cerebras', root,
            // usa el módulo real de data-residency (sidecar canónico del repo)
            cache: new Map(),
        });
        assert.ok(out.includes('real.log'), 'el log normal se incluye');
        assert.ok(!out.includes('SUPERSECRETO'), '.env.prod bloqueado por el sidecar real');
    } finally {
        cleanup(root);
    }
});
