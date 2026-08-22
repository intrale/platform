// =============================================================================
// rewind-event-adapter.js — Adapter entre el producer del Commander (#3441) y
// el consumer del rewind del Pulpo (#3416).
// =============================================================================
//
// El productor (`lib/commander/rechazar-handler.js`, mergeado en main vía
// #3441) escribe eventos en `.pipeline/rejections/<issue>-<unixTs>.json` con
// este shape:
//
//   {
//     issue,
//     fase,              // alias tipeado por el operador
//     fase_resolved,     // "pipeline/fase" ya resuelto
//     motivo,
//     ts,                // ISO timestamp
//     source,            // 'text' | 'audio' (origen de transcripción)
//     chat_id,           // identidad del operador en Telegram
//     audit_ref,         // nombre del archivo audit del día
//   }
//
// El consumidor (`lib/pipeline-rewind.js#rewindIssueToPhase`) espera otro shape:
//
//   {
//     issue,
//     alias,             // alias del operador (ej. "ux", "validacion-po")
//     motivo,
//     operatorId,        // identidad del emisor (chat_id, cli, etc.)
//     source,            // 'telegram-commander' | 'cli-local'
//   }
//
// La review del PR #3416 detectó cuatro mismatches:
//   1. Path: producer escribe en `.pipeline/rejections/`, consumer leía
//      `.pipeline/eventos/pipeline-rejection/pendiente/`.
//   2. `event.fase` vs `event.alias` (siempre ALIAS_EMPTY).
//   3. `event.chat_id` vs `event.operatorId` (siempre OPERATOR_ID_REQUIRED).
//   4. `event.source` ('text'/'audio') vs whitelist
//      ('telegram-commander'/'cli-local') (siempre SOURCE_NOT_AUTHORIZED).
//
// Este módulo encapsula la traducción 1→1. Vive aislado para que sea testeable
// sin levantar pulpo.js entero y para que un cambio en el contrato del producer
// (ej. #3441 termina agregando `source_envelope`) se aplique acá sin tocar el
// brazoRewind.
// =============================================================================
'use strict';

/**
 * Convierte un evento escrito por el producer del Commander (#3441) en el
 * shape que consume `rewindIssueToPhase`.
 *
 * Reglas:
 *   - `event.fase` (alias tipeado por el operador) → `alias`.
 *   - `event.chat_id` (entero o string) → `operatorId` (stringificado).
 *   - `event.source` ('text'/'audio'/'whisper-local'/...) → 'telegram-commander'
 *     (por definición, cualquier evento en `.pipeline/rejections/` proviene del
 *     Commander de Telegram; el transcribe source original se preserva en
 *     `_envelope.transcribe_source` para forensics).
 *   - `event.motivo` → `motivo` sin transformar.
 *
 * Si `event` no tiene los campos críticos (issue, fase, chat_id), devuelve
 * el shape parcial igual: el consumer (`rewindIssueToPhase`) ya rechaza con
 * códigos descriptivos (`ISSUE_REQUIRED`, `ALIAS_EMPTY`, `OPERATOR_ID_REQUIRED`).
 *
 * Tolerancia hacia adelante: si llega un evento con shape "nuevo" (alias,
 * operatorId, source ya válido), lo deja pasar sin doble-traducir. Esto
 * permite que el smoke test viejo siga funcionando y que un eventual upgrade
 * del producer (que agregue `source_envelope: 'telegram-commander'`) no rompa
 * acá.
 *
 * @param {object} event - JSON parseado del archivo en `.pipeline/rejections/`.
 * @returns {{
 *   issue: number|string|null,
 *   alias: string|null,
 *   motivo: string|null,
 *   operatorId: string|null,
 *   source: string,
 *   _envelope: {
 *     fase_resolved: string|null,
 *     transcribe_source: string|null,
 *     audit_ref: string|null,
 *     ts: string|null,
 *     chat_id: string|null,
 *   },
 * }}
 */
function normalizeProducerEvent(event) {
    const e = event || {};

    // Campos del producer.
    const fase = e.fase != null ? String(e.fase) : null;
    const chatId = e.chat_id != null ? String(e.chat_id) : null;
    const transcribeSource = e.source != null ? String(e.source) : null;
    const faseResolved = e.fase_resolved != null ? String(e.fase_resolved) : null;
    const auditRef = e.audit_ref != null ? String(e.audit_ref) : null;
    const ts = e.ts != null ? String(e.ts) : null;

    // Tolerancia hacia adelante: si el evento ya tiene shape "nuevo" lo
    // respetamos. Esto sostiene tests existentes y un eventual upgrade del
    // producer sin doble-traducir.
    const alias = e.alias != null ? String(e.alias) : fase;
    const operatorId = e.operatorId != null ? String(e.operatorId) : chatId;

    // Normalización de source:
    //   - si ya viene un valor de la whitelist del consumer, lo respetamos
    //     (tests existentes pasan 'telegram-commander').
    //   - si viene un transcribeSource del producer ('text'/'audio'/...),
    //     forzamos a 'telegram-commander' porque por definición el archivo
    //     vino del bus de rejections del Commander.
    //   - si viene vacío y hay chat_id, asumimos 'telegram-commander' (el
    //     operador escribió por Telegram).
    //   - si viene vacío y NO hay chat_id, dejamos vacío y el consumer
    //     rechaza con SOURCE_NOT_AUTHORIZED (no inventamos identidad).
    const WHITELIST = new Set(['telegram-commander', 'cli-local']);
    let normalizedSource;
    if (transcribeSource && WHITELIST.has(transcribeSource)) {
        normalizedSource = transcribeSource;
    } else if (chatId) {
        // Producer del Telegram Commander, sin importar si fue texto o audio.
        normalizedSource = 'telegram-commander';
    } else if (transcribeSource) {
        // Tenemos un source pero no es de la whitelist y no hay chat_id:
        // lo dejamos pasar tal cual para que el consumer lo bloquee con
        // SOURCE_NOT_AUTHORIZED y quede el rastro en audit.
        normalizedSource = transcribeSource;
    } else {
        normalizedSource = '';
    }

    return {
        issue: e.issue != null ? e.issue : null,
        alias,
        motivo: e.motivo != null ? String(e.motivo) : null,
        operatorId,
        source: normalizedSource,
        _envelope: {
            fase_resolved: faseResolved,
            transcribe_source: transcribeSource,
            audit_ref: auditRef,
            ts,
            chat_id: chatId,
        },
    };
}

module.exports = {
    normalizeProducerEvent,
};
