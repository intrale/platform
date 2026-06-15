// =============================================================================
// wave-renderer.js — Renderer Markdown V2 + TTS para el snapshot de ola (#3262).
//
// Recibe el output de `buildWaveSnapshot()` y devuelve:
//   - reply: string MarkdownV2 listo para enviar a Telegram (CA-10 ≤ 4096 chars).
//   - audioText: string corto (≤ 30 palabras) para TTS opt-in (CA-9).
//
// Cumple los CAs visuales:
//   - CA-7  : formato compacto (header + tabla + bloqueos + intervención).
//   - CA-10 : cap a 12 issues + línea "+N en fase X" cuando excede.
//   - CA-11 : header de 1 línea con resumen ejecutivo (bold sobre valores).
//   - CA-12 : emoji semántico con precedencia (blocked > paused > closed > ...).
//   - CA-13 : render degradado si ola sin issues activos.
//   - CA-14 : truncado a 12 con prioridad bloqueados > stale > activos > cerrados.
//   - CA-15 : si la ola no se pudo resolver, header "Ola actual (sin label)".
//   - CA-17 : excluye issues fuera de la ola.
//   - CA-18 : trace line italics con timestamp + antigüedad.
//   - CA-UX-1 : status también en texto (no solo emoji).
//   - CA-UX-2 : separadores con línea en blanco, sin "---".
//   - CA-UX-3 : motivo de bloqueo concreto (no "esperando").
//   - CA-UX-4 : intervención con verbo claro.
//   - CA-UX-5 : etiqueta "humana" (no "Leo").
//   - CA-UX-6 : 0% → "—" en vez de "0%".
//
// El módulo es PURO: no toca disco, no toca red, no escribe TTS audio.
// La generación efectiva del MP3 + envío es responsabilidad del caller
// (pulpo.js / multimedia.js) — acá sólo devolvemos el texto.
// =============================================================================

'use strict';

const { escapeMarkdownV2 } = require('./commander/fill-template');
const { fmtAbsoluteHHMM } = require('./eta');

// Cap "duro" de issues en tabla. PO-CA-14 dice 12.
const MAX_ROWS = 12;
// Cap "blando" de bloques en la sección bloqueos / intervención para no romper CA-10.
const MAX_BLOCKS = 8;
const MAX_INTERVENTIONS = 8;
// Cap de caracteres de Telegram (con margen — el header + códigos de escape
// pueden inflar significativamente el conteo final).
const TELEGRAM_LIMIT = 4096;
const SAFETY_MARGIN = 200;

const STATUS_EMOJI = {
    closed: '✅',
    blocked: '🛑',
    paused: '⏸️',
    approval: '🟢',
    dev: '🔵',
    definition: '🟡',
    pending: '🟡',
};

const STATUS_LABEL = {
    closed: 'cerrado',
    blocked: 'bloqueado',
    paused: 'pausado',
    approval: 'aprobando',
    dev: 'desarrollo',
    definition: 'definicion',
    pending: 'pendiente',
};

/**
 * Prioridad de orden para truncado (CA-14):
 *   1. blocked
 *   2. needs-human / bug-en-pipeline (intervención humana)
 *   3. stale (>= threshold)
 *   4. fases tardías (approval)
 *   5. fases medias (dev)
 *   6. fases tempranas (definition)
 *   7. cerrados
 */
function rankForTruncate(issue) {
    if (issue.isBlocked) return 0;
    if (issue.labels && issue.labels.some((l) => l === 'needs-human' || l === 'bug-en-pipeline')) return 1;
    if (issue.isStale) return 2;
    if (issue.status === 'approval') return 3;
    if (issue.status === 'dev') return 4;
    if (issue.status === 'definition' || issue.status === 'pending') return 5;
    return 6; // closed
}

/**
 * Formatea ms remaining a texto legible: "1h 25m", "45m", "2h".
 */
function formatRemainingMs(remainingMs) {
    if (remainingMs === null || remainingMs === undefined || remainingMs <= 0) return '—';
    const totalMin = Math.round(remainingMs / 60000);
    if (totalMin < 60) return `${totalMin}m`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
}

/**
 * Header ETA: "ETA ~14:32 (1h 25m)" o "ETA insuficiente data".
 * Combina hora absoluta con tiempo restante para el reader humano.
 *
 * #4039 — `etaSource` señaliza la procedencia del número (guideline UX no
 * bloqueante): `'velocity'` → "· ritmo medido" (proyección por velocidad real
 * del conjunto); cualquier otro valor (incl. `'fallback'`) → "· estimación
 * inicial". El texto es portador del significado (no depende de glifo) por
 * accesibilidad. Si `etaSource` no viene, no se agrega sufijo (compat).
 */
function formatEta({ etaAbsoluteMs, etaAvailable, etasMissing, now, etaSource }) {
    if (!etaAvailable || !etaAbsoluteMs) return 'ETA insuficiente data';
    const remaining = etaAbsoluteMs - now;
    const hhmm = fmtAbsoluteHHMM(etaAbsoluteMs);
    const dur = formatRemainingMs(remaining);
    const missingSuffix = etasMissing > 0 ? ` (+${etasMissing} sin estimación)` : '';
    let sourceSuffix = '';
    if (etaSource === 'velocity') sourceSuffix = ' · ritmo medido';
    else if (etaSource === 'fallback') sourceSuffix = ' · estimación inicial';
    return `ETA ~${hhmm} (${dur})${missingSuffix}${sourceSuffix}`;
}

/**
 * Sección "Bloqueos" formateada en MarkdownV2.
 */
function renderBlocksSection(blocks) {
    if (!blocks || blocks.length === 0) return '';
    const visible = blocks.slice(0, MAX_BLOCKS);
    const rest = blocks.length - visible.length;
    const lines = [`🛑 *Bloqueos \\(${blocks.length}\\)*`];
    for (const b of visible) {
        const motivo = escapeMarkdownV2(b.motivo || 'bloqueado');
        lines.push(`• \\#${b.id} → ${motivo}`);
    }
    if (rest > 0) {
        lines.push(`_\\+${rest} bloqueos adicionales_`);
    }
    return lines.join('\n');
}

/**
 * Sección "Intervención humana" — copy estable, sin "Leo" (CA-UX-5).
 */
function renderInterventionSection(items) {
    if (!items || items.length === 0) return '';
    const visible = items.slice(0, MAX_INTERVENTIONS);
    const rest = items.length - visible.length;
    const lines = [`👤 *Intervención humana \\(${items.length}\\)*`];
    for (const it of visible) {
        const motivo = escapeMarkdownV2(it.motivo || 'revisar estado');
        lines.push(`• \\#${it.id} → ${motivo}`);
    }
    if (rest > 0) {
        lines.push(`_\\+${rest} intervenciones adicionales_`);
    }
    return lines.join('\n');
}

// Indicador de rebotes (#4026). Flecha de retorno U+21A9 con el variation
// selector de presentación de TEXTO U+FE0E para evitar que Telegram (sobre todo
// móvil) la mute a emoji de doble ancho `↩️`, lo que rompería la alineación
// monoespaciada del code block (riesgo G2 de UX). El VS es de ancho cero, así
// que el padding de la columna se calcula sobre el ancho VISIBLE (flecha +
// dígitos), no sobre String.length — ver formatBouncesCol.
const BOUNCE_ARROW = '↩︎'; // ↩︎
const BOUNCE_COL_WIDTH = 3; // cubre hasta "↩99"

/**
 * Formatea la columna de rebotes con ancho VISIBLE fijo (BOUNCE_COL_WIDTH).
 * - 0 rebotes → columna vacía (espacios), para no agregar ruido visual (G3).
 * - N rebotes → "↩N" rellenado a ancho visible fijo, preservando alineación.
 * Coerciona defensivamente a entero (requisito de security), aunque el snapshot
 * ya entrega `bounces` como entero.
 */
function formatBouncesCol(rawBounces) {
    const bounces = Number(rawBounces) || 0;
    if (bounces <= 0) return ' '.repeat(BOUNCE_COL_WIDTH);
    const digits = String(bounces);
    const visibleWidth = 1 + digits.length; // flecha (1 celda) + dígitos
    const pad = Math.max(0, BOUNCE_COL_WIDTH - visibleWidth);
    return `${BOUNCE_ARROW}${digits}${' '.repeat(pad)}`;
}

/**
 * Formatea una fila de issue para mostrarla en el bloque tabular monoespaciado.
 * El bloque va en un code block ``` para preservar alineación en Telegram.
 *
 * Layout columnas (ancho fijo aproximado):
 *   ICON  #issue   fase           % avance   rebotes   agente
 *
 * La columna de rebotes (#4026) se ubica inmediatamente a la derecha del % para
 * reforzar la asociación visual causa→efecto (rebote → baja de avance). Para
 * compensar su ancho sin pasar de ~36 chars monospace (clientes móviles) se
 * recorta `fase` 12→11 y `agente` 9→8.
 */
function renderTableRow(issue) {
    const icon = STATUS_EMOJI[issue.status] || '🟡';
    const issueId = `#${issue.id}`.padEnd(6);
    const fase = (issue.faseAbbrev || '—').padEnd(11).slice(0, 11);
    const pctText = issue.pct === 0 && !issue.isClosed ? '—' : `${issue.pct}%`;
    const pctCol = pctText.padStart(4);
    const bouncesCol = formatBouncesCol(issue.bounces);
    const agente = (issue.agente || '—').slice(0, 8);
    return `${icon} ${issueId} ${fase} ${pctCol} ${bouncesCol} ${agente}`;
}

/**
 * Construye el bloque tabular completo aplicando truncado CA-14 + sufijo.
 */
function renderTable(snapshot) {
    const total = snapshot.issues.length;
    if (total === 0) return null;

    // CA-14: ordenar por prioridad de visibilidad (no por número de issue) cuando
    // hay > MAX_ROWS. Cuando hay ≤ MAX_ROWS se mantiene el orden numérico desc
    // para coherencia con el listado tradicional.
    let ordered;
    if (total > MAX_ROWS) {
        ordered = [...snapshot.issues].sort((a, b) => {
            const r = rankForTruncate(a) - rankForTruncate(b);
            if (r !== 0) return r;
            return b.id - a.id;
        });
    } else {
        ordered = [...snapshot.issues].sort((a, b) => b.id - a.id);
    }

    const visible = ordered.slice(0, MAX_ROWS);
    const hidden = ordered.slice(MAX_ROWS);

    const rows = visible.map(renderTableRow);

    // Sufijo agregado por fase para los issues ocultos (CA-14).
    let suffix = '';
    if (hidden.length > 0) {
        const byFase = new Map();
        for (const i of hidden) {
            const key = i.faseAbbrev || '—';
            byFase.set(key, (byFase.get(key) || 0) + 1);
        }
        const parts = [...byFase.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([f, n]) => `${n} en ${f}`);
        suffix = `\n+${hidden.length} más (${parts.join(', ')})`;
    }

    // Code block — no requiere escape interno (CA-UX-2 sin separadores ASCII).
    return '```\n' + rows.join('\n') + suffix + '\n```';
}

/**
 * Línea de trazabilidad final (CA-18).
 * "_Generado 23:48 ART · datos 1.4s_"
 */
function renderTraceLine(now) {
    const d = new Date(now);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    // Antigüedad de datos: en el handler /wave usamos getCachedPipelineState
    // (TTL ~2s), así que mostramos "datos ≤2s" — info simbólica de freshness.
    return `_Generado ${hh}:${mm} ART · datos ≤2s_`;
}

/**
 * Render principal. Devuelve string MarkdownV2 listo.
 *
 * @param {object} snapshot - Output de buildWaveSnapshot.
 * @param {object} [opts]   - { now }
 * @returns {string}
 */
function renderWaveSnapshot(snapshot, opts) {
    const options = opts || {};
    const now = typeof options.now === 'number' ? options.now : Date.now();

    // CA-13: ola sin issues activos → render degradado.
    if (!snapshot || !snapshot.totalIssues || snapshot.totalIssues === 0) {
        const label = escapeMarkdownV2((snapshot && snapshot.waveLabel) || 'Ola actual (sin label)');
        return [
            `🌊 *${label}*`,
            `_Sin issues activos en este momento_`,
            renderTraceLine(now),
        ].join('\n\n');
    }
    if (snapshot.activeCount === 0 && snapshot.closedCount > 0) {
        // Todos cerrados — mostrar header con totalPct=100 y línea informativa.
        const label = escapeMarkdownV2(snapshot.waveLabel);
        return [
            `🌊 *${label}* · *100%* avance · ola completada`,
            `_${snapshot.closedCount}/${snapshot.totalIssues} issues cerrados · sin activos_`,
            renderTraceLine(now),
        ].join('\n\n');
    }

    // Header (CA-11, CA-UX jerarquía bold).
    const label = escapeMarkdownV2(snapshot.waveLabel);
    const pctText = `${snapshot.totalPct}%`;
    const etaText = formatEta({
        etaAbsoluteMs: snapshot.etaAbsoluteMs,
        etaAvailable: snapshot.etaAvailable,
        etasMissing: snapshot.etasMissing,
        now,
        etaSource: snapshot.etaSource,  // #4039 — procedencia del ETA
    });
    // CA-11: bold sobre los valores accionables (label, %, ETA). Para que el
    // ETA tenga bold pero los sufijos discretos ("+N sin estimación",
    // "· ritmo medido"/"· estimación inicial") NO, separamos en cabeza (bold) y
    // cola (texto normal) en el primer marcador de sufijo que aparezca.
    const suffixMarkers = [' (+', ' · '];
    let etaIdxSuffix = -1;
    for (const m of suffixMarkers) {
        const idx = etaText.indexOf(m);
        if (idx > 0 && (etaIdxSuffix === -1 || idx < etaIdxSuffix)) etaIdxSuffix = idx;
    }
    const etaHead = etaIdxSuffix > 0 ? etaText.slice(0, etaIdxSuffix) : etaText;
    const etaTail = etaIdxSuffix > 0 ? etaText.slice(etaIdxSuffix) : '';
    const etaBoldFragment = `*${escapeMarkdownV2(etaHead)}*${etaTail ? escapeMarkdownV2(etaTail) : ''}`;
    const headerLine1 = `🌊 *${label}* · *${escapeMarkdownV2(pctText)}* avance · ${etaBoldFragment}`;
    const counts = [
        `${snapshot.totalIssues} issues`,
        `${snapshot.closedCount} cerrados`,
        `${snapshot.activeCount} activos`,
    ];
    if (snapshot.blocks && snapshot.blocks.length > 0) counts.push(`${snapshot.blocks.length} bloqueados`);
    const headerLine2 = `_${escapeMarkdownV2(counts.join(' · '))}_`;

    const sections = [headerLine1, headerLine2];

    // Tabla (CA-7).
    const table = renderTable(snapshot);
    if (table) sections.push(table);

    // Bloqueos (CA-5).
    const blocks = renderBlocksSection(snapshot.blocks);
    if (blocks) sections.push(blocks);

    // Intervención humana (CA-6, CA-UX-5).
    const interventions = renderInterventionSection(snapshot.humanInterventions);
    if (interventions) sections.push(interventions);

    // Trace line (CA-18).
    sections.push(renderTraceLine(now));

    // Join con doble newline (CA-UX-2 sin separadores).
    let out = sections.join('\n\n');

    // CA-10: garantizar ≤ 4096 chars con margen.
    if (out.length > TELEGRAM_LIMIT - SAFETY_MARGIN) {
        // Truncamiento defensivo (caso patológico, ej. titles muy largos).
        // Re-armamos sin secciones opcionales en orden de menor prioridad.
        const minimal = [
            headerLine1,
            headerLine2,
            table || '',
            renderTraceLine(now),
            `_⚠ Reporte truncado para entrar en Telegram_`,
        ].filter(Boolean).join('\n\n');
        out = minimal.length > TELEGRAM_LIMIT - SAFETY_MARGIN
            ? minimal.slice(0, TELEGRAM_LIMIT - SAFETY_MARGIN) + '\n…'
            : minimal;
    }

    return out;
}

/**
 * Texto corto opt-in para TTS (CA-9). Una sola frase, ≤30 palabras.
 *
 * Formato: "Ola X al N por ciento, ETA Y. Z issues necesitan tu atención."
 * - Si no hay ETA: "ETA por estimar"
 * - Si no hay intervenciones: omitir la 2da cláusula.
 */
function renderAudioText(snapshot, opts) {
    if (!snapshot) return '';
    const options = opts || {};
    const now = typeof options.now === 'number' ? options.now : Date.now();
    const label = snapshot.waveLabel || 'Ola actual';
    const pct = Number.isFinite(snapshot.totalPct) ? snapshot.totalPct : 0;

    if (!snapshot.totalIssues || snapshot.totalIssues === 0) {
        return `${label}: sin issues activos en este momento.`;
    }

    let etaPhrase;
    if (snapshot.etaAvailable && snapshot.etaAbsoluteMs) {
        const remaining = snapshot.etaAbsoluteMs - now;
        etaPhrase = `ETA aproximada ${formatRemainingMs(remaining)}`;
    } else {
        etaPhrase = 'ETA por estimar';
    }

    const intervCount = (snapshot.humanInterventions || []).length;
    const intervPhrase = intervCount > 0
        ? ` ${intervCount} ${intervCount === 1 ? 'issue necesita' : 'issues necesitan'} tu atención.`
        : '';

    return `${label} al ${pct} por ciento, ${etaPhrase}.${intervPhrase}`;
}

module.exports = {
    renderWaveSnapshot,
    renderAudioText,
    // Exports internos para tests.
    _internal: {
        renderTable,
        renderTableRow,
        formatBouncesCol,
        BOUNCE_ARROW,
        BOUNCE_COL_WIDTH,
        renderBlocksSection,
        renderInterventionSection,
        renderTraceLine,
        formatEta,
        formatRemainingMs,
        rankForTruncate,
        MAX_ROWS,
        TELEGRAM_LIMIT,
        STATUS_EMOJI,
    },
};
