// =============================================================================
// validate-copy.js — Validador del copy del aviso de sesión (#6239, UX)
//
// Valida `copy.json` contra los criterios vinculantes de
// `.pipeline/assets/mockups/6239/ux-criterios-6239.md`. Valida sobre el TEXTO
// VISIBLE ya interpolado con el peor caso de lapso, no sobre el JSON crudo:
// lo que le llega al operador es lo que hay que auditar.
//
//   UX-5.5  · warn/error piden acción; los info dicen que no hay nada que hacer
//   UX-6.1  · sin metacaracteres de Markdown
//   UX-6.2  · sin emoji propio (lo pone notifyTelegram según level)
//   UX-6.3  · un solo slot por message, y ninguno en action
//   UX-6.6  · vocabulario cerrado (nada de la lista prohibida)
//   UX-6.7  · "reautenticar", nunca "rotar"
//   UX-6.8  · nunca se pide pegar credenciales por el chat
//   UX-6.9  · largos máximos y sin palabras de más de 40 chars
//   UX-7    · escalada de nivel entre A1 (warn) y A2 (error)
//   UX-8    · los cinco estados del dashboard, con su title y sus umbrales
//   UX-9    · todo texto de la línea de sesión contiene la palabra "sesión"
//   UX-12   · formato de tiempo reusado del pipeline
//
// Uso:  node .pipeline/assets/copy/oauth-session-expiry/validate-copy.js
// Exit: 0 copy válido · 1 copy inválido (lista qué regla y en qué mensaje)
//
// Si una regla falla, el problema está en el copy o en la lectura del criterio:
// `copy.json` es normativo y sólo se toca pasando por UX.
// =============================================================================

'use strict';

const {
    formatDurationEs, renderTelegram, renderDashboard,
    AVISOS, ESTADOS_DASHBOARD, COPY,
} = require('./render');

// Peor caso de lapso para medir largos ya interpolados (UX-6.9). Es el ejemplo
// más largo del formato declarado en `copy.json → formato_tiempo.ejemplos`.
const PEOR_CASO = '5 h 20 min';

const AVISOS_ACCIONABLES = ['A1_por_vencer', 'A2_urgente'];
const AVISOS_INFO = ['A4_chequeo_recuperado', 'A5_renovada'];
const NEGACION_EXPLICITA = 'No hace falta que hagas nada';

const MAX_MESSAGE = COPY.reglas.message_max_chars;   // 200
const MAX_ACTION = COPY.reglas.action_max_chars;     // 320
const MAX_PALABRA = 40;                              // heurística de redactFreeText

const interpolar = (t) => String(t).replace(/\{RESTANTE\}|\{ANTIGUEDAD\}/g, PEOR_CASO);

// --- Inventario de textos visibles ------------------------------------------
// `crudo` conserva los slots (para UX-6.3); `visible` es lo que lee el operador.
const textosTelegram = [];
for (const aviso of AVISOS) {
    const e = COPY.telegram[aviso];
    for (const campo of ['message', 'action']) {
        textosTelegram.push({
            id: `${aviso}.${campo}`, aviso, campo,
            crudo: e[campo], visible: interpolar(e[campo]),
        });
    }
}

const textosDashboard = [];
for (const estado of Object.keys(COPY.dashboard.estados)) {
    textosDashboard.push({
        id: `dashboard.estados.${estado}`, campo: 'texto',
        crudo: COPY.dashboard.estados[estado].texto,
        visible: interpolar(COPY.dashboard.estados[estado].texto),
    });
}
for (const estado of Object.keys(COPY.dashboard.titles)) {
    textosDashboard.push({
        id: `dashboard.titles.${estado}`, campo: 'title',
        crudo: COPY.dashboard.titles[estado],
        visible: interpolar(COPY.dashboard.titles[estado]),
    });
}

const todos = textosTelegram.concat(textosDashboard);

// --- Vocabulario prohibido (UX-6.6) -----------------------------------------
// Derivado de `copy.json → reglas.vocabulario_prohibido`. Se escribe como
// regexes y no como `includes` por dos razones:
//   1. Falsos positivos: "token" no debe matchear dentro de otra palabra, y
//      "OAuth" no debe matchear dentro de "reautenticá" (que es obligatoria).
//      Por eso cada término va con bordes Unicode — `\b` de JS es ASCII y se
//      rompe contra "sesión", "reautenticá", "vencerá".
//   2. Flexiones: "credencial" tiene que atrapar también "credenciales".
// La palabra "sesión" NO está en esta lista: es el término obligatorio (UX-6.6).
const B_IZQ = '(?<![\\p{L}\\p{N}_])';
const B_DER = '(?![\\p{L}\\p{N}_])';
const termino = (src) => new RegExp(`${B_IZQ}(?:${src})${B_DER}`, 'iu');

const PROHIBIDO = [
    ['OAuth', termino('oauth')],
    ['token / access token / refresh token', termino('tokens?')],
    ['expiresAt', termino('expires\\s?at')],
    ['claudeAiOauth', termino('claude\\s?ai\\s?oauth')],
    ['epoch', termino('epochs?')],
    ['credencial', termino('credencial(?:es)?')],
    ['T-30 / T-10', termino('t-\\d{1,3}')],
    ['umbral', termino('umbral(?:es)?')],
    ['tick', termino('ticks?')],
    ['fail-open', termino('fail[-\\s]?open')],
    ['available', termino('available')],
    ['key_status', termino('key_status')],
    ['auth_mode', termino('auth_mode')],
    // "rutas de archivo" y "cualquier fragmento del contenido del archivo":
    // se aproximan con las formas en que una ruta o un volcado se filtrarían.
    ['ruta de archivo', /(\.(?:js|json|jsonl|md|sh|ps1|conf)\b)|([A-Za-z]:\\)|(^|[\s(])[~.]?\/[\w.-]+\/|(\.pipeline\b)|(\.claude\b)/i],
    ['fragmento del archivo de credenciales', /[{}]\s*"|"[a-zA-Z]+"\s*:/],
];

// --- Emojis de level (UX-6.2) -----------------------------------------------
// Se incluye el ⚠ pelado (sin variation selector) además del ⚠️: en el mensaje
// de Telegram se leería como un segundo emoji al lado del que pone el canal.
// El dashboard SÍ lo usa a propósito (UX-8/UX-10) y por eso queda fuera de esta
// regla, que aplica sólo a message/action.
const EMOJIS_LEVEL = [
    ['warn', /\u{26A0}\u{FE0F}?/u],
    ['error', /\u{1F6A8}/u],
    ['info', /\u{2139}\u{FE0F}?/u],
];

// --- Motor de reglas --------------------------------------------------------
const resultados = [];

function regla(id, descripcion, fn) {
    const fallas = [];
    try {
        fn((mensaje) => fallas.push(mensaje));
    } catch (e) {
        fallas.push(`la regla explotó: ${e && e.message ? e.message : e}`);
    }
    resultados.push({ id, descripcion, fallas });
}

// --- UX-6.1 -----------------------------------------------------------------
regla('UX-6.1', 'sin metacaracteres de Markdown en message/action', (falla) => {
    for (const t of textosTelegram) {
        const m = t.visible.match(/[*_`[\]]/g);
        if (m) falla(`${t.id}: contiene ${[...new Set(m)].map((c) => `"${c}"`).join(', ')}`);
    }
});

// --- UX-6.2 -----------------------------------------------------------------
regla('UX-6.2', 'sin emoji de level en message/action (lo pone notifyTelegram)', (falla) => {
    for (const t of textosTelegram) {
        for (const [nivel, re] of EMOJIS_LEVEL) {
            if (re.test(t.visible)) falla(`${t.id}: repite el emoji de level "${nivel}"`);
        }
    }
});

// --- UX-6.3 -----------------------------------------------------------------
regla('UX-6.3', 'un solo slot por message, ninguno en action', (falla) => {
    const PERMITIDOS = ['{RESTANTE}', '{ANTIGUEDAD}'];
    for (const t of textosTelegram) {
        const slots = t.crudo.match(/\{[^}]*\}/g) || [];
        if (t.campo === 'action' && slots.length > 0) {
            falla(`${t.id}: action con slot ${slots.join(', ')}`);
            continue;
        }
        if (t.campo !== 'message') continue;
        if (slots.length > 1) falla(`${t.id}: ${slots.length} slots (${slots.join(', ')})`);
        for (const s of slots) {
            if (!PERMITIDOS.includes(s)) falla(`${t.id}: slot no permitido ${s}`);
        }
    }
});

// --- UX-6.6 -----------------------------------------------------------------
regla('UX-6.6', 'vocabulario cerrado: ningun texto visible usa la lista prohibida', (falla) => {
    for (const t of todos) {
        for (const [etiqueta, re] of PROHIBIDO) {
            const m = t.visible.match(re);
            if (m) falla(`${t.id}: vocabulario prohibido "${etiqueta}" (match: "${m[0].trim()}")`);
        }
    }
    // Control de la propia regla: la palabra obligatoria no puede estar siendo
    // tachada por la lista. Si esto falla, el equivocado es el validador.
    for (const [etiqueta, re] of PROHIBIDO) {
        if (re.test('la sesión de Claude Code se renovó, reautenticá desde una terminal')) {
            falla(`la lista prohibida tiene un falso positivo: "${etiqueta}" matchea vocabulario obligatorio`);
        }
    }
});

// --- UX-6.7 -----------------------------------------------------------------
regla('UX-6.7', '"reautenticar" en los avisos accionables, "rotar" en ninguno', (falla) => {
    for (const t of todos) {
        const m = t.visible.match(/rot(?:ar|á|a|ación|acion|amos)/iu);
        if (m) falla(`${t.id}: usa "${m[0]}" — el verbo es reautenticar`);
    }
    for (const aviso of AVISOS_ACCIONABLES) {
        const p = renderTelegram(aviso, { minutesLeft: 27, ageMinutes: 27 });
        if (!/reautentic/i.test(`${p.message} ${p.action}`)) {
            falla(`${aviso}: no dice qué acción es (falta "reautentic...")`);
        }
    }
});

// --- UX-6.8 -----------------------------------------------------------------
regla('UX-6.8', 'nunca se pide pegar nada por el chat; la acción es en una terminal', (falla) => {
    const POR_CHAT = [
        /(?<![\p{L}])peg(?:a|á|ar|ue|ues|ame)(?![\p{L}])/iu,
        /(?<![\p{L}])(?:mandame|mandá|manda|enviame|enviá|pasame|reenviá)(?![\p{L}])/iu,
        /por (?:el |este |acá|aquí|acá|este)?\s?chat/iu,
        /respond(?:é|e|eme) con/iu,
    ];
    for (const t of todos) {
        for (const re of POR_CHAT) {
            const m = t.visible.match(re);
            if (m) falla(`${t.id}: pide mandar algo por el chat ("${m[0]}")`);
        }
    }
    for (const aviso of AVISOS_ACCIONABLES) {
        const p = renderTelegram(aviso, { minutesLeft: 27, ageMinutes: 27 });
        if (!/terminal/i.test(p.action)) falla(`${aviso}: la acción no dice "terminal"`);
    }
});

// --- UX-6.9 -----------------------------------------------------------------
regla('UX-6.9', `message <= ${MAX_MESSAGE} y action <= ${MAX_ACTION} interpolados, sin palabras > ${MAX_PALABRA}`, (falla) => {
    for (const t of textosTelegram) {
        const max = t.campo === 'message' ? MAX_MESSAGE : MAX_ACTION;
        if (t.visible.length > max) falla(`${t.id}: ${t.visible.length} chars > ${max}`);
    }
    for (const t of todos) {
        for (const palabra of t.visible.split(/\s+/)) {
            if (palabra.length > MAX_PALABRA) {
                falla(`${t.id}: palabra de ${palabra.length} chars ("${palabra.slice(0, 20)}...")`);
            }
        }
    }
});

// --- UX-5.5 -----------------------------------------------------------------
regla('UX-5.5', 'warn/error traen acción; los info dicen que no hay nada que hacer', (falla) => {
    for (const aviso of AVISOS) {
        const e = COPY.telegram[aviso];
        const accionable = e.level === 'warn' || e.level === 'error';
        if (accionable && (!e.action || !e.action.trim())) {
            falla(`${aviso}: level ${e.level} sin action`);
        }
        if (!e.message || !e.message.trim()) falla(`${aviso}: sin message`);
    }
    for (const aviso of AVISOS_INFO) {
        const e = COPY.telegram[aviso];
        if (e.level !== 'info') falla(`${aviso}: se esperaba level info y es ${e.level}`);
        if (!e.action.includes(NEGACION_EXPLICITA)) {
            falla(`${aviso}: no dice "${NEGACION_EXPLICITA}"`);
        }
    }
});

// --- UX-7 -------------------------------------------------------------------
regla('UX-7', 'escalada de nivel: A1 warn, A2 error', (falla) => {
    const a1 = renderTelegram('A1_por_vencer', { minutesLeft: 27 });
    const a2 = renderTelegram('A2_urgente', { minutesLeft: 8 });
    if (a1.level !== 'warn') falla(`A1_por_vencer: level ${a1.level}, se esperaba warn`);
    if (a2.level !== 'error') falla(`A2_urgente: level ${a2.level}, se esperaba error`);
    if (a1.component !== a2.component) falla('A1 y A2 no comparten component');
});

// --- UX-9 -------------------------------------------------------------------
regla('UX-9', 'todo texto de la línea de sesión contiene la palabra "sesión"', (falla) => {
    for (const estado of Object.keys(COPY.dashboard.estados)) {
        const texto = COPY.dashboard.estados[estado].texto;
        if (!/sesión/i.test(texto)) falla(`dashboard.estados.${estado}: no dice "sesión" ("${texto}")`);
    }
});

// --- UX-8 -------------------------------------------------------------------
regla('UX-8', 'los cinco estados del dashboard, con title y con sus umbrales', (falla) => {
    const declarados = Object.keys(COPY.dashboard.estados);
    for (const esperado of ESTADOS_DASHBOARD) {
        if (!declarados.includes(esperado)) falla(`falta el estado "${esperado}"`);
        if (!COPY.dashboard.titles[esperado]) falla(`falta el title de "${esperado}"`);
    }
    for (const declarado of declarados) {
        if (!ESTADOS_DASHBOARD.includes(declarado)) falla(`estado no previsto: "${declarado}"`);
    }
    const sobran = Object.keys(COPY.dashboard.titles).filter((k) => !ESTADOS_DASHBOARD.includes(k));
    if (sobran.length) falla(`titles sin estado: ${sobran.join(', ')}`);

    // Umbrales, sobre el renderer: es donde el bug de "vence en -37 min" vive.
    const casos = [
        [{ available: true, minutesLeft: 320 }, 'vigente'],
        [{ available: true, minutesLeft: 31 }, 'vigente'],
        [{ available: true, minutesLeft: 30 }, 'por_vencer'],
        [{ available: true, minutesLeft: 27 }, 'por_vencer'],
        [{ available: true, minutesLeft: 11 }, 'por_vencer'],
        [{ available: true, minutesLeft: 10 }, 'urgente'],
        [{ available: true, minutesLeft: 8 }, 'urgente'],
        [{ available: true, minutesLeft: 0 }, 'vencida'],
        [{ available: true, minutesLeft: -37 }, 'vencida'],
        [{ available: false }, 'sin_datos'],
        [{ available: true }, 'sin_datos'],
    ];
    for (const [entrada, esperado] of casos) {
        const r = renderDashboard(entrada);
        if (r.estado !== esperado) {
            falla(`renderDashboard(${JSON.stringify(entrada)}) => "${r.estado}", se esperaba "${esperado}"`);
        }
        if (/\{[^}]*\}/.test(r.texto)) falla(`${r.estado}: quedó un slot sin resolver ("${r.texto}")`);
        if (/-\d/.test(r.texto)) falla(`${r.estado}: minutos negativos en el texto ("${r.texto}")`);
        if (!r.title) falla(`${r.estado}: sin title`);
    }
});

// --- UX-12 ------------------------------------------------------------------
regla('UX-12', 'formato de tiempo reusado del pipeline (8 min / 27 min / 3 h / 5 h 20 min)', (falla) => {
    const esperados = [[8, '8 min'], [27, '27 min'], [180, '3 h'], [320, '5 h 20 min']];
    for (const [min, texto] of esperados) {
        const got = formatDurationEs(min * 60000);
        if (got !== texto) falla(`${min} min => "${got}", se esperaba "${texto}"`);
    }
    // Los ejemplos declarados en el copy tienen que ser producibles.
    for (const ej of COPY.formato_tiempo.ejemplos) {
        if (!esperados.some(([, t]) => t === ej)) falla(`ejemplo del copy no verificado: "${ej}"`);
    }
});

// --- Salida -----------------------------------------------------------------
const ancho = Math.max(...resultados.map((r) => r.id.length));
let fallas = 0;
for (const r of resultados) {
    const ok = r.fallas.length === 0;
    if (!ok) fallas += 1;
    console.log(`${ok ? '✓' : '✗'} ${r.id.padEnd(ancho)}  ${r.descripcion}`);
    for (const f of r.fallas) console.log(`    - ${f}`);
}
console.log('');
console.log(`Textos auditados: ${textosTelegram.length} de Telegram + ${textosDashboard.length} del dashboard`);
if (fallas > 0) {
    console.log(`RESULTADO: FALLA - ${fallas} regla(s) incumplida(s) de ${resultados.length}`);
    process.exit(1);
}
console.log(`RESULTADO: OK - ${resultados.length} reglas OK, 0 fallas`);
