// =============================================================================
// kernel-gate-copy-dedupe-4753.test.js — Issue #4753
//
// UX de los mensajes de gate del kernel (CA-5 / SEC-7) + dedupe conservador de
// notificaciones (CA-6 / SEC-6).
//
// Cubre:
//   CA-5   el copy explica qué/por qué/consecuencia en lenguaje llano y NO
//          contiene jerga interna (realign-allowlist, resoluble_reductivo,
//          notify-and-proceed, desync, partial-pause...).
//   SEC-7  los títulos derivados de GitHub pasan por safeMarkdownText (escapado).
//   CA-6/SEC-6  un aviso notify-and-proceed no se re-emite mientras el motivo no
//          cambie; la aparición de un issue ABIERTO nuevo invalida el silencio y
//          re-emite; una escalada wait-confirmation NUNCA se silencia.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/kernel-gate-copy-dedupe-4753.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const policy = require('../kernel-action-policy');
const { seedProductManifest } = require('./_test-helpers');

const JARGON = [
    'realign-allowlist', 'resoluble_reductivo', 'notify-and-proceed',
    'wait-confirmation', 'desync', 'partial-pause', 'EWAVES_ACTIVE_LOCKED',
];

function assertNoJargon(msg) {
    for (const j of JARGON) {
        assert.ok(!msg.includes(j), `el copy no debe contener jerga interna: "${j}" en:\n${msg}`);
    }
}

function withTmp(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-copy-4753-'));
    // #5172 — el tmpdir hace de raíz del pipeline (PIPELINE_DIR_OVERRIDE), así que
    // tiene que tener su `config.yaml`. Antes alcanzaba con un dir vacío porque
    // `loadGate3Config` se tragaba el ENOENT en un `catch { return {} }`; ahora la
    // config ilegible propaga error tipado y un dir vacío ya no es una raíz válida.
    // El contenido es mínimo a propósito: `gates.gate3` AUSENTE ⇒ defaults por
    // acción de `DEFAULT_POLICY`, que es justo lo que estos tests ejercitan.
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'gates: {}\n');
    seedProductManifest(dir);   // #5174 — la configuración vive partida: el otro lado también
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    try { return fn(dir); }
    finally {
        if (prev === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prev;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
}

// =============================================================================
// CA-5 — Copy en lenguaje llano (qué / por qué / consecuencia), sin jerga
// =============================================================================
test('CA-5: copy wait-confirmation explica qué/por qué/consecuencia y es fail-closed explícito', () => {
    const msg = policy.buildOperatorMessage({
        action: 'realign-allowlist',
        mode: 'wait-confirmation',
        reason: 'hay un issue abierto que podria descartar trabajo',
        issues: [{ number: 4720, estado: 'abierto' }],
    });
    assertNoJargon(msg);
    assert.ok(/Necesito tu OK/i.test(msg), 'pide OK en lenguaje llano');
    assert.ok(/Si aprobas/i.test(msg) && /Si rechazas/i.test(msg), 'explica consecuencia de cada camino');
    assert.ok(/Si no respondes/i.test(msg) && /auto-aprueba/i.test(msg), 'fail-closed explícito en el texto');
    assert.ok(msg.includes('#4720'), 'lista el issue afectado');
});

test('CA-5: copy notify-and-proceed es tranquilizador (ya está resuelto) y sin jerga', () => {
    const msg = policy.buildOperatorMessage({
        action: 'desync-autoresolve',
        mode: 'notify-and-proceed',
        reason: 'saque 4 cerrados que sobraban',
        issues: [4716, 4717, 4718, 4719].map((n) => ({ number: n, estado: 'cerrado' })),
    });
    assertNoJargon(msg);
    assert.ok(/no hace falta que hagas nada/i.test(msg), 'tono resuelto');
    assert.ok(/No frene el dispatch/i.test(msg), 'aclara que no frenó el dispatch');
    for (const n of [4716, 4717, 4718, 4719]) assert.ok(msg.includes(`#${n}`), `lista #${n}`);
});

test('CA-5: acción no mapeada NUNCA muestra la clave cruda', () => {
    const msg = policy.buildOperatorMessage({ action: 'reseed-wave', mode: 'wait-confirmation' });
    assertNoJargon(msg);
    assert.ok(!msg.includes('reseed-wave'), 'no muestra la clave cruda de la acción');
});

// =============================================================================
// SEC-7 — Sanitización de datos derivados de GitHub (safeMarkdownText)
// =============================================================================
test('SEC-7: el título de un issue con Markdown especial se escapa en el copy', () => {
    const msg = policy.buildOperatorMessage({
        action: 'desync-autoresolve',
        mode: 'notify-and-proceed',
        issues: [{ number: 4716, estado: 'cerrado', title: 'fix *bold* _under_ [x](y)' }],
    });
    // safeMarkdownText escapa `*` `_` `[` `]` `(` `)` → aparecen con backslash.
    assert.ok(msg.includes('\\*bold\\*'), 'los asteriscos del título quedan escapados');
    assert.ok(msg.includes('\\_under\\_'), 'los guiones bajos del título quedan escapados');
});

// =============================================================================
// CA-6 / SEC-6 — Dedupe conservador
// =============================================================================
test('CA-6: notify-and-proceed no se re-emite mientras el motivo (issues+estado) no cambie', () => {
    withTmp(() => {
        const issues = [4716, 4717].map((n) => ({ number: n, estado: 'cerrado' }));
        const first = policy.enforceActionPolicy('desync-autoresolve', {
            impact: 'medio', reason: 'poda', classification: 'reductivo-por-cierre', issues,
        });
        assert.equal(first.proceed, true);
        assert.ok(first.notification && first.notification.ok, 'la primera vez emite');
        assert.notEqual(first.notification.deduped, true, 'la primera vez NO está deduplicada');

        const second = policy.enforceActionPolicy('desync-autoresolve', {
            impact: 'medio', reason: 'poda', classification: 'reductivo-por-cierre', issues,
        });
        assert.equal(second.proceed, true, 'procede igual (dedupe no bloquea la acción)');
        assert.equal(second.notification.deduped, true, 'el segundo aviso idéntico se silencia');
    });
});

test('SEC-6: un issue ABIERTO nuevo invalida el silencio y re-emite', () => {
    withTmp(() => {
        const base = [{ number: 4716, estado: 'cerrado' }];
        const first = policy.enforceActionPolicy('desync-autoresolve', {
            classification: 'reductivo-por-cierre', issues: base,
        });
        assert.notEqual(first.notification.deduped, true);

        // Aparece un abierto nuevo en el conjunto → hash cambia → re-emite.
        const changed = [{ number: 4716, estado: 'cerrado' }, { number: 9999, estado: 'abierto' }];
        const second = policy.enforceActionPolicy('desync-autoresolve', {
            classification: 'reductivo-por-cierre', issues: changed,
        });
        assert.notEqual(second.notification.deduped, true, 'un abierto nuevo NUNCA hereda el silencio');
    });
});

test('SEC-6: una escalada wait-confirmation NUNCA se silencia (dedupe no aplica)', () => {
    withTmp(() => {
        const issues = [{ number: 4720, estado: 'abierto' }];
        const call = () => policy.enforceActionPolicy('realign-allowlist', {
            impact: 'alto', reason: 'realinear', classification: 'ambiguo', issues,
            // sin confirmerChatId → wait-confirmation sin confirmar
        });
        const a = call();
        const b = call();
        assert.notEqual(a.notification.deduped, true, 'wait-confirmation nunca se deduplica');
        assert.notEqual(b.notification.deduped, true, 'wait-confirmation nunca se deduplica (repetido)');
    });
});
