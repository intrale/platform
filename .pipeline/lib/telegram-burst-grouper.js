// =============================================================================
// telegram-burst-grouper.js — Agrupador de bursts del drainer Telegram (#3668).
//
// CONTEXTO
// --------
// Antes de este módulo, cada emisor del pipeline que detectaba una condición
// digna de notificación (cross-provider fallback, cost anomaly, agent-models
// change, provider exhaustion, etc.) escribía 1 archivo JSON en
// `.pipeline/servicios/telegram/pendiente/` y el drainer lo enviaba como mensaje
// independiente a Telegram.
//
// La cascada de Sherlock + ola N+1 multi-provider amplificaron un problema
// latente: cuando un provider primario quedaba gateado por cuota o rate-limit
// la cascada generaba 4 archivos casi simultáneos (separados ~7ms), idénticos
// salvo el provider tried. Eso producía:
//
//   ⚠️ Cross-provider fallback activo (anthropic gated, fallback=cerebras)
//   ⚠️ Cross-provider fallback activo (anthropic gated, fallback=gemini)
//   ⚠️ Cross-provider fallback activo (anthropic gated, fallback=nvidia-nim)
//   ⚠️ Cross-provider fallback activo (anthropic gated, fallback=groq)
//
// 4 mensajes Telegram al operador en ~7ms — ceguera por ruido (#3668 contexto).
//
// SOLUCIÓN
// --------
// El drainer (`servicio-telegram.js`), antes de hacer `sendMessage`, agrupa
// archivos por clave compuesta + ventana temporal. Si N>1 archivos cumplen la
// clave dentro de la ventana, se manda 1 solo mensaje consolidado que enumera
// cada intento con su provider+error_class. Los demás archivos del burst se
// marcan como "consumed" (movidos a listo/ con suffix `-bursted-consolidated`)
// sin enviar mensaje propio.
//
// CRITERIOS DE ACEPTACIÓN cubiertos:
//   - CA-1: agrupamiento en el drainer (no en el emisor).
//   - CA-2: clave `pid + meta.type + skill + issue`. Ventana
//           `BURST_WINDOW_MS` configurable con cap hardcoded
//           [BURST_WINDOW_MIN_MS, BURST_WINDOW_MAX_MS].
//   - CA-3: formato enumerado, NO resumen agregado. Si N=1 no consolida.
//   - CA-4: sanitización MarkdownV2 obligatoria de cualquier campo dinámico.
//   - CA-5: audit log NO se agrupa — esto es módulo puro, NO escribe JSONL.
//           Cada emisor sigue emitiendo su entry audit por separado.
//
// UX-1..UX-4 (del comentario del PO):
//   - UX-1: castellano operativo ("Fallback agotado" en vez de "fallback chain
//           agotada").
//   - UX-2: separadores con `·` para skim en mobile.
//   - UX-3: offset relativo `[+Nms]` por intento.
//   - UX-4: cap de enumeración a primeros 5 + "+N más" con link a audit JSONL.
//
// SEC (del análisis de security S-1..S-10):
//   - S-1: `sanitizeRawExcerpt` reutilizada (vía quotaModule) — escapa
//          MarkdownV2 sobre campos dinámicos.
//   - S-2: atomicidad — no se muta archivos existentes; el módulo es puro.
//   - S-3: `pid + skill + issue` en la clave para sobrevivir a restart parcial.
//   - S-4: invariante audit-no-agrupa documentada.
//   - S-5: enumeración explícita (no resumen agregado).
//   - S-10: ventana clampada a [10s, 300s] aunque config diga otra cosa.
//
// SIN dependencias externas (Node puro: fs, path).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// -----------------------------------------------------------------------------
// Hardcoded caps (S-10): defense in depth aunque config.yaml diga otra cosa.
// `BURST_WINDOW_MAX_MS = 300_000` (5 min) cap superior para evitar que un
// operador setee `burst_window_ms: 86_400_000` y suprima notificaciones reales
// por un día. `BURST_WINDOW_MIN_MS = 10_000` evita ventanas tan chicas que el
// agrupamiento sea inútil (anti-spam degenerado).
// -----------------------------------------------------------------------------
const BURST_WINDOW_MIN_MS = 10_000;     // 10s
const BURST_WINDOW_MAX_MS = 300_000;    // 5 min
const BURST_WINDOW_DEFAULT_MS = 60_000; // 60s

// UX-4: cap de enumeración en el mensaje consolidado. Más que 5 hace que el
// mensaje supere el threshold de "barrido visual" del operador. El resto se
// reporta con "+N más (ver audit JSONL)".
const MAX_ENUMERATED_ATTEMPTS = 5;

// Caracteres de control de Telegram MarkdownV2 que requieren escape.
// Fuente: https://core.telegram.org/bots/api#markdownv2-style
// Defense in depth para CA-4 (sanitización MarkdownV2).
const MARKDOWN_V2_SPECIAL = /[_*[\]()~`>#+=|{}.!\\-]/g;

// -----------------------------------------------------------------------------
// loadBurstConfig — Lee `telegram_burst_window_ms` de config.yaml con clamp.
//
// CA-2: si el operador setea un valor fuera del rango [MIN, MAX], se clampea
// y se emite un warning (vía logger inyectable). Default safe = 60_000.
//
// La función es defensive: si el configLoader tira excepción o el campo no
// existe / no es número, retorna el default sin loguear nada.
// -----------------------------------------------------------------------------
function loadBurstConfig({ configLoader, log } = {}) {
    let cfg = {};
    try {
        cfg = (typeof configLoader === 'function') ? (configLoader() || {}) : {};
    } catch {
        cfg = {};
    }
    const raw = Number(cfg.telegram_burst_window_ms);
    if (!Number.isFinite(raw) || raw <= 0) {
        return {
            windowMs: BURST_WINDOW_DEFAULT_MS,
            clamped: false,
            sourceValue: cfg.telegram_burst_window_ms === undefined ? null : cfg.telegram_burst_window_ms,
        };
    }
    if (raw < BURST_WINDOW_MIN_MS) {
        if (typeof log === 'function') {
            log('burst-grouper', `⚠️ telegram_burst_window_ms=${raw} debajo del mínimo (${BURST_WINDOW_MIN_MS}ms), clampeando.`);
        }
        return { windowMs: BURST_WINDOW_MIN_MS, clamped: true, sourceValue: raw };
    }
    if (raw > BURST_WINDOW_MAX_MS) {
        if (typeof log === 'function') {
            log('burst-grouper', `⚠️ telegram_burst_window_ms=${raw} arriba del máximo (${BURST_WINDOW_MAX_MS}ms), clampeando.`);
        }
        return { windowMs: BURST_WINDOW_MAX_MS, clamped: true, sourceValue: raw };
    }
    return { windowMs: raw, clamped: false, sourceValue: raw };
}

// -----------------------------------------------------------------------------
// sanitizeMarkdownV2 — Escape de caracteres de control de Telegram MarkdownV2.
//
// CA-4 / S-1: cualquier campo dinámico que se interpole al texto consolidado
// DEBE pasar por esta función para evitar render injection o break del parser.
// Reutilizamos el patrón ya usado por sanitizeRawExcerpt en quota-exhausted.js,
// pero aplicado específicamente al subset de MarkdownV2.
//
// Strip de CR/LF: cualquier salto de línea inyectado se convierte en espacio
// para no romper la enumeración multilínea del mensaje consolidado.
// -----------------------------------------------------------------------------
function sanitizeMarkdownV2(text) {
    if (text == null) return '';
    return String(text)
        .replace(/\r\n|\r|\n/g, ' ')            // CRLF/LF → espacio (anti CWE-117 + render)
        .replace(MARKDOWN_V2_SPECIAL, (m) => `\\${m}`)
        .slice(0, 200);                         // cap por campo (anti-DoS de payload)
}

// -----------------------------------------------------------------------------
// loadFileSafe — Lee un archivo JSON del directorio pendiente con shape estable.
//
// Devuelve `{ ok: true, file, parsed, mtimeMs, key }` o `{ ok: false, ... }`.
// El `key` es el discriminador de agrupamiento: combinación
// `pid + meta.type + skill + issue` extraída del payload.
//
// `pid` se busca primero en `meta.pid` (emisor lo declara explícitamente) y
// como fallback en el filename, donde dispatch-with-fallback escribe el formato
// `cross-provider-{timestamp}-{pid}.json`. La regex es defensiva: si el match
// falla, `pid='unknown'` (no romper).
// -----------------------------------------------------------------------------
function loadFileSafe({ filePath, fileName, fsImpl }) {
    const _fs = fsImpl || fs;
    try {
        const stat = _fs.statSync(filePath);
        const raw = _fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        const meta = (parsed && typeof parsed === 'object' && parsed.meta) || {};
        const pid = String(meta.pid || extractPidFromFilename(fileName) || 'unknown');
        const type = String(parsed.type || meta.type || 'unknown');
        const skill = String(meta.skill || 'unknown');
        const issue = String(meta.issue == null ? 'unknown' : meta.issue);
        const key = `${pid}|${type}|${skill}|${issue}`;
        return {
            ok: true,
            file: fileName,
            filePath,
            parsed,
            meta,
            mtimeMs: stat.mtimeMs,
            key,
            pid,
            type,
            skill,
            issue,
        };
    } catch (e) {
        return { ok: false, file: fileName, filePath, error: e && e.message ? e.message : String(e) };
    }
}

function extractPidFromFilename(fileName) {
    if (!fileName || typeof fileName !== 'string') return null;
    // Patrón emitido por dispatch-with-fallback: `cross-provider-{ts}-{pid}.json`
    const m = fileName.match(/-(\d+)\.json$/);
    return m ? m[1] : null;
}

// -----------------------------------------------------------------------------
// groupByBurst — Agrupa archivos por clave compuesta dentro de la ventana.
//
// CA-2: clave = `pid + meta.type + skill + issue`. Ventana = `windowMs`.
//
// Algoritmo:
//   1. Cargar metadata de cada archivo (mtime + key derivada del payload).
//   2. Ordenar por mtime ascendente (más viejo primero).
//   3. Iterar: para cada archivo, si ya está asignado a un grupo skip;
//      sino, abrir grupo nuevo y agregar todos los archivos con la misma
//      key cuyo mtime cae dentro de [base.mtime, base.mtime + windowMs].
//
// Devuelve `[{ key, files: [{file, filePath, parsed, mtimeMs, ...}, ...] }]`.
// Cada `files[]` viene ordenado por mtime ascendente.
//
// Archivos malformados (`loadFileSafe` devolvió `ok:false`) van en un grupo
// propio con `key: '__unparseable__'` y `files: [{file, error}]`. El drainer
// los procesa como mensajes individuales (back-compat con archivos viejos).
// -----------------------------------------------------------------------------
function groupByBurst({ fileEntries, windowMs, fsImpl }) {
    const win = Number.isFinite(windowMs) ? windowMs : BURST_WINDOW_DEFAULT_MS;
    const loaded = fileEntries.map((entry) =>
        loadFileSafe({ filePath: entry.path, fileName: entry.name, fsImpl })
    );
    // Sort por mtime ascendente (los unparseable van al final con mtime=Infinity).
    loaded.sort((a, b) => {
        const ma = a.ok ? a.mtimeMs : Number.POSITIVE_INFINITY;
        const mb = b.ok ? b.mtimeMs : Number.POSITIVE_INFINITY;
        return ma - mb;
    });

    const groups = [];
    const assigned = new Set();
    for (let i = 0; i < loaded.length; i++) {
        if (assigned.has(i)) continue;
        const base = loaded[i];
        if (!base.ok) {
            groups.push({ key: '__unparseable__', files: [base] });
            assigned.add(i);
            continue;
        }
        const groupFiles = [base];
        assigned.add(i);
        for (let j = i + 1; j < loaded.length; j++) {
            if (assigned.has(j)) continue;
            const cand = loaded[j];
            if (!cand.ok) continue;
            if (cand.key !== base.key) continue;
            if ((cand.mtimeMs - base.mtimeMs) > win) continue;
            groupFiles.push(cand);
            assigned.add(j);
        }
        groups.push({ key: base.key, files: groupFiles });
    }
    return groups;
}

// -----------------------------------------------------------------------------
// extractAttemptSummary — Extrae los campos relevantes para enumerar en el
// mensaje consolidado. Cada emisor declara su shape en `meta`, pero el grupo
// puede mezclar tipos distintos (defensive). El extractor mira los campos
// canónicos en orden de preferencia.
//
// Campos buscados (S-5):
//   - provider:    `meta.fallback_provider || meta.primary_provider || meta.provider`
//   - status:      `meta.status || (meta.gated ? 'gated' : 'failed')`
//   - error_class: `meta.error_class || meta.errorCode || meta.error_type`
//
// Si no encuentra nada, devuelve `{provider: 'desconocido', status: '?',
// errorClass: '?'}` — el operador igual ve algo informativo.
// -----------------------------------------------------------------------------
function extractAttemptSummary(fileEntry) {
    const meta = fileEntry.meta || {};
    const parsed = fileEntry.parsed || {};
    const provider = String(
        meta.fallback_provider
        || meta.provider
        || meta.primary_provider
        || parsed.provider
        || 'desconocido'
    );
    const status = String(
        meta.status
        || (meta.gated ? 'gated' : (meta.fallback_provider ? 'failed' : 'info'))
    );
    const errorClass = String(
        meta.error_class
        || meta.errorCode
        || meta.error_type
        || '?'
    );
    return { provider, status, errorClass };
}

// -----------------------------------------------------------------------------
// formatConsolidatedMessage — Arma el texto Telegram consolidado para un burst.
//
// CA-3 + UX-1/UX-2/UX-3/UX-4:
//   - Header en castellano operativo, separadores `·`, conteo + skill + issue.
//   - Bloque enumerado dentro de ``` ``` para alineación monospace.
//   - Offset relativo `[+Nms]` por intento (calculado desde la base del grupo).
//   - Cap enumerado MAX_ENUMERATED_ATTEMPTS + sufijo "+M más".
//   - Sanitización MarkdownV2 sobre TODO campo dinámico (provider, status,
//     errorClass, skill, issue).
//
// Si el grupo tiene 1 sólo archivo (N=1), NO consolida — devuelve null para
// que el drainer envíe el mensaje original del archivo sin modificar.
// -----------------------------------------------------------------------------
function formatConsolidatedMessage(group, { now } = {}) {
    if (!group || !group.files || group.files.length < 2) return null;
    const files = group.files;
    const baseMtime = files[0].mtimeMs || (Number.isFinite(now) ? now : Date.now());
    const lastMtime = files[files.length - 1].mtimeMs || baseMtime;
    const totalMs = Math.max(0, Math.round(lastMtime - baseMtime));

    // Inferir tipo predominante: el primer file marca el tono.
    const baseType = files[0].type || 'evento';
    const baseSkill = sanitizeMarkdownV2(files[0].skill || 'desconocido');
    const baseIssue = sanitizeMarkdownV2(files[0].issue || 'desconocido');

    // Mapeo de tipo → label en castellano. Por defecto, normalizamos.
    const typeLabel =
        baseType === 'cross-provider-fallback' ? 'Cross-provider fallback'
        : baseType === 'cost-anomaly' ? 'Anomalía de costo'
        : baseType === 'agent-models-change' ? 'Cambio de modelos'
        : baseType === 'provider-exhaustion' ? 'Provider exhausto'
        : sanitizeMarkdownV2(baseType);

    const lines = [];
    lines.push(`⚠️ ${typeLabel} · ${files.length} intentos · ${totalMs}ms · skill=${baseSkill} · #${baseIssue}`);
    lines.push('```');

    const enumerated = Math.min(files.length, MAX_ENUMERATED_ATTEMPTS);
    for (let i = 0; i < enumerated; i++) {
        const f = files[i];
        const offset = Math.max(0, Math.round((f.mtimeMs || baseMtime) - baseMtime));
        const att = extractAttemptSummary(f);
        const provider = sanitizeMarkdownV2(att.provider);
        const status = sanitizeMarkdownV2(att.status);
        const errorClass = sanitizeMarkdownV2(att.errorClass);
        const idx = String(i + 1).padStart(2, ' ');
        const provPad = provider.padEnd(14, ' ').slice(0, 14);
        const offPad = `[+${offset}ms]`.padEnd(10, ' ');
        lines.push(`${idx}. ${provPad} ${offPad} ${status}: ${errorClass}`);
    }
    if (files.length > enumerated) {
        const remaining = files.length - enumerated;
        const today = (new Date()).toISOString().slice(0, 10);
        lines.push(`… +${remaining} más (ver cross-provider-${today}.jsonl)`);
    }
    lines.push('```');
    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------
module.exports = {
    loadBurstConfig,
    sanitizeMarkdownV2,
    loadFileSafe,
    groupByBurst,
    extractAttemptSummary,
    formatConsolidatedMessage,
    // constants
    BURST_WINDOW_MIN_MS,
    BURST_WINDOW_MAX_MS,
    BURST_WINDOW_DEFAULT_MS,
    MAX_ENUMERATED_ATTEMPTS,
    MARKDOWN_V2_SPECIAL,
    // exposed for tests
    _extractPidFromFilename: extractPidFromFilename,
};
