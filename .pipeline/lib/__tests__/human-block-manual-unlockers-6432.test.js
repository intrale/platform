// =============================================================================
// #6432 A-6 — T-A6 y T-A6b: quién limpia la degradación pegajosa del ledger.
//
// EL DEFECTO QUE ESTO CIERRA. D11 dice que `degraded: true` en el ledger de
// merge-race es irreversible POR VÍA AUTOMÁTICA, y que sólo una intervención
// humana manual lo limpia. El guard original era `unlocker === 'commander' ||
// startsWith('commander:')`, más angosto que D11: dejaba afuera los botones de
// la alerta de Telegram (`human-block-action:unblock` / `:priorizar`), que son
// el camino de destrabe MÁS USADO. Consecuencia: el operador apretaba
// "desbloquear", el `needs-human` se retiraba, el marker se reactivaba — y
// `classifyPrecondition` seguía devolviendo `human_judgment` para siempre.
// D11 quedaba pegajosa CONTRA el humano.
//
// T-A6  — matriz completa sobre `unblockIssue`, un caso por unlocker del enum.
//         El ledger va espiado: el test falla si `clearEntry` se llama de más
//         (una vía automática limpiando) o de menos (un humano sin efecto).
// T-A6b — end-to-end de D11 por el camino que fallaba: `degraded: true` →
//         `executeQuickAction({action:'unblock'})` → hint válido nuevo ⇒
//         `classifyPrecondition` devuelve `merge_checks_race`, NO
//         `human_judgment`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-manual-unlockers-'));
fs.mkdirSync(path.join(TMP_DIR, '.claude'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', 'trabajando'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', 'pendiente'), { recursive: true });
process.env.CLAUDE_PROJECT_DIR = TMP_DIR;
process.env.PIPELINE_REPO_ROOT = TMP_DIR;

delete require.cache[require.resolve('../traceability')];
delete require.cache[require.resolve('../merge-race-reclaim-ledger')];
delete require.cache[require.resolve('../human-block')];
require('../traceability');
const mergeRaceLedger = require('../merge-race-reclaim-ledger');
const hb = require('../human-block');

const SHA = 'c'.repeat(40);

function resetFs() {
    for (const state of ['pendiente', 'trabajando', 'listo', 'bloqueado-humano']) {
        const dir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', state);
        try {
            for (const f of fs.readdirSync(dir)) {
                try { fs.unlinkSync(path.join(dir, f)); } catch {}
            }
        } catch {}
    }
}

/** Bloquea el issue dejando el marker listo para ser destrabado. */
function bloquear(issue) {
    const src = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', 'trabajando', `${issue}.delivery`);
    fs.writeFileSync(src, `issue: ${issue}\n`);
    return hb.reportHumanBlock({
        issue, skill: 'delivery', phase: 'dev',
        reason: 'Intentos de reclaim agotados', question: 'Como continuar?',
    });
}

/**
 * Espía `clearEntry` en el módulo del ledger. `human-block` lo invoca como
 * `mergeRaceLedger.clearEntry(...)` sobre el objeto del módulo, así que pisar
 * la propiedad intercepta la llamada real sin tocar el código productivo.
 */
function espiarClearEntry() {
    const original = mergeRaceLedger.clearEntry;
    const calls = [];
    mergeRaceLedger.clearEntry = (issue, file) => { calls.push(Number(issue)); return original(issue, file); };
    return { calls, restore: () => { mergeRaceLedger.clearEntry = original; } };
}

// -----------------------------------------------------------------------------
// T-A6 — matriz por unlocker. La lista cubre el enum COMPLETO: si alguien suma
// un unlocker nuevo sin decidir de qué lado cae, el assert de sincronía se pone
// rojo.
// -----------------------------------------------------------------------------
const LIMPIAN = [
    'commander',
    'commander:telegram',
    'commander:dashboard',
    'human-block-action',
    'human-block-action:unblock',
    'human-block-action:priorizar',
];
const NO_LIMPIAN = [
    'github:label-removed',           // reconciliación, no decisión humana
    'human-block-action:devolver',    // va a dismiss: no reanuda el ciclo
    'brazo-desbloqueo:merge-race',    // automático (D11)
    'brazo-desbloqueo:precondicion',  // automático (D11)
    'auto-recheck',                   // automático (D11)
    'unlocker-inventado',             // fuera del enum ⇒ jamás limpia
];

for (const unlocker of LIMPIAN) {
    test(`#6432 T-A6: unlocker manual '${unlocker}' limpia el ledger`, () => {
        resetFs();
        const issue = 7100;
        const blocked = bloquear(issue);
        mergeRaceLedger.markDegraded({ issue, pr: 6500, head_sha: SHA });
        const spy = espiarClearEntry();
        try {
            const res = hb.unblockIssue({ issue, marker: blocked, unlocker });
            assert.equal(res.ok, true, 'el destrabe tiene que haber ocurrido de verdad');
            assert.deepEqual(spy.calls, [issue], 'clearEntry se invoca exactamente una vez, con el issue');
        } finally { spy.restore(); }
        assert.equal(mergeRaceLedger.getEntry(issue), null, 'la entrada degradada desaparece');
    });
}

for (const unlocker of NO_LIMPIAN) {
    test(`#6432 T-A6: unlocker no-manual '${unlocker}' NO limpia el ledger`, () => {
        resetFs();
        const issue = 7101;
        const blocked = bloquear(issue);
        mergeRaceLedger.markDegraded({ issue, pr: 6500, head_sha: SHA });
        const spy = espiarClearEntry();
        try {
            const res = hb.unblockIssue({ issue, marker: blocked, unlocker });
            assert.equal(res.ok, true, 'el destrabe ocurre igual: lo que no ocurre es la limpieza');
            assert.deepEqual(spy.calls, [], 'clearEntry NO debe invocarse');
        } finally { spy.restore(); }
        const entry = mergeRaceLedger.getEntry(issue);
        assert.equal(entry && entry.degraded, true, 'la degradación sigue pegajosa');
        mergeRaceLedger.clearEntry(issue);
    });
}

test('#6432 T-A6: la whitelist y el enum de unlockers no se desincronizan', () => {
    // Todo unlocker del enum tiene que estar clasificado explícitamente en una
    // de las dos listas. Sumar uno nuevo obliga a tomar la decisión acá.
    const clasificados = new Set([...LIMPIAN, ...NO_LIMPIAN]);
    for (const u of hb.UNLOCKER_ENUM) {
        assert.equal(clasificados.has(u), true, `${u} sin clasificar en T-A6`);
    }
    assert.deepEqual([...hb.MANUAL_UNLOCKERS].sort(), [...LIMPIAN].sort());
    // Ninguna vía automática se coló en la whitelist (D11).
    for (const u of ['github:label-removed', 'human-block-action:devolver',
        'brazo-desbloqueo:merge-race', 'brazo-desbloqueo:precondicion', 'auto-recheck']) {
        assert.equal(hb.MANUAL_UNLOCKERS.has(u), false, `${u} no puede limpiar el ledger`);
    }
});

test('#6432 T-A6: un destrabe FALLIDO no limpia aunque el unlocker sea manual', () => {
    // Sin marker no hay destrabe: `unblockIssue` sale por el `return` temprano y
    // la limpieza no puede ocurrir. Un `ok:false` que igual limpiara resetearía
    // el contador sin que nadie haya destrabado nada.
    resetFs();
    const issue = 7102;
    mergeRaceLedger.markDegraded({ issue, pr: 6500, head_sha: SHA });
    const spy = espiarClearEntry();
    try {
        const res = hb.unblockIssue({ issue, unlocker: 'commander:telegram' });
        assert.equal(res.ok, false);
        assert.deepEqual(spy.calls, []);
    } finally { spy.restore(); }
    assert.equal(mergeRaceLedger.getEntry(issue).degraded, true);
    mergeRaceLedger.clearEntry(issue);
});

// -----------------------------------------------------------------------------
// T-A6b — end-to-end de D11 por el botón de la alerta de Telegram.
// -----------------------------------------------------------------------------
test('#6432 T-A6b: degraded -> boton "desbloquear" de la alerta -> hint valido vuelve a aceptarse', () => {
    resetFs();
    const issue = 7103;
    bloquear(issue);
    mergeRaceLedger.markDegraded({ issue, pr: 6500, head_sha: SHA });

    const hint = [{ precondicion_merge_checks: { pr: 6500, head_sha: SHA } }];

    // Antes de la intervención humana: pegajoso, como manda D11.
    assert.deepEqual(
        hb.classifyPrecondition(hint, [], { issue }),
        { type: 'human_judgment' },
        'con degraded:true el hint válido NO puede acuñar la precondición',
    );

    // El camino real del operador: `executeQuickAction` con `action: 'unblock'`,
    // que baja a `reactivateAllBlocked` → `unblockIssue` con el unlocker
    // `human-block-action:unblock`. Las órdenes a GitHub se interceptan: este
    // test no encola nada.
    const encoladas = [];
    const res = hb.executeQuickAction({
        issue, action: 'unblock',
        deps: { enqueueGithub: (kind, payload) => encoladas.push({ kind, payload }) },
    });

    assert.equal(res.ok, true);
    assert.equal(res.reactivated, 1, 'el marker se reactivó de verdad');
    assert.ok(encoladas.some(o => o.kind === 'remove-label'), 'el needs-human se retira');
    assert.equal(mergeRaceLedger.getEntry(issue), null, 'la intervención humana limpió el ledger');

    // Después: el mismo hint válido vuelve a acuñar la precondición.
    assert.deepEqual(
        hb.classifyPrecondition(hint, [], { issue }),
        { type: 'merge_checks_race', pr: 6500, head_sha: SHA },
        'tras el destrabe manual, D11 deja de forzar human_judgment',
    );
});

test('#6432 T-A6b: el boton "priorizar" tambien reanuda el ciclo de reclaim', () => {
    resetFs();
    const issue = 7104;
    bloquear(issue);
    mergeRaceLedger.markDegraded({ issue, pr: 6501, head_sha: SHA });

    const res = hb.executeQuickAction({
        issue, action: 'priorizar',
        deps: { enqueueGithub: () => {}, setPriorityLabel: () => {} },
    });

    assert.equal(res.ok, true);
    assert.equal(mergeRaceLedger.getEntry(issue), null);
    assert.deepEqual(
        hb.classifyPrecondition([{ precondicion_merge_checks: { pr: 6501, head_sha: SHA } }], [], { issue }),
        { type: 'merge_checks_race', pr: 6501, head_sha: SHA },
    );
});

test('#6432 T-A6b: "devolver a definicion" NO reanuda el ciclo (borde cerrado)', () => {
    resetFs();
    const issue = 7105;
    bloquear(issue);
    mergeRaceLedger.markDegraded({ issue, pr: 6502, head_sha: SHA });

    const res = hb.executeQuickAction({
        issue, action: 'devolver-definicion',
        deps: { enqueueGithub: () => {} },
    });

    assert.equal(res.ok, true);
    assert.equal(res.dismissed, true, 'el marker se descarta, no se reactiva');
    const entry = mergeRaceLedger.getEntry(issue);
    assert.equal(entry && entry.degraded, true, 'descartar no resetea el contador de reclaim');
    mergeRaceLedger.clearEntry(issue);
});
