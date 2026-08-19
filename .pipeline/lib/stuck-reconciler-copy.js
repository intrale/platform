'use strict';

/**
 * #6150 — Copy en lenguaje de operador para el auto-reparador de fases varadas.
 *
 * Módulo PURO: sin `fs`, sin red, sin `require` de estado. `titleOf` y `sanitize`
 * se INYECTAN desde `pulpo.js` para que el test corra sin montar filesystem.
 *
 * Resuelve dos cosas que estaban fusionadas en el emisor viejo:
 *
 *  1. **Clasificación por decisión, no agregada** (CA-1). El criterio anterior
 *     comparaba contadores (`suprimidos_por_ola >= evaluados`), lo que con 176
 *     tareas sanas + 1 en riesgo real daba "no explicado por la ola" y notificaba
 *     igual — o al revés, escondía el caso que sí importaba. Acá se filtra tarea
 *     por tarea y recién después se cuenta.
 *
 *  2. **Texto para una persona** (CA-3/CA-4). El motivo se deriva del ENUM
 *     `suppression`, nunca de `reason`/`cause`: esos son texto libre que interpola
 *     nombres de skills y de archivos, y mandarlos al chat filtra estructura
 *     interna (SEC-3).
 */

// -----------------------------------------------------------------------------
// CA-1 — qué es "riesgo real"
// -----------------------------------------------------------------------------

/**
 * Enum CERRADO de "había que actuar y no se pudo".
 *
 * Hoy sólo `cache` (fail-closed: el reconciliador pidió escalar/reencolar pero no
 * pudo confirmar el estado de la tarea, así que prefirió no tocarla). Todo bucket
 * NO listado es diagnóstico y no va a Telegram: tarea sana, fuera de la ola,
 * cerrada, ya avisada, viva en otra fase, fase mono-skill, pipeline en pausa,
 * tope por ciclo alcanzado.
 *
 * Agregar un bucket acá es la ÚNICA palanca para ensanchar lo que se notifica.
 */
const REAL_RISK_SUPPRESSIONS = new Set(['cache']);

/** Predicado por decisión INDIVIDUAL (CA-1). Nunca compara contadores agregados. */
const isRealRisk = (d) =>
    !!d && d.action === 'none' && REAL_RISK_SUPPRESSIONS.has(d.suppression);

/** Filtra + ordena determinista por número de tarea asc. */
const selectRealRisk = (decisions = []) =>
    (Array.isArray(decisions) ? decisions : [])
        .filter(isRealRisk)
        .sort((a, b) => Number(a.issue) - Number(b.issue));

/**
 * Huella del episodio (CA-5, SEC-5).
 *
 * SÓLO identificadores estables: tarea + fase + enum de motivo. Meter acá
 * `stuckSinceMs`, `streak` o cualquier contador cambia la huella en cada ciclo y
 * convierte "un aviso por episodio" en spam cada 10 minutos — peor que el
 * comportamiento que este issue viene a arreglar.
 */
const buildEpisodeFingerprint = (risks = []) =>
    (Array.isArray(risks) ? risks : [])
        .map((d) => [d.issue, d.fase, d.suppression].join('|'))
        .sort()
        .join(',');

// -----------------------------------------------------------------------------
// CA-4 / SEC-7 — higiene del texto
// -----------------------------------------------------------------------------

/**
 * Jerga interna prohibida en el copy. El test consume ESTA lista (no una copia
 * hardcodeada) para que agregar un término acá alcance para protegerlo.
 */
const FORBIDDEN_TERMS = [
    'tick',
    'self-healing',
    'varado',
    'supresión',
    'supresiones',
    'supresion',
    'dedupe',
    'cache',
    'caché',
    'allowlist',
    'reconciler',
    'requeued',
    'escalados',
    'evaluados',
];

/**
 * Fuga de estructura interna: rutas, archivos de log/estado y extensiones.
 * El mismo test que protege la legibilidad protege la confidencialidad (SEC-7).
 */
const FORBIDDEN_PATTERNS = [
    /\.pipeline\//i,
    /[A-Za-z]:\\/,
    /\/c\//i,
    /\.log\b/i,
    /\.json\b/i,
    /\.yaml\b/i,
    /\.yml\b/i,
];

// Une los términos en un solo regex para tachar los que vengan dentro de un
// título de tercero (el repo es público: el título lo elige cualquiera). Sin
// esto, una tarea titulada "arreglar el cache de X" reintroduce la jerga que
// CA-4 prohíbe, por la puerta de atrás.
const FORBIDDEN_TERMS_RE = new RegExp(
    `(${FORBIDDEN_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'gi',
);

/**
 * Saneo del título antes de interpolarlo (CA-4, SEC-2).
 *
 * `sanitize` se inyecta (en producción: `sanitizeForTelegram`, que hace redact +
 * sanitize + strip de control chars). Acá se suma lo específico del copy: colapsar
 * whitespace, tachar rutas/extensiones y jerga, y capar a 120 chars.
 */
function scrubTitle(raw, sanitize) {
    if (raw == null) return '';
    let str = raw;
    if (typeof sanitize === 'function') {
        try { str = sanitize(str); } catch { /* best-effort: seguimos con el crudo */ }
    }
    str = String(str == null ? '' : str)
        // Secuencias ANSI completas primero: si sólo borráramos el ESC (que sí
        // cae en \x00-\x1F) quedaría el "[31m" suelto como texto.
        .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
        // Bidi override / isolates y zero-width. NO son control chars del rango
        // \x00-\x1F, así que ni `sanitizeForTelegram` ni un strip ingenuo los
        // agarran: sobreviven y permiten dar vuelta el texto que ve el operador
        // (SEC-2 — el título lo elige un tercero, el repo es público).
        .replace(/[؜​-‏‪-‮⁦-⁩﻿]/g, '')
        .replace(/[\x00-\x1F\x7F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    for (const re of FORBIDDEN_PATTERNS) str = str.replace(new RegExp(re.source, re.flags.includes('i') ? 'gi' : 'g'), '…');
    str = str.replace(FORBIDDEN_TERMS_RE, '…');
    str = str.replace(/\s+/g, ' ').trim();
    return str.length > 120 ? `${str.slice(0, 119).trimEnd()}…` : str;
}

// -----------------------------------------------------------------------------
// CA-3 — motivo en castellano, derivado del ENUM
// -----------------------------------------------------------------------------

/**
 * Enum → frase. Con variante singular/plural: "tarea(s)" es un atajo de
 * programador y el operador lo lee como tal (UX-4).
 */
const SUPPRESSION_COPY_ES = {
    cache: {
        singular: 'no se pudo confirmar en qué estado quedó y el sistema prefiere no tocarla a ciegas',
        plural: 'no se pudo confirmar en qué estado quedaron y el sistema prefiere no tocarlas a ciegas',
    },
    // Fallback para enums futuros: describe la semántica común de
    // REAL_RISK_SUPPRESSIONS sin inventar detalle que no tenemos.
    default: {
        singular: 'hacía falta una acción automática que no se pudo completar',
        plural: 'hacía falta una acción automática que no se pudo completar',
    },
};

const suppressionPhrase = (enumKey, count) => {
    const entry = SUPPRESSION_COPY_ES[enumKey] || SUPPRESSION_COPY_ES.default;
    return count === 1 ? entry.singular : entry.plural;
};

/** "N tarea" / "N tareas" — concordancia real, sin paréntesis (UX-4). */
const tareas = (n) => (n === 1 ? '1 tarea' : `${n} tareas`);

/**
 * Escala de antigüedad calcada de `lib/desync-copy.js` (desyncAgeText), para que
 * el operador lea siempre la misma unidad en todos los avisos del pipeline.
 * Recibe una DURACIÓN en ms (no un timestamp).
 */
function formatAgeEs(ms) {
    if (!Number.isFinite(ms)) return '';
    const min = Math.floor(ms / 60000);
    if (!Number.isFinite(min) || min < 0) return '';
    if (min < 1) return 'recién';
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h >= 24) {
        const dias = Math.floor(h / 24);
        const restoH = h % 24;
        return restoH > 0 ? `hace ${dias} d ${restoH} h` : `hace ${dias} d`;
    }
    return m > 0 ? `hace ${h} h ${m} min` : `hace ${h} h`;
}

const ageOf = (d, nowMs) => (
    Number.isFinite(d && d.stuckSinceMs) && Number.isFinite(nowMs)
        ? formatAgeEs(nowMs - d.stuckSinceMs)
        : ''
);

/**
 * Bloque "Por qué siguen ahí" AGRUPADO por motivo (UX-1).
 *
 * El snippet original usaba `risks[0].suppression`, o sea le atribuía a todas las
 * tareas el motivo de la primera. Hoy el bug es latente porque
 * REAL_RISK_SUPPRESSIONS tiene un solo enum — pero es un `Set` pensado para
 * crecer, y en cuanto crezca el mensaje pasa a ser comprensible y MENTIROSO.
 */
function buildReasonLines(risks) {
    const counts = new Map();
    for (const d of risks) {
        const k = (d && d.suppression) || 'default';
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    // Orden determinista: cantidad desc, y a igualdad el enum alfabéticamente.
    const grupos = [...counts.entries()].sort(
        (a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])),
    );
    if (grupos.length === 1) {
        const [enumKey, n] = grupos[0];
        return [`Por qué ${n === 1 ? 'sigue' : 'siguen'} ahí: ${suppressionPhrase(enumKey, n)}.`];
    }
    return [
        'Por qué siguen ahí:',
        ...grupos.map(([enumKey, n]) => `• ${tareas(n)}: ${suppressionPhrase(enumKey, n)}.`),
    ];
}

/**
 * Copy final (CA-3: los cinco elementos, en orden).
 *
 * El cap de 5 es del EMISOR, no del transporte (SEC-4): el truncado de Telegram
 * corta por el final, justo donde están las opciones de acción.
 */
function buildStuckAlertCopy({ risks, nowMs, titleOf, sanitize, max = 5 } = {}) {
    const list = Array.isArray(risks) ? risks : [];
    if (list.length === 0) return '';

    const safeTitle = (issue) => {
        if (typeof titleOf !== 'function') return '';
        let t = null;
        // Un `titleOf` que explota no puede tumbar el aviso entero (CA-7): la
        // tarea sale por número, que es lo mismo que hace el dep cuando el título
        // no está fresco.
        try { t = titleOf(issue); } catch { return ''; }
        return scrubTitle(t, sanitize);
    };

    // 1) Qué está frenado + hace cuánto la más vieja. La primera línea es lo
    //    único que se lee en la notificación del celular sin abrir el chat, así
    //    que tiene que responder cuántas y desde cuándo (UX-4).
    const edades = list
        .map((d) => (Number.isFinite(d && d.stuckSinceMs) && Number.isFinite(nowMs) ? nowMs - d.stuckSinceMs : null))
        .filter((v) => Number.isFinite(v));
    const masVieja = edades.length ? formatAgeEs(Math.max(...edades)) : '';
    const lines = [
        `🙋 ${tareas(list.length)} ${list.length === 1 ? 'frenada' : 'frenadas'} esperando una decisión tuya`
        + (masVieja ? ` — la más vieja ${masVieja}` : ''),
    ];

    // 2) Cuáles: número + título corto (sólo si está fresco; nunca se inventa).
    for (const d of list.slice(0, max)) {
        const t = safeTitle(d.issue);
        const edad = ageOf(d, nowMs);
        lines.push(`• #${d.issue}${t ? ` ${t}` : ''}${edad ? ` — ${edad}` : ''}`);
    }
    if (list.length > max) lines.push(`• y ${list.length - max} más`);

    // 3) Por qué el pipeline no las mueve solo.
    lines.push(...buildReasonLines(list));

    // 4) Consecuencia de no actuar.
    const una = list.length === 1;
    lines.push(una
        ? 'Si no hacés nada: sigue ahí; el sistema no la va a mover solo.'
        : 'Si no hacés nada: siguen ahí; el sistema no las va a mover solo.');

    // 5) Opciones concretas. Nombran comandos que EXISTEN en este mismo chat
    //    (`/unblock`, `/wave add`), sin backticks: el mensaje va en texto plano
    //    (SEC-1) y los backticks se renderizarían literales.
    lines.push(una
        ? 'Podés: destrabarla con /unblock, sumarla al trabajo activo con /wave add, o dejarla así a propósito.'
        : 'Podés: destrabarlas con /unblock, sumarlas al trabajo activo con /wave add, o dejarlas así a propósito.');

    return lines.join('\n');
}

module.exports = {
    REAL_RISK_SUPPRESSIONS,
    isRealRisk,
    selectRealRisk,
    buildEpisodeFingerprint,
    SUPPRESSION_COPY_ES,
    formatAgeEs,
    scrubTitle,
    buildStuckAlertCopy,
    FORBIDDEN_TERMS,
    FORBIDDEN_PATTERNS,
};
