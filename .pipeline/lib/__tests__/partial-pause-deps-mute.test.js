// =============================================================================
// partial-pause-deps-mute.test.js — Store del silencio de la alerta de
// dependencias faltantes (issue #6118, CA-9..CA-13).
//
// Lo que se protege acá es la promesa del botón: "No avisarme por 24 h". Si el
// silencio se pierde al reiniciar, o si tapa una situación distinta de la que el
// operador silenció, el botón miente — que es exactamente el defecto que #6118
// vino a corregir en el copy.
//
// Aislamiento: `PIPELINE_DIR_OVERRIDE` apunta a un tmp, así que ningún test
// escribe en el pipeline real.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-deps-mute-'));
process.env.PIPELINE_DIR_OVERRIDE = TMP;

const store = require('../partial-pause-deps-mute');
const { alertSignature } = require('../partial-pause-deps');

const AHORA = 1_700_000_000_000;   // epoch fijo: nada depende del reloj real
const H = 60 * 60 * 1000;

/** Cada test arranca con el archivo limpio. */
function reset() {
    try { fs.unlinkSync(store.muteFilePath()); } catch {}
    for (const f of fs.readdirSync(TMP)) {
        if (f.startsWith('partial-pause-deps-mute.json.tmp')) {
            try { fs.unlinkSync(path.join(TMP, f)); } catch {}
        }
    }
}

// ─── CA-9 · silenciar no muta la selección ───────────────────────────────────

test('#6118 CA-9 el módulo no tiene ningún camino hacia las primitivas de mutación', () => {
    // Verificable por lectura del fuente: si mañana alguien requiere
    // `partial-pause` acá adentro, este test lo cachea. Un botón que dice "no
    // cambio nada" no puede tener a mano la función que cambia todo.
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'partial-pause-deps-mute.js'), 'utf8');
    // Se miden las LÍNEAS DE CÓDIGO, no los comentarios: el header del módulo
    // nombra estas primitivas justamente para explicar por qué no las usa, y un
    // test que se rompiera con eso empujaría a borrar la explicación.
    const codigo = fuente
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(l => !l.trim().startsWith('//'))
        .join('\n');
    for (const prohibido of ['setPartialPause', 'clearPartialPause', 'resumeAll', "require('./partial-pause')"]) {
        assert.ok(!codigo.includes(prohibido),
            `el store del silencio no puede nombrar ${prohibido} en código ejecutable`);
    }
    // Y no importa NADA que pueda mutar el estado del pipeline.
    const requires = [...codigo.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
    assert.deepEqual(requires.sort(), ['./config-resolver', 'fs', 'path'],
        'la superficie de dependencias del store tiene que quedarse chica y aburrida');
});

// ─── CA-10 · la firma distingue situaciones ──────────────────────────────────

test('#6118 CA-10 una dependencia NUEVA cambia la firma: la alerta vuelve aunque la ventana siga vigente', () => {
    reset();
    const sigVieja = alertSignature(6033, [6032]);
    store.mute(sigVieja, { issue: 6033, deps: [6032], ttlMs: 24 * H, now: AHORA });

    assert.equal(store.isMuted(sigVieja, AHORA + H), true, 'lo silenciado sigue silenciado');

    // Aparece #6031: es otra situación, no la que el operador silenció.
    const sigNueva = alertSignature(6033, [6032, 6031]);
    assert.notEqual(sigNueva, sigVieja);
    assert.equal(store.isMuted(sigNueva, AHORA + H), false,
        'ocultar una dependencia nueva sería un punto ciego');
});

test('#6118 el orden de las dependencias no cambia la firma (la normaliza alertSignature)', () => {
    reset();
    store.mute(alertSignature(6033, [6032, 6031]), { issue: 6033, deps: [6032, 6031], now: AHORA });
    assert.equal(store.isMuted(alertSignature(6033, [6031, 6032]), AHORA + H), true,
        'el mismo conjunto en otro orden es la MISMA situación');
});

test('#6118 el silencio es por issue: silenciar #6033 no silencia a #6040', () => {
    reset();
    store.mute(alertSignature(6033, [6032]), { issue: 6033, deps: [6032], now: AHORA });
    assert.equal(store.isMuted(alertSignature(6040, [6032]), AHORA), false);
});

// ─── CA-10 · el silencio vence ───────────────────────────────────────────────

test('#6118 CA-10 pasada la ventana el silencio caduca y la alerta vuelve', () => {
    reset();
    const sig = alertSignature(6033, [6032]);
    store.mute(sig, { issue: 6033, deps: [6032], ttlMs: 24 * H, now: AHORA });

    assert.equal(store.isMuted(sig, AHORA + 23 * H), true, 'dentro de la ventana sigue callado');
    assert.equal(store.isMuted(sig, AHORA + 24 * H), false, 'justo al vencer ya avisa');
    assert.equal(store.isMuted(sig, AHORA + 48 * H), false);
});

test('#6118 volver a silenciar la misma firma renueva la ventana (idempotente)', () => {
    reset();
    const sig = alertSignature(6033, [6032]);
    store.mute(sig, { issue: 6033, deps: [6032], ttlMs: 2 * H, now: AHORA });
    store.mute(sig, { issue: 6033, deps: [6032], ttlMs: 2 * H, now: AHORA + H });
    assert.equal(store.isMuted(sig, AHORA + 2.5 * H), true, 'la ventana se corrió');
    assert.equal(Object.keys(store.readAll().entries).length, 1, 'no duplica entradas');
});

// ─── CA-11 · sobrevive al reinicio ───────────────────────────────────────────

test('#6118 CA-11 el silencio vive en archivo: sobrevive a un proceso nuevo', () => {
    reset();
    const sig = alertSignature(6033, [6032]);
    store.mute(sig, { issue: 6033, deps: [6032], ttlMs: 24 * H, now: AHORA });

    // Se re-lee desde el disco, sin ningún estado en memoria de por medio: es lo
    // que hace el Pulpo después de un respawn.
    const persistido = JSON.parse(fs.readFileSync(store.muteFilePath(), 'utf8'));
    assert.equal(persistido.entries[sig].issue, 6033);
    assert.deepEqual(persistido.entries[sig].deps, [6032]);
    assert.ok(persistido.entries[sig].expiresAt > AHORA);
});

// ─── CA-12 · auditoría ───────────────────────────────────────────────────────

test('#6118 CA-12 cada silencio registra quién, qué issue, qué deps, cuándo y hasta cuándo', () => {
    reset();
    const sig = alertSignature(6033, [6032, 6031]);
    store.mute(sig, { issue: 6033, deps: [6032, 6031], operatorRef: '111222333', ttlMs: 24 * H, now: AHORA });

    const [e] = store.listActive(AHORA);
    assert.equal(e.issue, 6033);
    assert.deepEqual(e.deps, [6032, 6031]);
    assert.equal(e.operatorRef, '111222333');
    assert.equal(e.mutedAt, new Date(AHORA).toISOString());
    assert.equal(e.expiresAt, AHORA + 24 * H);
    assert.equal(e.signature, sig);
});

test('#6118 el operatorRef se recorta: un valor largo no puede inflar el archivo de estado', () => {
    reset();
    store.mute('9:1', { issue: 9, deps: [1], operatorRef: 'x'.repeat(500), now: AHORA });
    assert.equal(store.readAll().entries['9:1'].operatorRef.length, 64);
});

// ─── CA-13 · TTL configurable, acotado y nunca infinito ──────────────────────

test('#6118 CA-13 el TTL sale de config con default explícito y clamp duro', () => {
    assert.equal(store.resolveTtlMs({ partial_pause_deps: { mute_ttl_ms: 6 * H } }), 6 * H);
    assert.equal(store.resolveTtlMs({ mute_ttl_ms: 6 * H }), 6 * H, 'acepta el sub-objeto directo');
    // Sin configurar → default explícito, no "para siempre".
    assert.equal(store.resolveTtlMs({}), store.DEFAULT_TTL_MS);
    assert.equal(store.resolveTtlMs(undefined), store.DEFAULT_TTL_MS);
    for (const basura of [0, -1, 'x', null, NaN]) {
        assert.equal(store.resolveTtlMs({ partial_pause_deps: { mute_ttl_ms: basura } }), store.DEFAULT_TTL_MS);
    }
    // Un valor absurdo no puede volver el silencio permanente (OWASP A09).
    assert.equal(store.resolveTtlMs({ partial_pause_deps: { mute_ttl_ms: 365 * 24 * H } }), store.MAX_TTL_MS);
    assert.equal(store.resolveTtlMs({ partial_pause_deps: { mute_ttl_ms: 1 } }), store.MIN_TTL_MS);
});

test('#6118 el clamp también aplica al ttlMs que llega por parámetro', () => {
    reset();
    const r = store.mute('9:1', { issue: 9, deps: [1], ttlMs: 365 * 24 * H, now: AHORA });
    assert.equal(r.ttlMs, store.MAX_TTL_MS, 'nunca infinito, venga de donde venga');
    assert.equal(store.isMuted('9:1', AHORA + store.MAX_TTL_MS), false);
});

// ─── Robustez del archivo ────────────────────────────────────────────────────

test('#6118 un archivo corrupto no tira: degrada a "no hay silencios"', () => {
    reset();
    // Lado seguro: ante un estado ilegible se avisa de MÁS, nunca de menos.
    for (const basura of ['{ no es json', '', 'null', '[]', '{"entries": "x"}', '{"entries": null}']) {
        fs.writeFileSync(store.muteFilePath(), basura);
        assert.deepEqual(store.readAll().entries, {}, `no debería romper con: ${basura}`);
        assert.equal(store.isMuted('6033:6032', AHORA), false);
    }
    // Y el próximo silencio lo reescribe entero, sin quedar trabado.
    store.mute('6033:6032', { issue: 6033, deps: [6032], now: AHORA });
    assert.equal(store.isMuted('6033:6032', AHORA), true);
});

test('#6118 el write es atómico: no queda ningún .tmp huérfano', () => {
    reset();
    for (let i = 0; i < 5; i++) {
        store.mute(`60${i}:1`, { issue: 600 + i, deps: [1], now: AHORA });
    }
    const huerfanos = fs.readdirSync(TMP).filter(f => f.includes('.tmp.'));
    assert.deepEqual(huerfanos, [], 'un tmp que sobrevive es un write que se cortó a la mitad');
    assert.equal(Object.keys(store.readAll().entries).length, 5);
});

test('#6118 una firma vacía no persiste nada', () => {
    reset();
    for (const vacia of ['', null, undefined]) {
        const r = store.mute(vacia, { issue: 6033, deps: [6032], now: AHORA });
        assert.equal(r.ok, false);
    }
    assert.equal(fs.existsSync(store.muteFilePath()), false, 'ni siquiera se crea el archivo');
});

// ─── Poda y reversión ────────────────────────────────────────────────────────

test('#6118 pruneExpired limpia los vencidos y conserva los vigentes', () => {
    reset();
    store.mute('1:1', { issue: 1, deps: [1], ttlMs: 1 * H, now: AHORA });
    store.mute('2:2', { issue: 2, deps: [2], ttlMs: 48 * H, now: AHORA });

    const r = store.pruneExpired(AHORA + 2 * H);
    assert.equal(r.removed, 1);
    assert.equal(r.remaining, 1);
    assert.deepEqual(Object.keys(store.readAll().entries), ['2:2']);
});

test('#6118 mute también poda de paso: el archivo no crece sin límite', () => {
    reset();
    store.mute('1:1', { issue: 1, deps: [1], ttlMs: 1 * H, now: AHORA });
    store.mute('2:2', { issue: 2, deps: [2], ttlMs: 24 * H, now: AHORA + 2 * H });
    assert.deepEqual(Object.keys(store.readAll().entries), ['2:2'], 'el vencido se fue solo');
});

test('#6118 listActive devuelve sólo los vigentes, del que vence antes al que vence después', () => {
    reset();
    store.mute('3:3', { issue: 3, deps: [3], ttlMs: 48 * H, now: AHORA });
    store.mute('1:1', { issue: 1, deps: [1], ttlMs: 2 * H, now: AHORA });
    store.mute('2:2', { issue: 2, deps: [2], ttlMs: 24 * H, now: AHORA });

    assert.deepEqual(store.listActive(AHORA).map(e => e.issue), [1, 2, 3]);
    assert.deepEqual(store.listActive(AHORA + 3 * H).map(e => e.issue), [2, 3], 'el vencido no figura');
});

test('#6118 unmute revierte un silencio puntual y es idempotente', () => {
    reset();
    // Un estado que sólo se puede escribir y nunca revertir es una trampa
    // operativa: si el operador se arrepiente tiene que poder salir.
    store.mute('6033:6032', { issue: 6033, deps: [6032], now: AHORA });
    assert.equal(store.unmute('6033:6032').existed, true);
    assert.equal(store.isMuted('6033:6032', AHORA), false);
    assert.equal(store.unmute('6033:6032').existed, false, 'segunda vez no rompe');
    assert.equal(store.unmute('no-existe').ok, true);
});
