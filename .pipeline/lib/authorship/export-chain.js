// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';
// =============================================================================
// #7633 — Export legible de la cadena de autoría (CA-2 · CA-3 · CA-4 · CA-5).
//
// Módulo PURO: datos → string HTML. No importa filesystem, procesos, puppeteer
// ni red. Los datos (mensajes de commit y títulos) los obtiene `git-source.js`
// y se los pasa el CLI (D-A2: sólo el trailer en `main` + GitHub; nunca el
// registro local de aprobaciones).
//
// Clasificación de cada commit (una sola fuente de parseo: `trailer.js`):
//   - sin ninguna clave de autoría          → unsigned (pre-go-live | dry-run)
//   - bloque roto (duplicada, fuera del
//     último párrafo, orden, faltantes)     → invalid (no suma)
//   - valor fuera del formato permitido     → unsigned (unrecognized), valor oculto
//   - bloque válido con `none; …; <motivo>` → unsigned con ese motivo
//   - bloque válido con firma gate2|gate1|approval → signed (ÚNICO que suma a X)
//
// Escape: TODO texto que no es constante de este archivo pasa por
// `escapeHtmlAttr` (un único helper, sirve para cuerpo y atributos). Los `href`
// se arman sólo con constantes + números/SHA validados.
//
// Este archivo no nombra las claves del trailer: las toma de `TRAILER_ORDER`
// (un test estático lo verifica), así no hay una segunda definición del formato.
// =============================================================================

const { escapeHtmlAttr: esc } = require('../escape-html');
const trailer = require('./trailer');
const labels = require('./labels-es');

const FORMAT_VERSION = 1;
const GH = 'https://github.com/intrale/platform';
const TZ = 'America/Argentina/Buenos_Aires';
const TZ_SUFFIX = '(hora de Argentina)';
const [, KEY_ISSUE, KEY_HUMAN, KEY_AI] = trailer.TRAILER_ORDER;

// -----------------------------------------------------------------------------
// Links: sólo constantes + valores validados (SE3)
// -----------------------------------------------------------------------------

function positiveInt(n) {
    return Number.isSafeInteger(n) && n > 0;
}

function issueHref(n) {
    if (!positiveInt(n)) throw new Error('issue inválido');
    return `${GH}/issues/${n}`;
}

function prHref(n) {
    if (!positiveInt(n)) throw new Error('pr inválido');
    return `${GH}/pull/${n}`;
}

function commitHref(sha) {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('sha inválido');
    return `${GH}/commit/${sha}`;
}

// -----------------------------------------------------------------------------
// Fechas
// -----------------------------------------------------------------------------

const AR_FMT = new Intl.DateTimeFormat('es-AR', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
});

function arParts(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    const p = {};
    for (const part of AR_FMT.formatToParts(d)) p[part.type] = part.value;
    return p;
}

/** `dd/mm/aaaa hh:mm` en hora de Argentina ('' si no parsea). */
function formatArDateTime(value) {
    const p = arParts(value);
    return p ? `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}` : '';
}

/** `dd/mm/aaaa` en hora de Argentina ('' si no parsea). */
function formatArDate(value) {
    const p = arParts(value);
    return p ? `${p.day}/${p.month}/${p.year}` : '';
}

// -----------------------------------------------------------------------------
// Modelo
// -----------------------------------------------------------------------------

const SHA40 = /^[0-9a-f]{40}$/;

function prFromSubject(message) {
    const first = String(message || '').split(/\r?\n/, 1)[0];
    const m = /\(#(\d{1,9})\)\s*$/.exec(first);
    return m ? Number(m[1]) : null;
}

function issueFromTrailers(t) {
    if (t && positiveInt(t.closes)) return t.closes;
    const m = t && typeof t.issue === 'string' ? /^#(\d{1,9})$/.exec(t.issue) : null;
    return m ? Number(m[1]) : null;
}

/**
 * Clasifica un commit. Nunca lanza: un mensaje raro termina como `invalid` o
 * `unsigned`, nunca como firmado.
 *
 * @param {{sha:string, date:string, message:string}} commit
 * @param {{goLiveMs:number|null}} ctx
 */
function classifyCommit(commit, { goLiveMs }) {
    const sha = String(commit && commit.sha || '').toLowerCase();
    const message = String(commit && commit.message || '');
    const date = String(commit && commit.date || '');
    const base = {
        sha: SHA40.test(sha) ? sha : null,
        date,
        pr: prFromSubject(message),
        issue: null,
        state: 'unsigned',
        reason: null,
        human: null,
        ai: null,
        anchorHash: null,
        annex: null,
    };

    if (!trailer.hasIntraleKey(message)) {
        const ms = Date.parse(date);
        const pre = goLiveMs !== null && !Number.isNaN(ms) && ms < goLiveMs;
        return { ...base, reason: pre ? 'pre-go-live' : 'dry-run', annex: { kind: 'no-block' } };
    }

    const parsed = trailer.parseTrailerBlock(message);
    if (!parsed.ok) {
        return { ...base, state: 'invalid', annex: { kind: 'invalid', error: parsed.error } };
    }
    const t = parsed.trailers;
    const issue = issueFromTrailers(t);
    const human = trailer.parseHumanDirection(t.humanDirection);
    const ai = trailer.parseAiAssisted(t.aiAssisted);
    const withIssue = { ...base, issue };

    // Un valor fuera de formato no se muestra nunca (CA-4): se informa como
    // "sin firma" con motivo `unrecognized`, sin transcribir el valor crudo.
    if ((t.humanDirection !== null && !human) || (t.aiAssisted !== null && !ai)) {
        return { ...withIssue, reason: 'unrecognized', annex: { kind: 'unrecognized' } };
    }

    const verified = issue ? trailer.verifyTrailer(message, issue) : { ok: false, error: 'bloque sin número de tarea' };
    if (!verified.ok) {
        return { ...withIssue, state: 'invalid', annex: { kind: 'invalid', error: verified.error } };
    }

    const annex = { kind: 'block', issue, human: t.humanDirection, ai: t.aiAssisted };
    if (human.signed) {
        return {
            ...withIssue,
            state: 'signed',
            human: { login: human.login, ts: human.ts, kind: human.kind },
            ai,
            anchorHash: human.hash,
            annex,
        };
    }
    return { ...withIssue, reason: human.reason, human: { ts: human.ts, kind: 'none' }, ai, annex };
}

/**
 * Números de issue referenciados por los commits (para pedir sus títulos).
 * @param {Array<{message:string}>} commits
 * @returns {number[]}
 */
function issuesOf(commits) {
    const out = new Set();
    for (const c of Array.isArray(commits) ? commits : []) {
        const parsed = trailer.parseTrailerBlock(String(c && c.message || ''));
        const n = parsed.ok ? issueFromTrailers(parsed.trailers) : null;
        if (n) out.add(n);
    }
    return [...out];
}

function normalizeScope(scope) {
    if (scope && positiveInt(scope.pr)) return { kind: 'pr', pr: scope.pr };
    if (scope && typeof scope.range === 'string' && scope.range.includes('..')) {
        const [from, to] = scope.range.split('..');
        return { kind: 'range', range: scope.range, from, to };
    }
    throw new Error('alcance inválido: se espera { pr } o { range }');
}

/**
 * @param {object} p
 * @param {{pr:number}|{range:string}} p.scope
 * @param {Array<{sha:string, date:string, message:string}>} p.commits
 * @param {Object<string, {ok:boolean, title?:string, publicMessage?:string}|string>} [p.titles]
 * @param {string|null} [p.goLiveDate]
 * @param {Date|string|number} [p.now]
 */
function buildChainModel({ scope, commits, titles = {}, goLiveDate = null, now = new Date() } = {}) {
    const sc = normalizeScope(scope);
    const goLiveMs = typeof goLiveDate === 'string' && goLiveDate ? Date.parse(goLiveDate) : NaN;
    const ctx = { goLiveMs: Number.isNaN(goLiveMs) ? null : goLiveMs };
    const items = (Array.isArray(commits) ? commits : []).map((c) => {
        const item = classifyCommit(c, ctx);
        if (sc.kind === 'pr' && item.pr === null) item.pr = sc.pr;
        return item;
    });
    const count = { signed: 0, unsigned: 0, invalid: 0, total: items.length };
    for (const it of items) count[it.state]++;
    return {
        version: FORMAT_VERSION,
        scope: sc,
        items,
        count,
        titles: titles && typeof titles === 'object' ? titles : {},
        goLiveDate: ctx.goLiveMs === null ? null : goLiveDate,
        generatedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    };
}

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

// CSS del mockup `.pipeline/assets/mockups/7593|7633/*.html` (idéntico).
const CSS = `
  @page { size: A4; margin: 18mm 16mm 20mm 16mm; }
  :root {
    --ink:        #1F2328;
    --ink-2:      #424A53;
    --ink-3:      #59636E;
    --line:       #D0D7DE;
    --paper:      #FFFFFF;
    --paper-2:    #F6F8FA;
    --brand-navy: #0D274D;
    --brand-blue: #0F6CD6;
    --ok:         #1A7F37;
    --ok-bg:      #DAFBE1;
    --warn:       #9A6700;
    --warn-bg:    #FFF8C5;
    --bad:        #CF222E;
    --bad-bg:     #FFEBE9;
    --sans: "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif;
    --mono: "Consolas", "Liberation Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--paper); color: var(--ink); }
  body { font: 10.5pt/1.5 var(--sans); max-width: 178mm; margin: 0 auto; padding: 8mm 0; }
  h1, h2, h3 { color: var(--brand-navy); line-height: 1.25; margin: 0; }
  h1 { font-size: 18pt; }
  h2 { font-size: 13pt; margin: 18pt 0 6pt; padding-bottom: 3pt; border-bottom: 1.5pt solid var(--brand-navy); }
  h3 { font-size: 11pt; }
  p { margin: 0 0 6pt; }
  a { color: var(--brand-blue); text-decoration: underline; }
  code, .mono { font-family: var(--mono); font-size: 9pt; overflow-wrap: anywhere; }
  .doc-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12pt;
              border-bottom: 3pt solid var(--brand-navy); padding-bottom: 8pt; }
  .brand { font-weight: 700; letter-spacing: .04em; color: var(--brand-navy); font-size: 9pt; text-transform: uppercase; }
  .brand .dot { display: inline-block; width: 8pt; height: 8pt; border-radius: 2pt; margin-right: 4pt; vertical-align: -1pt;
                background: linear-gradient(135deg, #00D6FF, #1890FF); }
  .doc-meta { text-align: right; font-size: 9pt; color: var(--ink-3); }
  .subtitle { color: var(--ink-2); margin-top: 4pt; }
  .summary { background: var(--paper-2); border: 1pt solid var(--line); border-left: 4pt solid var(--brand-blue);
             padding: 10pt 12pt; margin-top: 12pt; border-radius: 3pt; }
  .summary strong { color: var(--brand-navy); }
  .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8pt; margin-top: 8pt; }
  .kpi { background: var(--paper); border: 1pt solid var(--line); border-radius: 3pt; padding: 6pt 8pt; }
  .kpi .n { font-size: 16pt; font-weight: 700; color: var(--brand-navy); }
  .kpi .l { font-size: 8.5pt; color: var(--ink-2); }
  .badge { display: inline-block; font-size: 8.5pt; font-weight: 700; padding: 1pt 6pt; border-radius: 10pt; border: 1pt solid; white-space: nowrap; }
  .badge.ok   { color: var(--ok);   background: var(--ok-bg);   border-color: var(--ok); }
  .badge.warn { color: var(--warn); background: var(--warn-bg); border-color: var(--warn); }
  .badge.bad  { color: var(--bad);  background: var(--bad-bg);  border-color: var(--bad); }
  .chain { list-style: none; margin: 0; padding: 0; counter-reset: step; }
  .chain > li { position: relative; padding: 0 0 10pt 28pt; break-inside: avoid; }
  .chain > li::before { counter-increment: step; content: counter(step);
    position: absolute; left: 0; top: 0; width: 18pt; height: 18pt; border-radius: 50%;
    background: var(--brand-navy); color: #fff; font-weight: 700; font-size: 9pt; text-align: center; line-height: 18pt; }
  .chain > li:not(:last-child)::after { content: ""; position: absolute; left: 8.5pt; top: 20pt; bottom: 2pt; width: 1pt; background: var(--line); }
  .step-title { font-weight: 700; color: var(--brand-navy); }
  .step-body { color: var(--ink); }
  .step-note { color: var(--ink-3); font-size: 9pt; }
  table { width: 100%; border-collapse: collapse; margin: 4pt 0 8pt; font-size: 9.5pt; }
  th, td { text-align: left; vertical-align: top; padding: 4pt 6pt; border-bottom: .75pt solid var(--line); }
  th { width: 34%; color: var(--ink-2); font-weight: 600; background: var(--paper-2); }
  .card { border: 1pt solid var(--line); border-radius: 3pt; padding: 8pt 10pt; margin: 8pt 0; break-inside: avoid; }
  .card-head { display: flex; justify-content: space-between; gap: 8pt; align-items: baseline; margin-bottom: 4pt; }
  .callout { border: 1pt solid var(--line); border-left: 4pt solid var(--warn); background: var(--warn-bg);
             padding: 8pt 10pt; border-radius: 3pt; margin: 8pt 0; break-inside: avoid; }
  .callout.info { border-left-color: var(--brand-blue); background: var(--paper-2); }
  .annex { font-size: 9pt; color: var(--ink-2); }
  .annex pre { font-family: var(--mono); font-size: 8.5pt; background: var(--paper-2); border: 1pt solid var(--line);
               padding: 6pt 8pt; white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 3pt; }
  footer { margin-top: 16pt; padding-top: 6pt; border-top: 1pt solid var(--line); font-size: 8.5pt; color: var(--ink-3); }
  @media print { a { color: var(--ink); } }
`;

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const BADGE_CLASS = { signed: 'ok', unsigned: 'warn', invalid: 'bad' };

function shortSha(sha) {
    return sha ? sha.slice(0, 7) : '(registro no legible)';
}

function mediumSha(sha) {
    return sha ? `${sha.slice(0, 12)}…` : '(registro no legible)';
}

function shortHash(hash) {
    return `sha256:${String(hash).slice(0, 12)}…`;
}

function titleEntry(model, n) {
    const v = model.titles[n] !== undefined ? model.titles[n] : model.titles[String(n)];
    if (typeof v === 'string') return { ok: true, title: v };
    if (v && v.ok === true && typeof v.title === 'string') return { ok: true, title: v.title };
    return { ok: false, publicMessage: `no se pudo obtener el título de #${n}` };
}

function issueLink(model, n) {
    if (!positiveInt(n)) return 'Sin tarea registrada';
    const t = titleEntry(model, n);
    const text = t.ok ? `#${n} — ${t.title}` : `#${n} (${t.publicMessage})`;
    return `<a href="${issueHref(n)}">${esc(text)}</a>`;
}

function prLink(n) {
    return positiveInt(n) ? `<a href="${prHref(n)}">#${n}</a>` : 'sin Pull Request identificado';
}

function commitLink(sha) {
    if (!sha) return '<span class="mono">(registro no legible)</span>';
    return `<a href="${commitHref(sha)}"><span class="mono">${esc(mediumSha(sha))}</span></a>`;
}

function aiLines(ai) {
    if (!Array.isArray(ai) || ai.length === 0) return 'No registradas';
    return ai.map((x) => `${esc(labels.providerLabel(x.provider))} ${esc(x.model)} — ${esc(labels.roleLabel(x.role))}`).join('<br>');
}

function aiSentence(ai) {
    if (!Array.isArray(ai) || ai.length === 0) return 'El registro del cambio no identifica herramientas de IA.';
    return `${ai.map((x) => `${esc(labels.providerLabel(x.provider))} ${esc(x.model)} ${esc(labels.roleLabel(x.role))}`).join('; ')}.`;
}

function reasonText(model, it) {
    if (it.state === 'invalid') return labels.INVALID_REASON;
    return labels.unsignedReasonText(it.reason, { goLiveDateText: model.goLiveDate ? formatArDate(model.goLiveDate) : '' });
}

function whoText(it) {
    if (it.state === 'signed') return `<span class="mono">${esc(it.human.login)}</span> ${esc(labels.WHO_LABELS.operatorSuffix)}`;
    return esc(it.state === 'invalid' ? labels.WHO_LABELS.invalid : labels.WHO_LABELS.unsigned);
}

function row(th, td) {
    return `    <tr><th>${esc(th)}</th><td>${td}</td></tr>`;
}

function renderCard(model, it) {
    const rows = [row('Tarea de origen', issueLink(model, it.issue)), row('Quién dirigió', whoText(it))];
    if (it.state === 'signed') {
        rows.push(row('Qué decidió y cuándo',
            `${esc(labels.decisionLabel(it.human.kind))} · ${esc(formatArDateTime(it.human.ts))} ${TZ_SUFFIX}`));
        rows.push(row('Cómo se registró la decisión', 'Firma del operador, anclada en el registro del cambio en la rama principal'));
    } else {
        rows.push(row('Por qué', esc(reasonText(model, it))));
    }
    if (Array.isArray(it.ai)) rows.push(row('Herramientas de IA que asistieron', aiLines(it.ai)));
    rows.push(row('Pull Request', prLink(it.pr)));
    rows.push(row('Registro en la rama principal', `${commitLink(it.sha)} (${esc(formatArDate(it.date))})`));
    if (it.state === 'signed') rows.push(row('Huella de la firma', `<span class="mono">${esc(shortHash(it.anchorHash))}</span>`));
    const prSuffix = positiveInt(it.pr) ? ` · PR #${it.pr}` : '';
    return [
        '<div class="card">',
        '  <div class="card-head">',
        `    <h3>Registro <span class="mono">${esc(shortSha(it.sha))}</span>${prSuffix}</h3>`,
        `    <span class="badge ${BADGE_CLASS[it.state]}">${esc(labels.STATE_LABELS[it.state])}</span>`,
        '  </div>',
        '  <table>',
        ...rows,
        '  </table>',
        '</div>',
    ].join('\n');
}

function scopeTitle(sc) {
    return sc.kind === 'pr' ? `PR #${sc.pr}` : `rango ${sc.from}..${sc.to}`;
}

function renderHeader(model) {
    const sc = model.scope;
    const n = model.count.total;
    const subtitle = sc.kind === 'pr'
        ? `Cambio integrado a la rama principal mediante el Pull Request <strong>#${sc.pr}</strong>`
        : `Cambios integrados a la rama principal entre los registros <span class="mono">${esc(sc.from)}</span> y <span class="mono">${esc(sc.to)}</span>`;
    const p = arParts(model.generatedAt);
    const generated = p ? `${p.day}/${p.month}/${p.year}, ${p.hour}:${p.minute}` : '';
    return [
        '<header class="doc-head">',
        '  <div>',
        '    <div class="brand"><span class="dot"></span>Intrale · Constancia de autoría</div>',
        '    <h1>Constancia de dirección humana</h1>',
        `    <p class="subtitle">${subtitle}</p>`,
        '  </div>',
        '  <div class="doc-meta">',
        `    Generado el <strong>${esc(generated)}</strong> ${TZ_SUFFIX}<br>`,
        `    Alcance: ${n} ${n === 1 ? 'cambio' : 'cambios'}<br>`,
        `    Versión del formato: ${model.version}`,
        '  </div>',
        '</header>',
    ].join('\n');
}

function isZeroExpected(model) {
    const { count, items } = model;
    if (count.total === 0 || count.signed > 0 || count.invalid > 0) return false;
    return items.every((it) => it.reason !== 'unrecognized');
}

function kpi(n, l) {
    return `    <div class="kpi"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`;
}

function renderSummary(model) {
    const { count, scope } = model;
    const xOfN = `${count.signed} de ${count.total}`;
    let text;
    if (count.total === 0) {
        text = 'El alcance pedido no contiene cambios integrados a la rama principal.';
    } else if (scope.kind === 'pr' && count.signed === 1) {
        text = 'Este cambio lo escribieron herramientas de inteligencia artificial <strong>por encargo y bajo la dirección de una persona</strong>, que aceptó el resultado antes de que se integrara. El documento muestra de dónde salió el pedido, qué herramientas asistieron, quién firmó y dónde quedó registrado de forma permanente.';
    } else if (count.signed === count.total) {
        text = 'Todos los cambios tienen registrada la firma de la persona que dirigió el trabajo.';
    } else {
        const who = count.signed === 0 ? 'Ningún cambio tiene'
            : count.signed === 1 ? 'Uno de los cambios tiene' : `${count.signed} cambios tienen`;
        text = `${who} registrada la firma de la persona que dirigió el trabajo. Donde no la hay, cada tarjeta explica por qué: nunca se esconde un faltante.`;
    }
    const zero = isZeroExpected(model) ? `\n  <p>${esc(labels.ZERO_OF_N_NOTE)}</p>` : '';
    let kpis;
    if (scope.kind === 'pr') {
        const it = model.items[0];
        const who = it && it.state === 'signed' ? esc(it.human.login) : esc(labels.WHO_LABELS.unsigned);
        const ai = it && Array.isArray(it.ai) ? it.ai.length : 0;
        kpis = [
            kpi(xOfN, 'Cambios con firma'),
            kpi(who, 'Persona que dirigió el trabajo (operador)'),
            kpi(String(ai), 'Herramientas de IA que asistieron'),
        ];
    } else {
        kpis = [
            kpi(xOfN, 'Cambios con firma'),
            kpi(String(count.unsigned), 'Cambios sin firma registrada (modo de prueba, anterior a la vigencia o dato no reconocido)'),
            kpi(String(count.invalid), 'Cambios con registro de firma inválido (no suman al conteo)'),
        ];
    }
    return [
        '<section class="summary" aria-label="Resumen">',
        `  <p><strong>En resumen:</strong> <strong>${xOfN} cambios con firma.</strong> ${text}</p>${zero}`,
        '  <div class="kpis">',
        ...kpis,
        '  </div>',
        '</section>',
    ].join('\n');
}

function step(title, body, note) {
    return [
        '  <li>',
        `    <div class="step-title">${esc(title)}</div>`,
        `    <div class="step-body">${body}</div>`,
        note ? `    <div class="step-note">${esc(note)}</div>` : null,
        '  </li>',
    ].filter(Boolean).join('\n');
}

function renderChain(model) {
    const { count, scope } = model;
    const it = scope.kind === 'pr' ? model.items[0] : null;
    let steps;
    if (it) {
        const signedBody = it.state === 'signed'
            ? `<strong>${esc(it.human.login)}</strong> ${esc(labels.WHO_LABELS.operatorSuffix)} ${esc(labels.decisionLabel(it.human.kind).toLowerCase())} el <strong>${esc(formatArDateTime(it.human.ts).replace(' ', ' a las '))}</strong> ${TZ_SUFFIX}.`
            : `No hay una firma del operador registrada para este cambio. ${esc(reasonText(model, it))}`;
        steps = [
            step('Se definió qué había que hacer', `Pedido registrado como tarea ${issueLink(model, it.issue)}.`,
                'La tarea describe el objetivo, los cambios y los criterios de aceptación.'),
            step('Herramientas de IA escribieron y revisaron el código', aiSentence(it.ai),
                'Dato tomado del registro del propio cambio en la rama principal.'),
            step('Una persona aceptó el resultado', signedBody,
                it.state === 'signed' ? 'Canal: firma del operador. La huella de esa firma viaja dentro del registro del cambio.' : null),
            step('Quedó sellado en la rama principal',
                `El cambio entró a la rama principal el ${esc(formatArDate(it.date))} en el registro <span class="mono">${esc(shortSha(it.sha))}</span>, a través del Pull Request ${prLink(it.pr)}.`,
                'Desde ese momento, el registro y la huella de la firma no pueden modificarse sin que se note.'),
        ];
    } else {
        steps = [
            step('Se definió qué había que hacer', 'Cada cambio nace de una tarea registrada en GitHub. La tarea de cada uno figura en su tarjeta.'),
            step('Herramientas de IA escribieron y revisaron el código', 'Las herramientas y sus roles figuran en cada tarjeta, tomados del registro del propio cambio.'),
            step('Una persona aceptó el resultado', `En <strong>${count.signed} de ${count.total}</strong> cambios hay una firma del operador registrada.`,
                'Donde no la hay, la tarjeta lo dice con su motivo.'),
            step('Quedó sellado en la rama principal', `Los ${count.total} cambios están en la rama principal; cada tarjeta indica su registro.`),
        ];
    }
    return ['<h2>La cadena de autoría, paso a paso</h2>', '<ol class="chain">', ...steps, '</ol>'].join('\n');
}

function renderCards(model) {
    const title = model.scope.kind === 'pr' ? 'Detalle del cambio' : 'Detalle de los cambios';
    const cards = model.items.length ? model.items.map((it) => renderCard(model, it)) : ['<p>No hay cambios en este alcance.</p>'];
    return [`<h2>${title}</h2>`, ...cards].join('\n');
}

function renderProof() {
    const L = labels.LEGEND;
    return [
        '<h2>Qué prueba este documento y qué no</h2>',
        '<div class="callout">',
        `  <p><strong>${esc(L.before)}<span class="mono">${esc(L.code)}</span>${esc(L.after)}</strong></p>`,
        '</div>',
        '<div class="callout info">',
        '  <p><strong>Prueba con solidez:</strong> que, una vez integrado cada cambio, lo que dice su registro quedó escrito en el registro público del código (GitHub) con su fecha, y no se puede alterar sin dejar rastro.</p>',
        '</div>',
        '<div class="callout info">',
        '  <p><strong>Depende de otros elementos:</strong> que cada firma la haya dado efectivamente la persona indicada. Eso se apoya en el canal de firma del operador y en el servidor del proyecto. Hoy todas las acciones en GitHub se hacen con la misma cuenta, por lo que GitHub por sí solo no distingue a la persona de la herramienta automática.</p>',
        '</div>',
        '<p class="step-note">Criterio completo, fuentes legales y conservación: <span class="mono">docs/legal/autoria.md</span>.</p>',
    ].join('\n');
}

function toUtcIso(value) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? 'sin fecha' : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function annexLines(model, it) {
    const head = it.sha || '(registro no legible)';
    const a = it.annex || { kind: 'no-block' };
    if (a.kind === 'block') {
        return [
            head,
            `  ${KEY_ISSUE}: #${a.issue}`,
            `  ${KEY_HUMAN}: ${a.human}`,
            `  ${KEY_AI}: ${a.ai}`,
        ];
    }
    if (a.kind === 'invalid') return [`${head}   bloque de autoría inválido: ${a.error}`];
    if (a.kind === 'unrecognized') return [`${head}   valor fuera de formato en el bloque de autoría (no transcripto)`];
    const why = it.reason === 'pre-go-live'
        ? `anterior a go_live_date ${model.goLiveDate}`
        : 'posterior a go_live_date o sin fecha de vigencia · modo de prueba';
    return [`${head}   sin bloque de autoría · ${toUtcIso(it.date)} · ${why}`];
}

function renderAnnex(model) {
    const lines = model.items.flatMap((it) => annexLines(model, it));
    const kinds = trailer.DIRECTION_KINDS;
    return [
        '<h2>Anexo técnico</h2>',
        '<div class="annex">',
        '  <p>Datos de autoría de cada registro, tal como figuran en la rama principal (horas en UTC). Los valores que no pasaron la validación no se transcriben.</p>',
        `<pre>${esc(lines.join('\n'))}</pre>`,
        '  <table>',
        '    <tr><th>Clave técnica</th><td><strong>Significa</strong></td></tr>',
        `    <tr><th class="mono">${esc(KEY_ISSUE)}</th><td>Tarea de origen</td></tr>`,
        `    <tr><th class="mono">${esc(KEY_HUMAN)}</th><td>Quién dirigió; cuándo (hora universal, UTC); tipo de decisión y huella</td></tr>`,
        `    <tr><th class="mono">${esc(kinds.join(' / '))}</th><td>${esc(kinds.map((k) => labels.DECISION_LABELS[k]).join(' / '))}</td></tr>`,
        `    <tr><th class="mono">none</th><td>${esc(labels.DECISION_LABELS.none)}</td></tr>`,
        `    <tr><th class="mono">${esc(KEY_AI)}</th><td>Herramientas de IA que asistieron y en qué rol</td></tr>`,
        '  </table>',
        '</div>',
    ].join('\n');
}

/** @param {ReturnType<typeof buildChainModel>} model */
function renderChainHtml(model) {
    return [
        '<!DOCTYPE html>',
        '<html lang="es">',
        '<head>',
        '<meta charset="utf-8">',
        `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
        `<title>Constancia de dirección humana — ${esc(scopeTitle(model.scope))}</title>`,
        `<style>${CSS}</style>`,
        '</head>',
        '<body>',
        '',
        renderHeader(model),
        '',
        renderSummary(model),
        '',
        renderChain(model),
        '',
        renderCards(model),
        '',
        renderProof(),
        '',
        renderAnnex(model),
        '',
        '<footer>',
        '  Constancia generada automáticamente a partir de los registros de la rama principal y de GitHub; no agrega información nueva y se puede regenerar en cualquier momento. No contiene identificadores de mensajería, credenciales ni rutas internas del servidor.',
        '</footer>',
        '',
        '</body>',
        '</html>',
        '',
    ].join('\n');
}

/**
 * API de CA-2: alcance + datos ya obtenidos → HTML.
 *
 * @param {{pr:number}|{range:string}} scope
 * @param {{commits:Array, titles?:object, goLiveDate?:string|null, now?:Date}} data
 * @returns {string}
 */
function exportChain(scope, data = {}) {
    return renderChainHtml(buildChainModel({ ...data, scope }));
}

module.exports = {
    FORMAT_VERSION,
    CSP,
    exportChain,
    buildChainModel,
    renderChainHtml,
    classifyCommit,
    issuesOf,
    formatArDateTime,
    formatArDate,
    issueHref,
    prHref,
    commitHref,
    scopeTitle,
};
