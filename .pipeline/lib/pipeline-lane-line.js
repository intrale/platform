'use strict';

// =============================================================================
// pipeline-lane-line.js — Lógica pura del rediseño "ola en una sola línea"
// (EP8-H3 · #3956). El board del pipeline representa el ciclo de vida íntegro
// de la ola de punta a punta dentro de una misma línea horizontal:
//
//   ⏳ No ingresados → Definición → Desarrollo → QA + Entrega → ✅ Finalizados
//
// Este módulo concentra la lógica testeable y los requisitos de seguridad
// (CA-8/CA-9/CA-10) para que el render del dashboard (monolito `dashboard.js`)
// consuma helpers verificados en vez de concatenar strings crudos:
//
//   - safeGithubHref()       → CA-9: valida esquema https://github.com/, rechaza
//                              javascript:/data:/http: y hosts ajenos.
//   - escForHtml()           → CA-8: escape unificado (cuerpo + atributos).
//   - escapePopupValue()     → CA-8: gemelo server-side del escape que usa el
//                              popover client-side (showDotPopup) para evitar el
//                              XSS confirmado en motivo/skill/log.
//   - buildNotEnteredCards() → CA-5: etapa "No ingresados" con motivo + link al
//                              bloqueante, degradando a "esperando slot".
//   - finalizadoMeta()       → CA-6: fecha de cierre + link al PR mergeado,
//                              degradando a "sin link" si el fetch falló.
//
// Sin estado, sin I/O: recibe datos ya computados. Testeable con node --test.
// =============================================================================

/**
 * Escapa texto para uso en cuerpo HTML y atributos. Mismo conjunto que el
 * helper `esc()` del dashboard (& < > " ') para poder usarse en ambos contextos
 * sin sorpresas. null/undefined → ''.
 *
 * @param {*} input
 * @returns {string}
 */
function escForHtml(input) {
    return String(input == null ? '' : input)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * CA-8 — gemelo server-side del escape que aplica el popover client-side.
 * Idéntico a `escForHtml`: se mantiene como alias semántico para dejar
 * explícito en los tests que el popover (motivo/skill/log) pasa por aquí.
 *
 * @param {*} input
 * @returns {string}
 */
function escapePopupValue(input) {
    return escForHtml(input);
}

/**
 * CA-9 — valida que `url` sea un link seguro de GitHub. Devuelve el href
 * normalizado si es `https://github.com/...`, o `null` en cualquier otro caso
 * (esquemas peligrosos `javascript:`/`data:`, `http:` plano, hosts ajenos,
 * URLs malformadas o no-string).
 *
 * @param {*} url
 * @returns {string|null}
 */
function safeGithubHref(url) {
    if (typeof url !== 'string' || url.length === 0) return null;
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'https:') return null;
    // Solo github.com (no subdominios arbitrarios tipo evil.github.com.attacker).
    if (parsed.hostname !== 'github.com') return null;
    return parsed.href;
}

/**
 * Trunca un título largo agregando elipsis. Opera sobre el texto SIN escapar
 * para que el corte cuente caracteres reales; el llamador escapa el resultado.
 *
 * @param {string} text
 * @param {number} [max=52]
 * @returns {string}
 */
function truncate(text, max = 52) {
    const s = String(text == null ? '' : text);
    if (s.length <= max + 3) return s;
    return s.slice(0, max) + '…';
}

/**
 * Formatea un timestamp (ISO-8601 o epoch ms) como fecha corta es-AR.
 * Devuelve null si no es parseable (degradación CA-6).
 *
 * @param {string|number|null} value
 * @returns {string|null}
 */
function formatCloseDate(value) {
    if (value == null || value === '') return null;
    const t = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(t)) return null;
    try {
        return new Date(t).toLocaleDateString('es-AR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
        });
    } catch {
        return null;
    }
}

/**
 * CA-6 — deriva los metadatos visuales de un issue finalizado a partir del
 * prInfo cacheado. Degrada con gracia a "sin link" si el fetch falló, no hay
 * PR detectable, o la URL no pasa la validación de esquema GitHub.
 *
 * @param {object|null} prInfo  Resultado de pr-info-fetcher (cacheado) o null.
 *   Forma esperada: { mergedAt, url, state } | { error: true } | null.
 * @returns {{ dateLabel: string|null, href: string|null, hasLink: boolean }}
 */
function finalizadoMeta(prInfo) {
    if (!prInfo || prInfo.error) {
        return { dateLabel: null, href: null, hasLink: false };
    }
    const href = safeGithubHref(prInfo.url);
    const dateLabel = formatCloseDate(prInfo.mergedAt);
    return {
        dateLabel,
        href: href || null,
        hasLink: !!href,
    };
}

/**
 * Deriva el motivo de no-ingreso de un issue de la ola que aún no entró al
 * flujo de fases. CA-5: deps abiertas (con link al bloqueante) o "esperando
 * slot" como degradación cuando no hay dato de dependencias.
 *
 * @param {object} params
 * @param {string|number} params.issue
 * @param {number[]|undefined} params.blockedBy  IDs de issues bloqueantes.
 * @param {number|null} params.queuePos          posición en cola (1-based) o null.
 * @param {(num: string|number) => string} params.ghIssueUrl  builder de URL GH.
 * @returns {{ kind: 'deps'|'slot', html: string }}
 */
function notEnteredReason({ blockedBy, queuePos, ghIssueUrl }) {
    const deps = Array.isArray(blockedBy) ? blockedBy.filter((d) => d != null) : [];
    if (deps.length > 0) {
        const links = deps
            .map((d) => {
                const href = safeGithubHref(ghIssueUrl(d));
                const label = '#' + escForHtml(d);
                return href
                    ? `<a class="nentered-dep-link" href="${escForHtml(href)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${label}</a>`
                    : `<span class="nentered-dep-link">${label}</span>`;
            })
            .join(', ');
        return {
            kind: 'deps',
            html: `<span class="nentered-reason nentered-reason-deps" title="Bloqueado por dependencias abiertas">🔗 Bloqueado por ${links}</span>`,
        };
    }
    const posTxt = Number.isInteger(queuePos) && queuePos > 0
        ? ` · pos. ${queuePos}`
        : '';
    return {
        kind: 'slot',
        html: `<span class="nentered-reason nentered-reason-slot" title="Esperando un slot libre en la cola">⏳ Esperando slot${posTxt}</span>`,
    };
}

/**
 * CA-5 — construye las cards de la etapa inicial "No ingresados". Un issue
 * de la ola califica si: pertenece a la ola activa, NO tiene work-file en
 * ninguna fase (no está en `matrix`) y NO está cerrado (los cerrados van a
 * "Finalizados"). Cada card muestra el motivo de no-ingreso.
 *
 * Seguridad: títulos escapados (CA-8), links validados con safeGithubHref (CA-9),
 * sin datos sensibles (CA-10 — solo issue/título/motivo/links).
 *
 * @param {object} params
 * @param {number[]} params.waveIssues          IDs de la ola activa.
 * @param {object} params.matrix                state.issueMatrix (issue→data).
 * @param {object} params.blockedBy             state.blockedIssues.blockedBy.
 * @param {object} params.titles                state.issueTitles (issue→{title,state}).
 * @param {(num: string|number) => string} params.ghIssueUrl
 * @returns {{ count: number, cards: Array<{issue: string, html: string}> }}
 */
function buildNotEnteredCards({ waveIssues, matrix, blockedBy, titles, ghIssueUrl }) {
    const wave = Array.isArray(waveIssues) ? waveIssues : [];
    const mtx = matrix || {};
    const blocked = blockedBy || {};
    const titleMap = titles || {};
    const cards = [];
    const seen = new Set();
    // Posición en cola: los no-ingresados sin deps se ordenan por número de
    // issue ascendente como proxy estable de "orden de llegada". Degradación
    // documentada en la narrativa UX (no hay cola materializada en FS).
    let slotPos = 0;
    const ordered = [...wave]
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n > 0)
        .sort((a, b) => a - b);

    for (const n of ordered) {
        const key = String(n);
        if (seen.has(key)) continue;
        // Ya está en el flujo (tiene work-file en alguna fase) → se dibuja en
        // su columna, no en "No ingresados" (anti-duplicado CA-7).
        if (mtx[key]) continue;
        const meta = titleMap[key] || {};
        const isClosed = String(meta.state).toUpperCase() === 'CLOSED';
        // Cerrado = finalizado → va a la etapa terminal "Finalizados".
        if (isClosed) continue;
        seen.add(key);

        const deps = blocked[key];
        const hasDeps = Array.isArray(deps) && deps.length > 0;
        if (!hasDeps) slotPos += 1;
        const reason = notEnteredReason({
            blockedBy: deps,
            queuePos: hasDeps ? null : slotPos,
            ghIssueUrl,
        });

        const issueHref = safeGithubHref(ghIssueUrl(n));
        const rawTitle = meta.title || `Issue #${n}`;
        const titleAttr = escForHtml(rawTitle);
        const titleBody = escForHtml(truncate(rawTitle));
        const numLink = issueHref
            ? `<a class="nentered-num" href="${escForHtml(issueHref)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">#${escForHtml(n)}</a>`
            : `<span class="nentered-num">#${escForHtml(n)}</span>`;

        const html = `<div class="lc-card lc-nentered" data-issue="${escForHtml(n)}" data-lane="nentered" data-status="active" title="${titleAttr}">
      <div class="lc-card-main">
        <div class="lc-top">
          <div class="lc-top-left">${numLink}</div>
        </div>
        <div class="lc-title">${titleBody}</div>
        <div class="lc-foot lc-foot-nentered">${reason.html}</div>
      </div>
    </div>`;
        cards.push({ issue: key, html });
    }

    return { count: cards.length, cards };
}

module.exports = {
    escForHtml,
    escapePopupValue,
    safeGithubHref,
    truncate,
    formatCloseDate,
    finalizadoMeta,
    notEnteredReason,
    buildNotEnteredCards,
};
