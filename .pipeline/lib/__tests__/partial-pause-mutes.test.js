// =============================================================================
// partial-pause-mutes.test.js — Store de silencios por caso (issue #5978).
//
// Lo que estos tests protegen, en orden de gravedad si se rompe:
//
//   1. PERSISTENCIA. El bug original era que el silencio vivía en un `Map` en
//      memoria del Pulpo: un restart y la alerta volvía. Por eso el test de
//      persistencia no reusa el módulo ya cargado — lo purga del cache de
//      `require` y lo vuelve a cargar, que es lo más parecido a un restart que
//      se puede simular in-process. Reusar la instancia testearía el `Map` que
//      justamente NO queremos.
//
//   2. FAIL-OPEN. Estado corrupto, ausente o de shape raro ⇒ se alerta igual.
//      Un falso negativo acá deja un issue trabado que nadie ve.
//
//   3. FIRMA EXACTA. El silencio no se hereda cuando cambia el set de deps.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE_PATH = require.resolve('../partial-pause-mutes');

/** Sandbox aislado por test: `PIPELINE_DIR_OVERRIDE` redirige el store. */
function withSandbox(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mutes-'));
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    try {
        return fn(dir);
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prev;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

/** Carga el módulo DESDE CERO (simula el restart del Pulpo). */
function freshModule() {
    delete require.cache[MODULE_PATH];
    return require('../partial-pause-mutes');
}

/** Audit fake: captura las entries sin tocar la hash-chain real del repo. */
function fakeAudit(sink) {
    return (entry) => { sink.push(entry); return { ok: true, hash_self: 'fake' }; };
}

const AUTH = 'telegram:operator';

// ─── Caso feliz + persistencia (CA-1) ────────────────────────────────────────

test('#5978 mute deja el caso silenciado y devuelve la firma canónica', () => {
    withSandbox(() => {
        const m = freshModule();
        const audit = [];
        const r = m.mute({ issue: 6033, deps: [6032], authorizedBy: AUTH, appendMutation: fakeAudit(audit) });
        assert.equal(r.ok, true);
        assert.equal(r.signature, '6033:6032');
        assert.equal(m.isMuted(6033, [6032]), true);
    });
});

test('#5978 la firma es independiente del orden y del tipo de las deps', () => {
    withSandbox(() => {
        const m = freshModule();
        m.mute({ issue: 6033, deps: [6041, 6032], authorizedBy: AUTH, appendMutation: fakeAudit([]) });
        // Mismo set, otro orden y como strings: tiene que matchear igual. Si no,
        // el silencio dependería del orden de detección del barrido.
        assert.equal(m.isMuted(6033, [6032, 6041]), true);
        assert.equal(m.isMuted('6033', ['6041', '6032']), true);
    });
});

test('#5978 CA-1: el silencio SOBREVIVE a un restart del Pulpo', () => {
    withSandbox((dir) => {
        const antes = freshModule();
        antes.mute({ issue: 6033, deps: [6032], authorizedBy: AUTH, appendMutation: fakeAudit([]) });

        // El estado tiene que estar EN DISCO, no en memoria del proceso.
        const file = path.join(dir, 'state', 'partial-pause-mutes.json');
        assert.equal(fs.existsSync(file), true, 'el store se persiste en disco');
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.deepEqual(raw['6033:6032'].deps, [6032]);
        assert.equal(raw['6033:6032'].issue, 6033);
        assert.ok(raw['6033:6032'].muted_at, 'lleva timestamp');

        // Restart: módulo cargado de cero, sin ningún estado in-process.
        const despues = freshModule();
        assert.equal(despues.isMuted(6033, [6032]), true, 'sigue silenciado tras el restart');
    });
});

test('#5978 mute es idempotente: dos taps del mismo botón no re-auditan', () => {
    withSandbox(() => {
        const m = freshModule();
        const audit = [];
        const a = m.mute({ issue: 6033, deps: [6032], authorizedBy: AUTH, appendMutation: fakeAudit(audit) });
        const b = m.mute({ issue: 6033, deps: [6032], authorizedBy: AUTH, appendMutation: fakeAudit(audit) });
        assert.equal(a.ok, true);
        assert.equal(b.ok, true);
        assert.equal(b.alreadyMuted, true);
        assert.equal(audit.length, 1, 'el segundo tap no ensucia el audit');
    });
});

// ─── Firma exacta: el silencio NO se hereda (CA-2) ───────────────────────────

test('#5978 CA-2: si aparece una dep nueva, la firma cambia y el aviso vuelve', () => {
    withSandbox(() => {
        const m = freshModule();
        m.mute({ issue: 6033, deps: [6032], authorizedBy: AUTH, appendMutation: fakeAudit([]) });
        assert.equal(m.isMuted(6033, [6032]), true);
        // Escenario Gherkin: #6033 pasa a depender también de #6041.
        assert.equal(m.isMuted(6033, [6032, 6041]), false, 'set distinto ⇒ alerta nueva');
    });
});

test('#5978 si se resuelve una dep, tampoco se hereda el silencio', () => {
    withSandbox(() => {
        const m = freshModule();
        m.mute({ issue: 6033, deps: [6032, 6041], authorizedBy: AUTH, appendMutation: fakeAudit([]) });
        assert.equal(m.isMuted(6033, [6032]), false);
    });
});

test('#5978 el silencio es por issue: no contagia a otro issue con las mismas deps', () => {
    withSandbox(() => {
        const m = freshModule();
        m.mute({ issue: 6033, deps: [6032], authorizedBy: AUTH, appendMutation: fakeAudit([]) });
        assert.equal(m.isMuted(6077, [6032]), false);
    });
});

// ─── Fail-open hacia el aviso (CA-8) ─────────────────────────────────────────

test('#5978 CA-8: estado CORRUPTO ⇒ isMuted false (la alerta se emite igual)', () => {
    withSandbox((dir) => {
        const m = freshModule();
        m.mute({ issue: 6033, deps: [6032], authorizedBy: AUTH, appendMutation: fakeAudit([]) });
        assert.equal(m.isMuted(6033, [6032]), true);

        fs.writeFileSync(path.join(dir, 'state', 'partial-pause-mutes.json'), '{ esto no es json');
        assert.equal(m.isMuted(6033, [6032]), false, 'JSON roto NUNCA silencia');
        assert.deepEqual(m.listMutes(), [], 'y no expone basura al banner');
    });
});

test('#5978 shapes inesperados del store tampoco silencian', () => {
    withSandbox((dir) => {
        const m = freshModule();
        const file = path.join(dir, 'state', 'partial-pause-mutes.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Un array, un null y un string donde se espera un mapa: los tres son
        // "no hay silencios", nunca "silenciá todo".
        for (const contenido of ['[]', 'null', '"6033:6032"', '123']) {
            fs.writeFileSync(file, contenido);
            assert.equal(m.isMuted(6033, [6032]), false, `contenido ${contenido}`);
        }
        // Entrada individual podrida: se descarta ella sola, no arrastra al resto.
        fs.writeFileSync(file, JSON.stringify({ '6033:6032': null, '6077:6099': { issue: 6077, deps: [6099] } }));
        assert.equal(m.isMuted(6033, [6032]), false, 'entrada podrida no silencia');
        assert.equal(m.isMuted(6077, [6099]), true, 'la entrada sana sigue valiendo');
    });
});

test('#5978 store ausente ⇒ nada silenciado', () => {
    withSandbox(() => {
        const m = freshModule();
        assert.equal(m.isMuted(6033, [6032]), false);
        assert.deepEqual(m.listMutes(), []);
    });
});

test('#5978 un caso sin deps no es firmable: no se puede silenciar "todo #N"', () => {
    withSandbox(() => {
        const m = freshModule();
        assert.equal(m.isMuted(6033, []), false);
        assert.equal(m.signatureOf(6033, []), null);
        const r = m.mute({ issue: 6033, deps: [], authorizedBy: AUTH, appendMutation: fakeAudit([]) });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'no_deps');
    });
});

test('#5978 sin audit no se muta (el CA exige rastro de cada silenciado)', () => {
    withSandbox((dir) => {
        const m = freshModule();
        const r = m.mute({
            issue: 6033, deps: [6032], authorizedBy: AUTH,
            appendMutation: () => { throw new Error('audit caído'); },
        });
        assert.equal(r.ok, false);
        assert.match(r.reason, /^audit_failed:/);
        assert.equal(fs.existsSync(path.join(dir, 'state', 'partial-pause-mutes.json')), false,
            'no se escribió nada');
        assert.equal(m.isMuted(6033, [6032]), false);
    });
});

// ─── Audit (CA-6) ────────────────────────────────────────────────────────────

test('#5978 CA-6: el audit lleva firma, origen y operatorRef, y NO muta allowlist', () => {
    withSandbox(() => {
        const m = freshModule();
        const audit = [];
        m.mute({
            issue: 6033, deps: [6041, 6032], authorizedBy: AUTH,
            operatorRef: '111222333', wave: 10, appendMutation: fakeAudit(audit),
        });
        assert.equal(audit.length, 1);
        const e = audit[0];
        assert.equal(e.authorizedBy, AUTH);
        assert.equal(e.extra.mute_signature, '6033:6032,6041');
        assert.equal(e.extra.mute_issue, 6033);
        assert.deepEqual(e.extra.mute_deps, [6032, 6041]);
        assert.equal(e.extra.mute_operator_ref, '111222333');
        assert.equal(e.extra.mute_action, 'mute-case');
        assert.match(e.justification, /111222333/);
        // El contrato del audit usa previous/current para la ALLOWLIST, y
        // `mute-case` no la toca: van vacíos e iguales, así el diff no puede
        // leerse como added/removed de issues.
        assert.deepEqual(e.previous, []);
        assert.deepEqual(e.current, []);
    });
});

// ─── unmute: la salida del estado silenciado ─────────────────────────────────

test('#5978 unmute reactiva el aviso y lo audita', () => {
    withSandbox(() => {
        const m = freshModule();
        m.mute({ issue: 6033, deps: [6032], authorizedBy: AUTH, appendMutation: fakeAudit([]) });
        const audit = [];
        const r = m.unmute('6033:6032', { authorizedBy: 'commander:leo', appendMutation: fakeAudit(audit) });
        assert.equal(r.ok, true);
        assert.equal(r.existed, true);
        assert.equal(m.isMuted(6033, [6032]), false, 'vuelve a alertar');
        assert.equal(audit[0].extra.mute_action, 'unmute-case');
        assert.equal(audit[0].action, 'clear');
    });
});

test('#5978 unmute de una firma inexistente es un no-op exitoso, no un error', () => {
    withSandbox(() => {
        const m = freshModule();
        const r = m.unmute('9999:1', { appendMutation: fakeAudit([]) });
        assert.equal(r.ok, true);
        assert.equal(r.existed, false);
    });
});

test('#5978 la reactivación sobrevive al restart (no vuelve el silencio viejo)', () => {
    withSandbox(() => {
        const a = freshModule();
        a.mute({ issue: 6033, deps: [6032], authorizedBy: AUTH, appendMutation: fakeAudit([]) });
        a.unmute('6033:6032', { appendMutation: fakeAudit([]) });
        const b = freshModule();
        assert.equal(b.isMuted(6033, [6032]), false);
    });
});

// ─── pruneStale ──────────────────────────────────────────────────────────────

test('#5978 pruneStale limpia los issues que salieron de la ola', () => {
    withSandbox(() => {
        const m = freshModule();
        m.mute({ issue: 6033, deps: [6032], authorizedBy: AUTH, appendMutation: fakeAudit([]) });
        m.mute({ issue: 6077, deps: [6099], authorizedBy: AUTH, appendMutation: fakeAudit([]) });
        const r = m.pruneStale({ allowedIssues: [6077, 6099] });
        assert.deepEqual(r.pruned, ['6033:6032']);
        assert.equal(m.isMuted(6033, [6032]), false, 'el issue fuera de la ola deja de estar silenciado');
        assert.equal(m.isMuted(6077, [6099]), true, 'el que sigue en la ola no se toca');
    });
});

test('#5978 pruneStale limpia los casos que ya no tienen deps faltantes', () => {
    withSandbox(() => {
        const m = freshModule();
        m.mute({ issue: 6033, deps: [6032], authorizedBy: AUTH, appendMutation: fakeAudit([]) });
        // El caso sigue en la ola, pero el barrido ya no lo reporta como trabado.
        const r = m.pruneStale({ allowedIssues: [6033], activeSignatures: [] });
        assert.deepEqual(r.pruned, ['6033:6032']);
        assert.equal(m.isMuted(6033, [6032]), false);
    });
});

test('#5978 pruneStale sin argumentos no barre nada (guard anti-borrado masivo)', () => {
    withSandbox(() => {
        const m = freshModule();
        m.mute({ issue: 6033, deps: [6032], authorizedBy: AUTH, appendMutation: fakeAudit([]) });
        const r = m.pruneStale({});
        assert.deepEqual(r.pruned, []);
        assert.equal(m.isMuted(6033, [6032]), true);
    });
});

// ─── decideAlert: la decisión REAL del barrido del Pulpo ─────────────────────
//
// Esta es la función que `pulpo.js` invoca en `brazoPartialPauseDeps`. Se testea
// la de producción, no una réplica: `pulpo.js` es un daemon que no se puede
// `require()` desde un test sin levantar el pipeline entero.

test('#5978 barrido: firma silenciada ⇒ NO se alerta y se loguea suppressed_by_mute', () => {
    const m = freshModule();
    const d = m.decideAlert({ isMutedSignature: true, lastAlertTs: 0, now: 1_000_000, cooldownMs: 1800_000 });
    assert.equal(d.alert, false, 'no se emite saliente de Telegram');
    assert.equal(d.action, 'suppressed_by_mute');
});

test('#5978 barrido: el silencio gana AUNQUE el cooldown ya haya vencido', () => {
    const m = freshModule();
    // Con cooldown vencido y sin silencio, esto alertaría. El silencio manda.
    const sinMute = m.decideAlert({ isMutedSignature: false, lastAlertTs: 0, now: 9_000_000, cooldownMs: 1800_000 });
    assert.equal(sinMute.action, 'alert_sent');
    const conMute = m.decideAlert({ isMutedSignature: true, lastAlertTs: 0, now: 9_000_000, cooldownMs: 1800_000 });
    assert.equal(conMute.action, 'suppressed_by_mute');
});

test('#5978 barrido: el cooldown SIGUE vivo como segunda barrera del caso no silenciado', () => {
    const m = freshModule();
    const d = m.decideAlert({ isMutedSignature: false, lastAlertTs: 1_000_000, now: 1_060_000, cooldownMs: 1800_000 });
    assert.equal(d.alert, false);
    assert.equal(d.action, 'detected_within_cooldown', 'el cooldown no se eliminó');
});

test('#5978 barrido: caso nuevo, no silenciado y fuera de cooldown ⇒ alerta', () => {
    const m = freshModule();
    const d = m.decideAlert({ isMutedSignature: false, lastAlertTs: 0, now: 1_000_000, cooldownMs: 500_000 });
    assert.equal(d.alert, true);
    assert.equal(d.action, 'alert_sent');
});
