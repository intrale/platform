// =============================================================================
// #6144 — Aviso de cadena de IA caída: copy con causa + entrega hablada.
//
// Cubre CA-1..CA-25. Los CA de contenido se verifican sobre el copy REAL
// (`assets/audio/provider-down/copy.json`), no sobre una copia en el test: si
// alguien edita el copy y rompe un CA, esta suite tiene que enterarse.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const notice = require('../commander/provider-down-notice');
const mp = require('../commander/multi-provider');
const pauseCause = require('../provider-pause-cause');

const {
    CAUSE_REPOSO, CAUSE_CUOTA, CAUSE_AUTH, CAUSE_TRANSITORIA, CAUSE_DISPONIBLE,
    REASON_TABLE,
} = pauseCause;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Clasificación sana con una causa dominante dada. */
function clasif(dominantCause, providers = []) {
    return { degraded: false, stale: false, ageMinutes: 1, dominantCause, providers, verdict: null };
}

/** Provider en reposo con hora de despertar. */
function reposoProv(atHHMM, when = 'today', minutesFromNow = 30) {
    return { id: 'anthropic', cause: CAUSE_REPOSO, rest: { resting: true, atHHMM, when, minutesFromNow } };
}

/** Regex de hora de reloj. */
const HORA_RE = /\d{1,2}:\d{2}/;

/**
 * No-fuga de slashes con la semántica ratificada por el PO (D9):
 * `/` permitido SÓLO para la allowlist cerrada de comandos determinísticos.
 * Cualquier otro `/` es fuga de ruta.
 */
function slashesFueraDeAllowlist(texto) {
    const total = (texto.match(/\//g) || []).length;
    const permitidos = (texto.match(/\/(status|listado|lanzar)\b/g) || []).length;
    return total - permitidos;
}

function mkTmpState() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdn6144-'));
    return { dir, statePath: path.join(dir, 'state.json') };
}

function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Deps de audio con contadores de "spawn" (cada TTS = 2 procesos reales). */
function mkAudioDeps(overrides = {}) {
    const counts = { tts: 0, send: 0, clipReads: 0 };
    const deps = {
        botToken: 'tok',
        chatId: '123',
        audioPolicy: { enabled: true, kill_switch: false, by_event: { commander_reply: true } },
        textToSpeechWithMeta: async () => { counts.tts++; return { buffer: Buffer.from('ogg-fake') }; },
        sendVoiceTelegram: async () => { counts.send++; return true; },
        readClip: (p) => { counts.clipReads++; return fs.readFileSync(p); },
        ...overrides,
    };
    return { deps, counts };
}

// =============================================================================
// CA-1 · Estructura de cuatro partes en orden
// =============================================================================

test('#6144 CA-1 — el texto trae las cuatro partes en el orden ratificado por UX', () => {
    const t = notice.buildDownNoticeText(clasif(CAUSE_REPOSO, [reposoProv('07:00')]));
    const partes = t.split('\n\n');
    assert.equal(partes.length, 4, `esperaba 4 bloques, hubo ${partes.length}: ${t}`);

    // (a) qué pasó
    assert.match(partes[0], /pausada por horario/);
    // (b) qué sigue vivo — va SEGUNDO a propósito (baja la ansiedad antes de la
    //     mala noticia). Invertirlo con (c) cambia el tono del aviso.
    assert.match(partes[1], /pipeline y los agentes siguen trabajando/);
    assert.match(partes[1], /\/status/);
    assert.match(partes[1], /\/listado/);
    assert.match(partes[1], /\/lanzar/);
    // (c) qué pasó con tu pedido
    assert.match(partes[2], /no quedó encolado/);
    // (d) cuándo vuelve
    assert.match(partes[3], /Se reanuda a las 07:00/);
});

// =============================================================================
// CA-2 / CA-20 · Titular por causa dominante, incluida la causa mixta
// =============================================================================

test('#6144 CA-2/CA-20 — titular por causa: cuota, reposo, auth, transitoria', () => {
    assert.match(notice.buildDownNoticeText(clasif(CAUSE_CUOTA)), /Se agotó el cupo de uso/);
    assert.match(notice.buildDownNoticeText(clasif(CAUSE_TRANSITORIA)), /caída temporal del servicio/);
    assert.match(notice.buildDownNoticeText(clasif(CAUSE_AUTH)), /problema de acceso que necesita tu intervención/);
    assert.match(
        notice.buildDownNoticeText(clasif(CAUSE_REPOSO, [reposoProv('07:00')])),
        /pausada por horario/,
    );
});

test('#6144 CA-2 — causa mixta: gana la de mayor precedencia (auth > cuota > transitoria > reposo)', () => {
    // La precedencia la resuelve `provider-pause-cause`; acá verificamos que el
    // copy la respeta en vez de reimplementar su propio criterio.
    const mixta = [
        { id: 'a', cause: CAUSE_REPOSO, rest: { atHHMM: '07:00', when: 'today', minutesFromNow: 10 } },
        { id: 'b', cause: CAUSE_CUOTA },
        { id: 'c', cause: CAUSE_AUTH },
        { id: 'd', cause: CAUSE_TRANSITORIA },
    ];
    const dominante = pauseCause.pickDominantCause(mixta);
    assert.equal(dominante, CAUSE_AUTH, 'precedencia esperada del módulo de causas');

    const t = notice.buildDownNoticeText(clasif(dominante, mixta));
    assert.match(t, /problema de acceso/);
    assert.ok(!/cupo de uso|pausada por horario|caída temporal/.test(t), `no debe mezclar titulares: ${t}`);
});

test('#6144 CA-2 — `disponible` nunca es titular: degrada a genérico', () => {
    const t = notice.buildDownNoticeText(clasif(CAUSE_DISPONIBLE));
    assert.match(t, /Ahora mismo no puedo responderte con IA/);
});

// =============================================================================
// CA-19 / CA-20 · Fail-closed: snapshot stale o degradado → genérico
// =============================================================================

test('#6144 CA-19 — snapshot degradado o stale degrada a genérico sin afirmar causa', () => {
    const casos = [
        { degraded: true, stale: false, dominantCause: null, providers: [] },
        // `stale` con causa: el dato es viejo, así que NO la afirmamos.
        { degraded: false, stale: true, dominantCause: CAUSE_CUOTA, providers: [] },
        { degraded: false, stale: false, dominantCause: null, providers: [] },
        null,
        undefined,
        'no-soy-un-objeto',
    ];
    for (const c of casos) {
        const t = notice.buildDownNoticeText(c);
        assert.match(t, /Ahora mismo no puedo responderte con IA/, `debe degradar: ${JSON.stringify(c)}`);
        assert.ok(!/cupo de uso|pausada por horario|problema de acceso|caída temporal/.test(t),
            `no debe afirmar causa: ${t}`);
        // CA-19 — el aviso SE EMITE igual: quedarse mudo es el problema original.
        assert.match(t, /pipeline y los agentes siguen trabajando/);
        assert.match(t, /no quedó encolado/);
    }
});

// =============================================================================
// CA-3 · Hora sólo en `reposo`
// =============================================================================

test('#6144 CA-3 — sólo `reposo` lleva hora; cuota/transitoria/auth no traen ningún dígito', () => {
    const conHora = notice.buildDownNoticeText(clasif(CAUSE_REPOSO, [reposoProv('20:30')]));
    assert.match(conHora, HORA_RE);
    assert.match(conHora, /20:30/);

    for (const causa of [CAUSE_CUOTA, CAUSE_TRANSITORIA, CAUSE_AUTH]) {
        const t = notice.buildDownNoticeText(clasif(causa));
        assert.ok(!HORA_RE.test(t), `${causa} no debe llevar hora: ${t}`);
        // D2 — prohibido inventar cualquier estimación numérica.
        assert.ok(!/\d/.test(t), `${causa} no debe llevar ningún dígito: ${t}`);
    }
    const gen = notice.buildDownNoticeText(clasif(null));
    assert.ok(!/\d/.test(gen), `el genérico no debe llevar dígitos: ${gen}`);
});

test('#6144 CA-3 — el día queda explícito cuando la reanudación es mañana', () => {
    // `~07:00` a las 23:50 es ambiguo; el copy tiene que desambiguar el día.
    const t = notice.buildDownNoticeText(clasif(CAUSE_REPOSO, [reposoProv('07:00', 'tomorrow', 400)]));
    assert.match(t, /07:00 de mañana/);
});

test('#6144 CA-3 — de varios proveedores en reposo gana el que despierta primero', () => {
    const t = notice.buildDownNoticeText(clasif(CAUSE_REPOSO, [
        reposoProv('23:00', 'today', 300),
        reposoProv('08:15', 'today', 45),
        reposoProv('20:00', 'today', 120),
    ]));
    assert.match(t, /08:15/);
    assert.ok(!/23:00|20:00/.test(t), `sólo la hora más próxima: ${t}`);
});

test('#6144 CA-3/D2 — `reposo` sin reloj resoluble omite el bloque (d) en vez de inventar una hora', () => {
    // CA-1(d) declara el bloque de recuperación condicional ("sólo si es
    // estimable") y D2 prohíbe inventar horas. Sin reloj válido: 3 bloques, cero
    // dígitos, y el titular sigue siendo verdadero (la pausa por horario existe).
    for (const providers of [[], [{ id: 'a', cause: CAUSE_REPOSO, rest: null }],
        [{ id: 'a', cause: CAUSE_REPOSO, rest: { atHHMM: 'no-es-una-hora' } }],
        [{ id: 'a', cause: CAUSE_REPOSO, rest: { atHHMM: '99:99' } }]]) {
        const t = notice.buildDownNoticeText(clasif(CAUSE_REPOSO, providers));
        assert.equal(t.split('\n\n').length, 3, `sin hora se omite (d): ${t}`);
        assert.ok(!/\d/.test(t), `sin hora no puede quedar ningún dígito: ${t}`);
        assert.match(t, /pausada por horario/);
    }
});

// =============================================================================
// CA-4 / CA-5 · Descarte sin eufemismos, sin promesas falsas
// =============================================================================

test('#6144 CA-4/CA-5 — dice que el pedido no quedó encolado y no promete avisos que no existen', () => {
    for (const causa of [CAUSE_CUOTA, CAUSE_REPOSO, CAUSE_AUTH, CAUSE_TRANSITORIA, null]) {
        const providers = causa === CAUSE_REPOSO ? [reposoProv('07:00')] : [];
        const t = notice.buildDownNoticeText(clasif(causa, providers));
        // CA-4 (D3) — sin eufemismos.
        assert.match(t, /no quedó encolado/, `falta el descarte explícito: ${t}`);
        assert.match(t, /repetilo cuando vuelva el servicio|revises el acceso/, `falta la acción: ${t}`);
        // CA-5 (D4) — no existe notificador de recuperación de la cadena.
        assert.ok(!/te aviso|avisar[ée]|te notifico|ya te contesto/i.test(t),
            `promete un aviso inexistente: ${t}`);
    }
});

// =============================================================================
// CA-6 / CA-7 / CA-21 · No-fuga y longitud
// =============================================================================

test('#6144 CA-21 — para CADA código de REASON_TABLE, ni el texto ni el guion filtran internals', () => {
    const codigos = Object.keys(REASON_TABLE);
    assert.ok(codigos.length >= 15, `REASON_TABLE debería traer los códigos reales, trajo ${codigos.length}`);

    for (const code of codigos) {
        const entry = REASON_TABLE[code];
        const causa = entry && entry.cause ? entry.cause : CAUSE_TRANSITORIA;

        // Clasificación HOSTIL: trae todo lo que NO debe llegar al operador.
        const hostil = {
            degraded: false,
            stale: false,
            ageMinutes: 42,
            dominantCause: causa,
            providers: [{
                id: 'openai-codex',
                label: 'OpenAI Codex',
                cause: causa,
                reasonCode: code,
                pct: 99,
                rest: { resting: true, atHHMM: '07:00', when: 'today', minutesFromNow: 30 },
            }],
            verdict: {
                requiresAction: true,
                text: 'Requiere acción: no hay dato de salud fresco (último hace 42 min). '
                    + 'Revisá .pipeline/lib/provider-pause-cause.js',
            },
        };

        const texto = notice.buildDownNoticeText(hostil);
        const guion = notice.buildDownNoticeAudioText(hostil);

        for (const [nombre, salida] of [['texto', texto], ['guion', guion]]) {
            assert.ok(!/openai|codex|anthropic|cerebras|gemini|groq/i.test(salida),
                `${nombre} filtra nombre de proveedor (${code}): ${salida}`);
            assert.ok(!salida.includes(code) || code === 'authenticated',
                `${nombre} filtra el reason_code ${code}: ${salida}`);
            assert.ok(!/\.js\b|\.json\b|\.ogg\b/.test(salida), `${nombre} filtra extensión (${code}): ${salida}`);
            assert.ok(!/\\/.test(salida), `${nombre} filtra backslash (${code}): ${salida}`);
            assert.ok(!/Requiere acción|chequeo periódico/.test(salida),
                `${nombre} filtra diagnóstico interno (${code}): ${salida}`);
            assert.ok(!/99/.test(salida), `${nombre} filtra porcentaje (${code}): ${salida}`);
            assert.ok(!/42/.test(salida), `${nombre} filtra la edad del snapshot (${code}): ${salida}`);
        }

        // D9 — el texto puede traer `/` SÓLO por la allowlist de comandos.
        assert.equal(slashesFueraDeAllowlist(texto), 0, `texto con slash fuera de allowlist (${code}): ${texto}`);
        // El guion hablado cumple CA-21 estricto: cero `/`.
        assert.equal((guion.match(/\//g) || []).length, 0, `guion con slash (${code}): ${guion}`);
    }
});

test('#6144 CA-7/CA-11 — texto y guion respetan el cap de 600 chars', () => {
    for (const causa of [CAUSE_CUOTA, CAUSE_REPOSO, CAUSE_AUTH, CAUSE_TRANSITORIA, null]) {
        const providers = causa === CAUSE_REPOSO ? [reposoProv('07:00', 'tomorrow', 400)] : [];
        const c = clasif(causa, providers);
        assert.ok(notice.buildDownNoticeText(c).length <= 600, `texto > 600 en ${causa}`);
        assert.ok(notice.buildDownNoticeAudioText(c).length <= 600, `guion > 600 en ${causa}`);
    }
});

// =============================================================================
// CA-9 / CA-11 · Guion hablado
// =============================================================================

test('#6144 CA-11 — el guion nace de plantilla: sin emojis, sin markdown y sin eco del operador', () => {
    const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    const MARKDOWN = /[*_`#[\]]/;
    for (const causa of [CAUSE_CUOTA, CAUSE_REPOSO, CAUSE_AUTH, CAUSE_TRANSITORIA, null]) {
        const providers = causa === CAUSE_REPOSO ? [reposoProv('07:00')] : [];
        const g = notice.buildDownNoticeAudioText(clasif(causa, providers));
        assert.ok(!EMOJI.test(g), `guion con emoji (${causa}): ${g}`);
        assert.ok(!MARKDOWN.test(g), `guion con markdown (${causa}): ${g}`);
        // Earcon verbal: el operador reconoce el aviso en el primer segundo.
        assert.match(g, /^Aviso del sistema\./, `falta el encabezado fijo (${causa}): ${g}`);
    }
});

test('#6144 CA-11/REQ-SEC-3 — el guion no depende del input del operador (no hay parámetro por donde ecoarlo)', () => {
    // La firma sólo acepta la clasificación: no existe un camino por el que el
    // mensaje del operador pueda entrar al guion.
    assert.equal(notice.buildDownNoticeAudioText.length, 1);
    const g1 = notice.buildDownNoticeAudioText(clasif(CAUSE_CUOTA));
    const g2 = notice.buildDownNoticeAudioText(clasif(CAUSE_CUOTA));
    assert.equal(g1, g2, 'el guion es determinístico por causa');
});

test('#6144 — el guion dinámico de `reposo` dice la hora; el pregrabado remite al texto', () => {
    const conHora = notice.buildDownNoticeAudioText(clasif(CAUSE_REPOSO, [reposoProv('07:00')]));
    assert.match(conHora, /Se reanuda a las 07:00\./);
    assert.ok(!conHora.includes(notice.REPOSO_CLIP_TAIL), 'la frase que remite al texto debió reemplazarse');

    const sinHora = notice.buildDownNoticeAudioText(clasif(CAUSE_REPOSO, []));
    assert.ok(sinHora.includes(notice.REPOSO_CLIP_TAIL), 'sin hora debe remitir al texto');
    assert.ok(!/\d/.test(sinHora), 'sin hora el guion no lleva dígitos');
});

test('#6144 — guarda anti-drift: la frase de reemplazo existe tal cual en copy.json', () => {
    // Si UX reescribe esa frase, el guion dinámico de `reposo` dejaría de decir
    // la hora en silencio. Que falle acá y no en producción.
    const copy = notice.loadCopy(true);
    assert.ok(String(copy.voz_clip.reposo).includes(notice.REPOSO_CLIP_TAIL),
        'REPOSO_CLIP_TAIL quedó desincronizado de copy.json');
});

test('#6144 CA-9 — el perfil de voz no depende de ningún LLM (edge primary, sin fallback)', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tts-config.json'), 'utf8'));
    const perfil = (cfg.profiles && cfg.profiles['need-human']) || cfg['need-human'];
    assert.ok(perfil, 'el perfil need-human debe existir (D5/CA-10)');
    assert.equal(perfil.primary, 'edge', 'primary debe ser edge: no toca ninguna API de LLM');
    assert.ok(!perfil.fallback, 'sin fallback: ninguna ruta alternativa puede meter un LLM');
});

// =============================================================================
// CA-13 · Clips pregrabados
// =============================================================================

test('#6144 CA-13 — hay un clip por causa dominante más el genérico, y resuelven', () => {
    for (const key of ['reposo', 'cuota', 'transitoria', 'auth', 'generico']) {
        const p = notice.resolveFallbackClip(key);
        assert.ok(p, `falta el clip de ${key}`);
        assert.ok(p.startsWith(notice.CLIP_DIR), `el clip de ${key} debe vivir en el directorio fijo: ${p}`);
        assert.ok(fs.statSync(p).size > 0, `el clip de ${key} está vacío`);
    }
});

test('#6144 CA-13/REQ-SEC-5 — resolución por mapa estático: nada fuera del directorio de clips', () => {
    const hostiles = [
        '../../pulpo', '../../../etc/passwd', '..\\..\\pulpo',
        'disponible', '', null, undefined, 'reposo.ogg', '__proto__', 'constructor',
        path.join(notice.CLIP_DIR, 'reposo.ogg'),
    ];
    for (const h of hostiles) {
        assert.equal(notice.resolveFallbackClip(h), null, `no debe resolver ${JSON.stringify(h)}`);
    }
});

// =============================================================================
// CA-14 / CA-15 / CA-16 / CA-22 / CA-23 · Cooldown
// =============================================================================

test('#6144 CA-14 — misma causa en la misma ventana: un solo audio', () => {
    const T0 = 1_000_000;
    let st = {};
    const r1 = notice.shouldEmitDownAudio(st, 'cuota', T0);
    assert.equal(r1.notify, true, 'el primero siempre suena');
    st = r1.nextState;

    for (let i = 1; i <= 10; i++) {
        const r = notice.shouldEmitDownAudio(st, 'cuota', T0 + i * 60_000);
        assert.equal(r.notify, false, `repetición ${i} no debe sonar`);
        st = r.nextState;
    }
});

test('#6144 CA-16 — cambiar de causa abre ventana nueva, pero respeta el mínimo de 15 min', () => {
    const T0 = 1_000_000;
    let st = notice.shouldEmitDownAudio({}, 'cuota', T0).nextState;

    // A los 5 min cambia la causa: la guarda anti-flapping lo frena.
    const temprano = notice.shouldEmitDownAudio(st, 'auth', T0 + 5 * 60_000);
    assert.equal(temprano.notify, false, 'no puede sonar antes de los 15 min');

    // Y el estado queda INTACTO: si se persistiera la ventana nueva con el audio
    // suprimido, la causa nueva no sonaría nunca.
    assert.equal(temprano.nextState.cause, 'cuota');
    assert.equal(temprano.nextState.lastAudioAtMs, T0);

    // Pasados los 15 min, la causa nueva sí suena.
    const tarde = notice.shouldEmitDownAudio(temprano.nextState, 'auth', T0 + 16 * 60_000);
    assert.equal(tarde.notify, true, 'pasados 15 min la causa nueva debe sonar');
    assert.equal(tarde.nextState.cause, 'auth');
});

test('#6144 CA-14 — una caída larga con causa estable vuelve a avisar al vencer la ventana', () => {
    const T0 = 1_000_000;
    const st = notice.shouldEmitDownAudio({}, 'cuota', T0).nextState;
    // Dentro de la ventana: mudo.
    assert.equal(notice.shouldEmitDownAudio(st, 'cuota', T0 + 5 * 60 * 60_000).notify, false);
    // Vencida: vuelve a sonar (si no, una caída de 3 días avisa una sola vez).
    assert.equal(notice.shouldEmitDownAudio(st, 'cuota', T0 + notice.MAX_WINDOW_MS).notify, true);
});

test('#6144 — causa fuera del mapa se normaliza a genérico en la clave del cooldown', () => {
    const T0 = 1_000_000;
    const r = notice.shouldEmitDownAudio({}, 'causa-inventada', T0);
    assert.equal(r.notify, true);
    assert.equal(r.nextState.cause, notice.GENERIC_KEY);
});

test('#6144 CA-15/CA-23 — el cooldown persiste: recargar el estado del disco no reabre la emisión', () => {
    const { dir, statePath } = mkTmpState();
    try {
        const T0 = 1_000_000;
        const r1 = notice.shouldEmitDownAudio(notice.loadDownAudioState(statePath).state, 'cuota', T0);
        assert.equal(r1.notify, true);
        assert.equal(notice.saveDownAudioState(r1.nextState, statePath), true);

        // Respawn del Pulpo: proceso nuevo, estado leído del disco.
        const recargado = notice.loadDownAudioState(statePath);
        assert.equal(recargado.ok, true);
        const r2 = notice.shouldEmitDownAudio(recargado.state, 'cuota', T0 + 60_000);
        assert.equal(r2.notify, false, 'un respawn dentro de la ventana no debe reabrir la emisión');
    } finally { cleanup(dir); }
});

test('#6144 REQ-SEC-6 — estado ausente permite emitir; estado corrupto es fail-closed', () => {
    const { dir, statePath } = mkTmpState();
    try {
        // Ausente ≠ corrupto: el primer arranque tiene que poder avisar.
        assert.deepEqual(notice.loadDownAudioState(statePath), { ok: true, state: {} });

        for (const basura of ['{no-json', '[]', 'null', '"texto"', '']) {
            fs.writeFileSync(statePath, basura);
            assert.equal(notice.loadDownAudioState(statePath).ok, false,
                `estado corrupto debe ser fail-closed: ${JSON.stringify(basura)}`);
        }
    } finally { cleanup(dir); }
});

test('#6144 CA-22 — flood: N mensajes en la misma ventana ⇒ 1 audio y a lo sumo 2 spawns', async () => {
    const { dir, statePath } = mkTmpState();
    try {
        const { deps, counts } = mkAudioDeps();
        const base = { ...deps, classification: clasif(CAUSE_CUOTA), statePath };

        const resultados = [];
        for (let i = 0; i < 8; i++) {
            resultados.push(await notice.sendDownNoticeAudio({ ...base, now: 1_000_000 + i * 30_000 }));
        }
        assert.equal(resultados.filter(r => r.sent).length, 1, 'exactamente un audio por ventana');
        assert.equal(resultados.filter(r => r.skipped === 'cooldown').length, 7);
        // Cada emisión real spawnea 2 procesos (edge-tts + ffmpeg): 1 síntesis ⇒ ≤ 2.
        assert.equal(counts.tts, 1, 'una sola síntesis');
        assert.equal(counts.send, 1, 'un solo envío de voz');
    } finally { cleanup(dir); }
});

// =============================================================================
// CA-8 / CA-12 / CA-17 / CA-18 / CA-24 · Orquestación del envío
// =============================================================================

test('#6144 CA-8 — con cadena caída se emite el audio con el guion de la causa', async () => {
    const { dir, statePath } = mkTmpState();
    try {
        let guionEnviado = null;
        let perfilUsado = null;
        const { deps } = mkAudioDeps({
            textToSpeechWithMeta: async (texto, opts) => {
                guionEnviado = texto; perfilUsado = opts && opts.profile;
                return { buffer: Buffer.from('ogg') };
            },
        });
        const r = await notice.sendDownNoticeAudio({
            ...deps, classification: clasif(CAUSE_CUOTA), statePath, now: 1_000_000,
        });
        assert.equal(r.sent, true);
        assert.equal(r.via, 'tts');
        assert.match(guionEnviado, /^Aviso del sistema\./);
        assert.match(guionEnviado, /Se agotó el cupo de uso/);
        // CA-10 / D5 — alerta de sistema, no la voz conversacional.
        assert.equal(perfilUsado, 'need-human');
    } finally { cleanup(dir); }
});

test('#6144 CA-17/CA-24 — sin chat autorizado resoluble no se emite nada', async () => {
    const { dir, statePath } = mkTmpState();
    try {
        for (const destino of [{ chatId: '' }, { chatId: null }, { botToken: '' }, { botToken: null }]) {
            const { deps, counts } = mkAudioDeps(destino);
            const r = await notice.sendDownNoticeAudio({
                ...deps, classification: clasif(CAUSE_CUOTA), statePath, now: 1_000_000,
            });
            assert.equal(r.sent, false);
            assert.equal(r.skipped, 'no-destino', JSON.stringify(destino));
            assert.equal(counts.tts, 0, 'no se sintetiza sin destino');
            assert.equal(counts.send, 0);
        }
        // Fail-closed también significa NO consumir la ventana de cooldown.
        assert.deepEqual(notice.loadDownAudioState(statePath), { ok: true, state: {} });
    } finally { cleanup(dir); }
});

test('#6144 CA-24 — el caller sin chat explícito de pulpo.js resuelve el destino antes de emitir', () => {
    // El caller histórico usaba `sendTelegram()` sin resolver el chat. Guarda de
    // regresión sobre el fuente: el aviso tiene que quedar detrás del gate.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    assert.match(src, /if \(getTelegramChatId\(\)\) \{\s*\n\s*sendTelegram\(avisoCadenaCaida\(/,
        'el aviso de texto debe estar detrás del gate de chat autorizado');
    assert.ok(!/sendTelegram\(commanderMP\.cannedAllProvidersFailedResponse\(/.test(src),
        'no debe quedar ningún envío sin resolver el destino');
});

test('#6144 CA-18 — se respetan kill_switch, enabled y by_event de la política de audio', async () => {
    const { dir, statePath } = mkTmpState();
    try {
        const politicas = [
            { enabled: true, kill_switch: true, by_event: { commander_reply: true } },
            { enabled: false, kill_switch: false, by_event: { commander_reply: true } },
            { enabled: true, kill_switch: false, by_event: { commander_reply: false } },
        ];
        for (const audioPolicy of politicas) {
            const { deps, counts } = mkAudioDeps({ audioPolicy });
            const r = await notice.sendDownNoticeAudio({
                ...deps, classification: clasif(CAUSE_CUOTA), statePath, now: 1_000_000,
            });
            assert.equal(r.skipped, 'policy', JSON.stringify(audioPolicy));
            assert.equal(counts.tts, 0);
        }
        // El gate corre ANTES del cooldown: una política apagada no debe quemar
        // la ventana y dejar mudo al operador cuando se reactive.
        assert.deepEqual(notice.loadDownAudioState(statePath), { ok: true, state: {} });
    } finally { cleanup(dir); }
});

test('#6144 CA-12 — TTS que falla degrada al clip pregrabado', async () => {
    const { dir, statePath } = mkTmpState();
    try {
        for (const ttsRoto of [
            async () => { throw new Error('sin red'); },
            async () => null,
            async () => ({ buffer: null }),
        ]) {
            fs.rmSync(statePath, { force: true });
            const { deps, counts } = mkAudioDeps({ textToSpeechWithMeta: ttsRoto });
            const r = await notice.sendDownNoticeAudio({
                ...deps, classification: clasif(CAUSE_AUTH), statePath, now: 1_000_000,
            });
            assert.equal(r.sent, true, 'debe seguir avisando por el clip');
            assert.equal(r.via, 'clip');
            assert.equal(counts.clipReads, 1);
            assert.equal(counts.send, 1);
        }
    } finally { cleanup(dir); }
});

test('#6144 CA-12/REQ-SEC-7 — un TTS colgado no bloquea: vence el timeout y cae al clip', async () => {
    const { dir, statePath } = mkTmpState();
    try {
        const { deps } = mkAudioDeps({
            // Promesa que NUNCA resuelve: es el cuelgue real de `textToSpeechEdge`,
            // que hoy no tiene timer ni kill().
            textToSpeechWithMeta: () => new Promise(() => {}),
        });
        const t0 = Date.now();
        const r = await notice.sendDownNoticeAudio({
            ...deps, classification: clasif(CAUSE_TRANSITORIA), statePath,
            now: 1_000_000, ttsTimeoutMs: 40,
        });
        assert.ok(Date.now() - t0 < 5000, 'no puede quedar colgado esperando al TTS');
        assert.equal(r.sent, true);
        assert.equal(r.via, 'clip');
    } finally { cleanup(dir); }
});

test('#6144 CA-12/CA-13 — sin TTS y sin clip queda sólo el texto, sin propagar el error crudo', async () => {
    const { dir, statePath } = mkTmpState();
    try {
        const { deps, counts } = mkAudioDeps({
            textToSpeechWithMeta: async () => { throw new Error('ENOENT edge-tts.exe /ruta/secreta'); },
            readClip: () => { throw new Error('clip ilegible'); },
        });
        const r = await notice.sendDownNoticeAudio({
            ...deps, classification: clasif(CAUSE_CUOTA), statePath, now: 1_000_000,
        });
        assert.equal(r.sent, false);
        assert.equal(r.skipped, 'sin-audio');
        assert.equal(counts.send, 0, 'no se envía un voice vacío');
        // El error crudo jamás sale de acá.
        assert.ok(!r.error, `no debe propagar el error crudo: ${r.error}`);
    } finally { cleanup(dir); }
});

test('#6144 — sendDownNoticeAudio nunca lanza, ni con dependencias hostiles', async () => {
    const { dir, statePath } = mkTmpState();
    try {
        const casos = [
            {},
            { botToken: 'tok', chatId: '1' },
            { botToken: 'tok', chatId: '1', textToSpeechWithMeta: 'no-soy-función' },
            {
                botToken: 'tok', chatId: '1', statePath,
                textToSpeechWithMeta: () => { throw new Error('sync throw'); },
                sendVoiceTelegram: () => { throw new Error('sync throw'); },
            },
        ];
        for (const c of casos) {
            const r = await notice.sendDownNoticeAudio(c);
            assert.equal(typeof r, 'object');
            assert.equal(r.sent, false, JSON.stringify(Object.keys(c)));
        }
    } finally { cleanup(dir); }
});

// =============================================================================
// CA-25 · La red de seguridad de la anonimización sigue en pie
// =============================================================================

test('#6144 CA-25 — cannedAllProvidersFailedResponse sin `classify` es puro: no lee el snapshot de salud', () => {
    // Ésta es la invariante que mantiene verdes, y determinísticos, a
    // `commander-inflight-fallback.test.js` y `commander-chain-walk-4438.test.js`
    // sin tocarlos. Si el entry point clasificara leyendo disco por default, su
    // copy dependería del estado de la máquina: verificado que el copy de la
    // causa `auth` NO satisface la aserción vigente `/no.*(tengo|puedo).*IA|IA/i`
    // de esos tests, así que quedarían verdes o rojos según el snapshot.
    const original = fs.readFileSync;
    let lecturas = 0;
    fs.readFileSync = function (...args) {
        const p = String(args[0] || '');
        if (/health|snapshot|provider-schedule/i.test(p)) lecturas++;
        return original.apply(this, args);
    };
    try {
        const t = mp.cannedAllProvidersFailedResponse({
            chainTried: ['anthropic', 'openai-codex', 'cerebras'],
            verifiedAllFailed: true,
        });
        assert.equal(lecturas, 0, 'sin `classify` no debe tocar el estado de salud');
        assert.match(t, /Ahora mismo no puedo responderte con IA/);
    } finally {
        fs.readFileSync = original;
    }
});

test('#6144 CA-25 — el contrato de #4440 sigue valiendo con el copy nuevo, en las 5 causas', () => {
    const causas = [CAUSE_CUOTA, CAUSE_AUTH, CAUSE_TRANSITORIA, CAUSE_REPOSO, null];
    for (const causa of causas) {
        const providers = causa === CAUSE_REPOSO ? [reposoProv('07:00')] : [];
        for (const verifiedAllFailed of [true, false]) {
            const t = mp.cannedAllProvidersFailedResponse({
                chainTried: ['anthropic', 'openai-codex', 'cerebras'],
                verifiedAllFailed,
                classify: () => clasif(causa, providers),
            });
            // #4440 CA-1 — nunca afirma que fallaron TODOS.
            assert.ok(!/TODOS/i.test(t), `afirma falla total (${causa}): ${t}`);
            assert.match(t, /⚠️/);
            // #4440 CA-3 — la acción determinística siempre queda anunciada.
            assert.match(t, /\/status/);
            // #4440 CA-2 — cero fuga de cadena, providers o jerga.
            assert.ok(!/anthropic|openai|codex|cerebras|gemini|groq/i.test(t), `fuga de provider: ${t}`);
            assert.ok(!/Intenté con/i.test(t), `fuga de chainTried: ${t}`);
            assert.ok(!/30s|\d+\s*seg|reintento \d|fallback/i.test(t), `fuga de jerga: ${t}`);
        }
    }
});

test('#6144 CA-25 — `classify` que explota degrada a genérico en vez de romper el turno', () => {
    const t = mp.cannedAllProvidersFailedResponse({
        chainTried: ['anthropic'],
        classify: () => { throw new Error('snapshot ilegible'); },
    });
    assert.match(t, /Ahora mismo no puedo responderte con IA/);
    assert.ok(!/snapshot|ilegible/i.test(t), `no filtra el error interno: ${t}`);
});

// =============================================================================
// Smoke: re-exports y contrato del módulo
// =============================================================================

test('#6144 — multi-provider re-exporta la API del aviso de cadena caída', () => {
    for (const fn of ['buildDownNoticeText', 'buildDownNoticeAudioText', 'resolveFallbackClip',
        'shouldEmitDownAudio', 'sendDownNoticeAudio']) {
        assert.equal(typeof mp[fn], 'function', `falta el re-export de ${fn}`);
    }
});

test('#6144 — el copy vive fuera del código y los clips están versionados', () => {
    assert.ok(fs.existsSync(notice.COPY_PATH), 'copy.json es la fuente de verdad y debe existir');
    const copy = notice.loadCopy(true);
    // Si el copy real se cae, el módulo degrada a genérico pero NO se queda mudo.
    assert.equal(Object.keys(copy.texto.causas).length, 5, 'las 5 causas del copy de UX');
    assert.equal(Object.keys(copy.voz_clip).length, 5, 'los 5 guiones hablados');
});
