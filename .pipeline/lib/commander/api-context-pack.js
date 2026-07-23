// =============================================================================
// commander/api-context-pack.js — Inyección de contexto del proyecto + guardrail
// anti-alucinación para los providers integrados como API REST pelada.
//
// PROBLEMA QUE RESUELVE (incidente Cerebras/Whisper 2026-06-05)
// ------------------------------------------------------------
// Los providers del Commander se integran de dos formas distintas:
//
//   - CLI AGÉNTICO (anthropic, openai-codex, gemini-google): arrancan con
//     herramientas (leer archivos, grep, logs, ejecutar comandos). Cuando se
//     les pregunta "¿por qué falló X?", PRIMERO investigan el repo y los logs
//     y después contestan sobre material real.
//
//   - API REST PELADA (cerebras, nvidia-nim): endpoints OpenAI-compatible
//     `chat/completions` sin estado. Reciben SOLO el texto del prompt + el
//     system prompt. No ven el filesystem, ni los logs, ni el runtime. Si se
//     les pregunta por estado en vivo, no tienen cómo chequear nada y tienden
//     a **rellenar con una explicación plausible pero falsa** (alucinación).
//
// Eso fue exactamente lo que pasó: con Anthropic/Codex/Gemini apagados, el
// fallback cayó en Cerebras y, ante "¿por qué no llegó la transcripción?",
// inventó un cuento sobre un timeout de Whisper que nunca ocurrió.
//
// SOLUCIÓN (opción "más simple" — inyección de contexto estático)
// ---------------------------------------------------------------
// Antes de spawnear un provider API-pelado, le aumentamos el system prompt con:
//   1. Un GUARDRAIL anti-alucinación: le decimos explícitamente que en este
//      modo no ve el runtime y que, ante preguntas de estado en vivo, debe
//      admitir el límite en vez de inventar.
//   2. Un CONTEXTO DEL PROYECTO estático (extracto de CLAUDE.md, la fuente de
//      verdad del repo) para que las preguntas conceptuales/de arquitectura las
//      conteste sobre material real y no sobre suposiciones.
//
// Los providers agénticos NO se tocan (ya ven el repo de verdad): el augment es
// un no-op para todo provider que no esté en `API_PELADA_PROVIDERS`.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// -----------------------------------------------------------------------------
// Providers integrados como API REST pelada (sin CLI agéntico ni herramientas).
// Frozen a propósito: agregar un provider acá es una decisión consciente, no un
// efecto colateral. Los providers agénticos (anthropic, openai-codex,
// gemini-google) NO van en este set.
// -----------------------------------------------------------------------------
const API_PELADA_PROVIDERS = Object.freeze(new Set(['cerebras', 'nvidia-nim']));

// Cap del extracto de CLAUDE.md inyectado. El free tier de Cerebras tiene TPM
// bajo (~60K) y el prompt ya incluye persona + historial; 6000 chars (~1.5K
// tokens) alcanzan para grounding sin reventar el budget.
const MAX_PROJECT_DOC_CHARS = 6000;

// -----------------------------------------------------------------------------
// GUARDRAIL — la parte más importante del pack. Le marca al modelo API-pelado
// que NO tiene visibilidad del runtime y que ante preguntas de estado en vivo
// debe admitir el límite antes que inventar.
// -----------------------------------------------------------------------------
const GUARDRAIL = `LÍMITES DE ESTE MODO DE RESPALDO (leer con atención):
- Estás respondiendo como proveedor de respaldo vía API REST. En este modo NO tenés acceso al filesystem, a los logs, ni al estado en vivo del pipeline. NO podés ejecutar comandos, leer archivos ni inspeccionar procesos.
- El bloque "CONTEXTO DEL PROYECTO" de abajo es TODO lo que sabés del sistema. No des por cierto nada que no esté ahí.
- Si te preguntan por estado en vivo —por qué falló algo, qué dice un log, si un proceso está corriendo, el resultado de una corrida, métricas actuales— NO lo inventes. Decí con claridad que en este modo de respaldo no podés inspeccionar el runtime y que para eso hace falta que lo revise el Commander corriendo sobre Claude/Codex. Es preferible admitir el límite a dar una explicación plausible pero falsa.
- Para preguntas conceptuales o de arquitectura (cómo funciona X, qué es Y, cómo está organizado el proyecto) usá el contexto del proyecto y respondé normal.`;

// -----------------------------------------------------------------------------
// readProjectDoc — lee CLAUDE.md de la raíz del repo y lo recorta al cap.
// Devuelve null si no se puede leer (el pack sigue funcionando solo con el
// guardrail, que es lo crítico).
// -----------------------------------------------------------------------------
function readProjectDoc(root, fsImpl) {
    const _fs = fsImpl || fs;
    try {
        const p = path.join(root || process.cwd(), 'CLAUDE.md');
        const raw = _fs.readFileSync(p, 'utf8');
        if (typeof raw !== 'string' || !raw.trim()) return null;
        if (raw.length <= MAX_PROJECT_DOC_CHARS) return raw.trim();
        return raw.slice(0, MAX_PROJECT_DOC_CHARS).trim() + '\n\n[…documento truncado…]';
    } catch {
        return null;
    }
}

// -----------------------------------------------------------------------------
// buildContextPack — arma el bloque de contexto (guardrail + extracto de doc).
// El guardrail va SIEMPRE; el contexto del proyecto solo si pudimos leer la doc.
// -----------------------------------------------------------------------------
function buildContextPack(opts = {}) {
    const { root, fsImpl } = opts;
    const parts = [GUARDRAIL];
    const doc = readProjectDoc(root, fsImpl);
    if (doc) {
        parts.push(
            `CONTEXTO DEL PROYECTO (extracto de CLAUDE.md, fuente de verdad del repo):\n${doc}`
        );
    }
    return parts.join('\n\n');
}

// -----------------------------------------------------------------------------
// isApiPeladaProvider — true si el provider se integra como API REST pelada.
// -----------------------------------------------------------------------------
function isApiPeladaProvider(provider) {
    return API_PELADA_PROVIDERS.has(String(provider == null ? '' : provider).trim());
}

// -----------------------------------------------------------------------------
// augmentSystemPromptForProvider — devuelve el system prompt aumentado con el
// pack SOLO si el provider es API-pelado. Para providers agénticos (o input
// inválido) devuelve el system prompt tal cual (no-op).
// -----------------------------------------------------------------------------
function augmentSystemPromptForProvider(systemPrompt, provider, opts = {}) {
    const base = typeof systemPrompt === 'string' ? systemPrompt : '';
    if (!isApiPeladaProvider(provider)) return base;
    const pack = buildContextPack(opts);
    if (!pack) return base;
    return base ? `${base}\n\n${pack}` : pack;
}

module.exports = {
    API_PELADA_PROVIDERS,
    MAX_PROJECT_DOC_CHARS,
    isApiPeladaProvider,
    buildContextPack,
    augmentSystemPromptForProvider,
    // exports internos para tests
    _GUARDRAIL: GUARDRAIL,
    _readProjectDoc: readProjectDoc,
};
