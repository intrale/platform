// =============================================================================
// Tests worktree-guard-policy.js — política pura del guard de worktree (#5421).
//
// Cobertura de CA:
//   CA-1: `branch-origin-unverified` NO es elegible.
//   CA-2: `worktree-path-exists` y `worktree-path-exists-without-git-entry` SÍ,
//         con y sin sufijo `:<detalle>`.
//   CA-3: `fetch-failed` elegible SÓLO con `branchOriginVerified:true`.
//   CA-4: motivo desconocido NO elegible (default cerrado).
//   CA-6: el log nombra la operación intentada y la acción que destraba.
//   CA-7: `stderr` de gh/git con path absoluto sale redactado.
//   CA-8: wording por causa real (email vs "rama ajena").
//   CA-9: línea de skills afectados.
//   CA-12: el email no deja metacaracteres Markdown en el texto entregado.
//   CA-13: emails hostiles (phishing con link embebido, silenciador con
//          backtick suelto) no producen link clickeable ni paridad impar de
//          backticks; el control benigno de CA-8 sigue verde.
//   D3:   `operation` NO altera el veredicto.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    guardExceptionEligible,
    resolveOperation,
    buildAbortLogLine,
    buildOperatorQuestion,
    buildAffectedSkillsLine,
    sanitizeOperatorEmail,
    normalizarMotivo,
    OPERATIONS,
} = require('../worktree-guard-policy');

// ---- normalizarMotivo --------------------------------------------------------

test('normalizarMotivo — corta en el PRIMER `:` (el detalle puede ser un path Windows con su propio `:`)', () => {
    assert.equal(
        normalizarMotivo('worktree-path-exists-without-git-entry:C:\\Workspaces\\Intrale\\platform.agent-1123-po'),
        'worktree-path-exists-without-git-entry',
    );
});

test('normalizarMotivo — sin sufijo devuelve el motivo tal cual', () => {
    assert.equal(normalizarMotivo('fetch-failed'), 'fetch-failed');
});

test('normalizarMotivo — null/undefined/vacío → string vacío (no explota)', () => {
    assert.equal(normalizarMotivo(null), '');
    assert.equal(normalizarMotivo(undefined), '');
    assert.equal(normalizarMotivo('   '), '');
});

// ---- CA-1: branch-origin-unverified nunca elegible ---------------------------

test('CA-1 — `branch-origin-unverified` NO es elegible (falla de confianza, no de copia)', () => {
    const r = guardExceptionEligible('branch-origin-unverified:agent/1123-*', {
        operation: OPERATIONS.SPAWN_AGENTE,
        branchOriginVerified: false,
    });
    assert.equal(r.eligible, false);
    assert.equal(r.motivoNormalizado, 'branch-origin-unverified');
});

test('CA-1 — `branch-origin-unverified` sigue NO elegible aunque llegue branchOriginVerified:true', () => {
    // Combinación imposible en la práctica; el test fija que la allowlist manda
    // sobre el flag, no al revés.
    const r = guardExceptionEligible('branch-origin-unverified:agent/1123-*', { branchOriginVerified: true });
    assert.equal(r.eligible, false);
});

test('CA-1 — la exclusión es por igualdad EXACTA: un motivo nuevo con el mismo prefijo tampoco cuela', () => {
    // La regex vieja (`/^branch-origin-unverified/`) habría matcheado esto por
    // prefijo sin que nadie lo revisara. Acá cae al default cerrado.
    const r = guardExceptionEligible('branch-origin-unverified-foo:detalle', { branchOriginVerified: true });
    assert.equal(r.eligible, false);
    assert.equal(r.motivoNormalizado, 'branch-origin-unverified-foo');
});

test('CA-1 — `invalid-input` y `remote-branch-missing` tampoco son elegibles', () => {
    assert.equal(guardExceptionEligible('invalid-input:INVALID_ISSUE', {}).eligible, false);
    assert.equal(guardExceptionEligible('remote-branch-missing:agent/1123-*', {}).eligible, false);
});

// ---- CA-2: worktree-path-exists* elegibles -----------------------------------

test('CA-2 — `worktree-path-exists` es elegible, con y sin sufijo', () => {
    assert.equal(guardExceptionEligible('worktree-path-exists', {}).eligible, true);
    assert.equal(
        guardExceptionEligible('worktree-path-exists:C:\\Workspaces\\Intrale\\platform.agent-1123-po', {}).eligible,
        true,
    );
});

test('CA-2 — `worktree-path-exists-without-git-entry` es elegible, con y sin sufijo', () => {
    assert.equal(guardExceptionEligible('worktree-path-exists-without-git-entry', {}).eligible, true);
    assert.equal(
        guardExceptionEligible(
            'worktree-path-exists-without-git-entry:C:\\Workspaces\\Intrale\\platform.agent-1123-po',
            {},
        ).eligible,
        true,
    );
});

test('CA-2 — los path-exists son elegibles sin depender de branchOriginVerified', () => {
    // Se llega a estos motivos sólo con la rama remota ya verificada, así que
    // el flag no debe poder degradar el veredicto.
    for (const v of [true, false, null, undefined]) {
        assert.equal(
            guardExceptionEligible('worktree-path-exists-without-git-entry:/tmp/x', { branchOriginVerified: v }).eligible,
            true,
            `branchOriginVerified=${String(v)}`,
        );
    }
});

// ---- CA-3: transitorios sólo con procedencia verificada ----------------------

test('CA-3 — `fetch-failed` es elegible SÓLO con branchOriginVerified:true', () => {
    assert.equal(guardExceptionEligible('fetch-failed:timeout', { branchOriginVerified: true }).eligible, true);
    assert.equal(guardExceptionEligible('fetch-failed:timeout', { branchOriginVerified: false }).eligible, false);
    assert.equal(guardExceptionEligible('fetch-failed:timeout', { branchOriginVerified: null }).eligible, false);
    assert.equal(guardExceptionEligible('fetch-failed:timeout', {}).eligible, false);
});

test('CA-3 — `ls-remote-failed` sigue la misma regla que `fetch-failed`', () => {
    assert.equal(guardExceptionEligible('ls-remote-failed:ETIMEDOUT', { branchOriginVerified: true }).eligible, true);
    assert.equal(guardExceptionEligible('ls-remote-failed:ETIMEDOUT', { branchOriginVerified: false }).eligible, false);
    assert.equal(guardExceptionEligible('ls-remote-failed:ETIMEDOUT', { branchOriginVerified: null }).eligible, false);
});

test('CA-3 — un `branchOriginVerified` truthy pero no booleano NO alcanza (comparación estricta)', () => {
    assert.equal(guardExceptionEligible('fetch-failed', { branchOriginVerified: 'true' }).eligible, false);
    assert.equal(guardExceptionEligible('fetch-failed', { branchOriginVerified: 1 }).eligible, false);
});

// ---- CA-4: default cerrado ---------------------------------------------------

test('CA-4 — motivo desconocido NO es elegible (default cerrado)', () => {
    const r = guardExceptionEligible('motivo-que-nadie-vio-nunca:detalle', { branchOriginVerified: true });
    assert.equal(r.eligible, false);
    assert.match(r.causa, /no reconocido/i);
});

test('CA-4 — motivo vacío / nulo NO es elegible', () => {
    assert.equal(guardExceptionEligible('', {}).eligible, false);
    assert.equal(guardExceptionEligible(null, {}).eligible, false);
    assert.equal(guardExceptionEligible(undefined, {}).eligible, false);
});

test('CA-4 — `worktree-add-failed` (transitorio real del resolver) no está en la allowlist', () => {
    assert.equal(guardExceptionEligible('worktree-add-failed:fatal', { branchOriginVerified: true }).eligible, false);
});

// ---- D3: operation es metadato, no decisión ----------------------------------

test('D3 — el mismo motivo con `operation` distinta da el mismo veredicto', () => {
    const motivos = [
        'worktree-path-exists-without-git-entry:/tmp/x',
        'branch-origin-unverified:agent/1-*',
        'fetch-failed:x',
        'desconocido:x',
    ];
    for (const m of motivos) {
        const veredictos = Object.values(OPERATIONS).map(
            (op) => guardExceptionEligible(m, { operation: op, branchOriginVerified: true }).eligible,
        );
        assert.equal(new Set(veredictos).size, 1, `motivo ${m} cambió de veredicto según operation`);
    }
});

// ---- resolveOperation --------------------------------------------------------

test('resolveOperation — fase `entrega` → merge server-side', () => {
    assert.equal(resolveOperation({ fase: 'entrega', skill: 'delivery' }), OPERATIONS.MERGE_SERVER_SIDE);
    assert.equal(resolveOperation({ fase: 'entrega', skill: 'otro' }), OPERATIONS.MERGE_SERVER_SIDE);
});

test('resolveOperation — skill `delivery` en otra fase también es merge server-side', () => {
    assert.equal(resolveOperation({ fase: 'dev', skill: 'delivery' }), OPERATIONS.MERGE_SERVER_SIDE);
});

test('resolveOperation — el resto es spawn de agente', () => {
    assert.equal(resolveOperation({ fase: 'dev', skill: 'pipeline-dev' }), OPERATIONS.SPAWN_AGENTE);
    assert.equal(resolveOperation({}), OPERATIONS.SPAWN_AGENTE);
    assert.equal(resolveOperation(), OPERATIONS.SPAWN_AGENTE);
});

// ---- CA-6: log accionable ----------------------------------------------------

test('CA-6 — el log distingue el merge server-side del spawn de agente', () => {
    const merge = buildAbortLogLine({
        issue: 1123, fase: 'entrega', skill: 'delivery',
        reasonStr: 'worktree-path-exists-without-git-entry:/tmp/x',
        operation: OPERATIONS.MERGE_SERVER_SIDE,
        intentos: 1, cap: 3, eligible: true, escalar: false,
    });
    const spawn = buildAbortLogLine({
        issue: 1123, fase: 'dev', skill: 'pipeline-dev',
        reasonStr: 'worktree-path-exists-without-git-entry:/tmp/x',
        operation: OPERATIONS.SPAWN_AGENTE,
        intentos: 1, cap: 3, eligible: true, escalar: false,
    });
    assert.match(merge, /merge server-side/);
    assert.doesNotMatch(merge, /spawn de agente/);
    assert.match(spawn, /spawn de agente/);
    assert.doesNotMatch(spawn, /merge server-side/);
});

test('CA-6 / Gherkin 2 — commit/push sobre rama no verificada: el log lo nombra y no lo confunde con el merge', () => {
    const linea = buildAbortLogLine({
        issue: 1123, fase: 'entrega', skill: 'delivery',
        reasonStr: 'branch-origin-unverified:agent/1123-*',
        operation: OPERATIONS.COMMIT_PUSH,
        intentos: 1, cap: 3, eligible: false, escalar: true,
    });
    assert.match(linea, /commit\/push sobre la rama del dev/);
    assert.doesNotMatch(linea, /merge server-side/);
    // "se intentaba commitear en una rama no verificada": operación + causa.
    assert.match(linea, /no se pudo verificar la procedencia de la rama remota/);
});

test('CA-6 — el log nombra la causa en lenguaje de operador y la acción que destraba', () => {
    const linea = buildAbortLogLine({
        issue: 1123, fase: 'dev', skill: 'po',
        reasonStr: 'worktree-path-exists-without-git-entry:/tmp/x',
        operation: OPERATIONS.SPAWN_AGENTE,
        intentos: 2, cap: 3, eligible: true, escalar: false,
    });
    assert.match(linea, /Causa:/);
    assert.match(linea, /Acción que destraba:/);
    assert.match(linea, /huérfano/i);
    assert.match(linea, /intentos=2\/3/);
    assert.match(linea, /escala_humano=no/);
    assert.match(linea, /excepcion_guard=si/);
});

test('CA-6 — un motivo no elegible reporta escala_humano=si y su propia acción', () => {
    const linea = buildAbortLogLine({
        issue: 77, fase: 'dev', skill: 'po',
        reasonStr: 'branch-origin-unverified:agent/77-*',
        operation: OPERATIONS.SPAWN_AGENTE,
        intentos: 1, cap: 3, eligible: false, escalar: true,
    });
    assert.match(linea, /excepcion_guard=no/);
    assert.match(linea, /escala_humano=si/);
    assert.match(linea, /worktree_provenance\.committers/);
});

test('CA-6 — una `operation` fuera del enum cae al default en vez de viajar cruda al log', () => {
    const linea = buildAbortLogLine({
        issue: 1, fase: 'dev', skill: 'po',
        reasonStr: 'fetch-failed',
        operation: 'operacion-inventada',
        intentos: 1, cap: 3, eligible: false, escalar: true,
    });
    assert.doesNotMatch(linea, /operacion-inventada/);
    assert.match(linea, /spawn de agente/);
});

// ---- CA-7: redacción ---------------------------------------------------------

test('CA-7 — un path absoluto Windows en el reason sale redactado del log', () => {
    const linea = buildAbortLogLine({
        issue: 1123, fase: 'dev', skill: 'po',
        reasonStr: 'worktree-path-exists-without-git-entry:D:\\Secretos\\Intrale\\platform.agent-1123-po',
        operation: OPERATIONS.SPAWN_AGENTE,
        intentos: 1, cap: 3, eligible: true, escalar: false,
    });
    assert.doesNotMatch(linea, /D:\\Secretos/);
    assert.match(linea, /<ABS_PATH>|<PIPELINE_ROOT>/);
});

test('CA-7 — el stderr de gh/git pasa por redact y queda acotado a una línea', () => {
    const linea = buildAbortLogLine({
        issue: 1123, fase: 'entrega', skill: 'delivery',
        reasonStr: 'fetch-failed:boom',
        operation: OPERATIONS.MERGE_SERVER_SIDE,
        intentos: 1, cap: 3, eligible: false, escalar: true,
        stderr: 'fatal: could not read\nfrom D:\\Secretos\\repo\nremote: https://user:hunter2@github.com/x.git',
    });
    assert.doesNotMatch(linea, /D:\\Secretos/);
    assert.doesNotMatch(linea, /hunter2/);
    assert.equal(linea.includes('\n'), false, 'el stderr multilínea debe quedar aplanado');
});

test('CA-7 — un token de Telegram en el stderr no llega al log', () => {
    const linea = buildAbortLogLine({
        issue: 1, fase: 'dev', skill: 'po',
        reasonStr: 'fetch-failed',
        operation: OPERATIONS.SPAWN_AGENTE,
        intentos: 1, cap: 3, eligible: false, escalar: true,
        stderr: 'https://api.telegram.org/bot1234567890:AAFakeTokenAAAAAAAAAAAAAAAAAAAAAAAAA/sendMessage',
    });
    assert.doesNotMatch(linea, /AAFakeToken/);
});

// ---- CA-8: wording por causa real -------------------------------------------

test('CA-8 — committer legítimo fuera de allowlist: nombra el email y NO dice "rama ajena"', () => {
    const q = buildOperatorQuestion({
        issue: 1123,
        reasonStr: 'branch-origin-unverified:agent/1123-*',
        branchOriginVerified: false,
        unverifiedAuthors: ['android-dev-agent@intrale'],
    });
    assert.match(q, /android-dev-agent@intrale/);
    assert.doesNotMatch(q, /rama ajena/i);
    assert.doesNotMatch(q, /sospechos/i);
    assert.match(q, /worktree_provenance\.committers/);
    assert.match(q, /config\.yaml/);
});

test('CA-8 — varios committers no reconocidos: los lista a todos, sigue sin "rama ajena"', () => {
    const q = buildOperatorQuestion({
        issue: 1123,
        branchOriginVerified: false,
        unverifiedAuthors: ['a@intrale', 'b@intrale'],
    });
    assert.match(q, /a@intrale/);
    assert.match(q, /b@intrale/);
    assert.doesNotMatch(q, /rama ajena/i);
});

test('CA-8 — sin committers identificados se CONSERVA el lenguaje de procedencia sospechosa', () => {
    const q = buildOperatorQuestion({
        issue: 1123,
        reasonStr: 'branch-origin-unverified:agent/1123-*',
        branchOriginVerified: false,
        unverifiedAuthors: [],
    });
    assert.match(q, /rama ajena/i);
    assert.match(q, /inspeccionar el autor/i);
});

test('CA-8 — `unverifiedAuthors` ausente o no-array cae al texto de procedencia', () => {
    for (const authors of [undefined, null, 'a@b', {}]) {
        const q = buildOperatorQuestion({ issue: 9, branchOriginVerified: false, unverifiedAuthors: authors });
        assert.match(q, /rama ajena/i, `authors=${JSON.stringify(authors)}`);
    }
});

test('CA-8 — entradas vacías/no-string en `unverifiedAuthors` no simulan un email', () => {
    const q = buildOperatorQuestion({
        issue: 9, branchOriginVerified: false, unverifiedAuthors: ['', '   ', null, 42],
    });
    assert.match(q, /rama ajena/i);
});

test('CA-8 — procedencia verificada (o desconocida) usa el texto genérico', () => {
    for (const v of [true, null, undefined]) {
        const q = buildOperatorQuestion({
            issue: 1123,
            reasonStr: 'worktree-path-exists-without-git-entry:/tmp/x',
            branchOriginVerified: v,
            unverifiedAuthors: ['a@intrale'],
        });
        assert.doesNotMatch(q, /rama ajena/i, `branchOriginVerified=${String(v)}`);
        assert.match(q, /verificar la rama del dev/i);
    }
});

test('CA-8 — el texto de operador también pasa por redact', () => {
    const q = buildOperatorQuestion({
        issue: 1,
        reasonStr: 'worktree-path-exists:D:\\Secretos\\platform.agent-1-po',
        branchOriginVerified: true,
    });
    assert.doesNotMatch(q, /D:\\Secretos/);
});

// ---- CA-9: skills afectados --------------------------------------------------

test('CA-9 — lista los skills afectados en una sola línea', () => {
    assert.equal(buildAffectedSkillsLine(['po', 'review', 'ux']), 'Skills afectados: po, review, ux');
});

test('CA-9 — deduplica y filtra basura; lista vacía → string vacío', () => {
    assert.equal(buildAffectedSkillsLine(['po', 'po', ' review ', '', null, 7]), 'Skills afectados: po, review');
    assert.equal(buildAffectedSkillsLine([]), '');
    assert.equal(buildAffectedSkillsLine(null), '');
    assert.equal(buildAffectedSkillsLine(undefined), '');
});

// ---- CA-12 / CA-13: saneamiento del email hostil -----------------------------
//
// Contexto del hallazgo (ciclo 4/5): el email llega del `git log` de una rama
// REMOTA arbitraria y se interpolaba textual entre backticks en un mensaje con
// `parse_mode: 'Markdown'`. Dos ataques confirmados por `qa` y `guru`:
//   - PHISHING: `a`[Actualizar credenciales](https://evil.tld/phish)`b@x.io`
//     cerraba el code span y entregaba un link clickeable al operador.
//   - SILENCIADOR: `a`b@x.io` dejaba paridad IMPAR de backticks ⇒ Telegram
//     responde HTTP 400 y la alerta de needs-human se pierde entera.

const EMAIL_PHISHING = 'a`[Actualizar credenciales](https://evil.tld/phish)`b@x.io';
const EMAIL_SILENCIADOR = 'a`b@x.io';
const EMAIL_BENIGNO = 'backend-dev-agent@intrale';
const EMAIL_BOT_GITHUB = '41898282+github-actions[bot]@users.noreply.github.com';

/** Cuenta backticks del texto. Impar ⇒ Telegram 400 ⇒ alerta perdida. */
function contarBackticks(txt) {
    return (String(txt).match(/`/g) || []).length;
}

/** ¿Hay un `[texto](url)` clickeable en el texto entregado? */
function tieneLinkClickeable(txt) {
    return /\[[^\]\n]*\]\([^)\n]*\)/.test(String(txt));
}

test('CA-12 — sanitizeOperatorEmail neutraliza los metacaracteres del Markdown legacy', () => {
    assert.equal(sanitizeOperatorEmail('a`b@x.io'), 'a?b@x.io');
    assert.equal(sanitizeOperatorEmail('a_b*c@x.io'), 'a?b?c@x.io');
    assert.equal(sanitizeOperatorEmail('a[b](c)@x.io'), 'a?b??c?@x.io');
    // El benigno no se toca: `.`, `-` y `@` no son metacaracteres del legacy.
    assert.equal(sanitizeOperatorEmail(EMAIL_BENIGNO), EMAIL_BENIGNO);
    // Robustez de entrada: no explota con no-strings.
    assert.equal(sanitizeOperatorEmail(null), '');
    assert.equal(sanitizeOperatorEmail(undefined), '');
});

test('CA-13 — email de PHISHING: sin link clickeable y con paridad par de backticks', () => {
    const q = buildOperatorQuestion({
        issue: 5421,
        reasonStr: 'branch-origin-unverified:agent/5421-*',
        branchOriginVerified: false,
        unverifiedAuthors: [EMAIL_PHISHING],
    });
    assert.equal(tieneLinkClickeable(q), false, 'el phishing no debe quedar clickeable');
    assert.equal(contarBackticks(q) % 2, 0, 'paridad impar ⇒ Telegram 400 ⇒ alerta perdida');
    assert.doesNotMatch(q, /https:\/\/evil\.tld/, 'la URL del atacante no debe sobrevivir como link');
    // Sigue siendo el wording de CONFIGURACIÓN de CA-8, no el de "rama ajena".
    assert.doesNotMatch(q, /rama ajena/i);
    assert.match(q, /allowlist/i);
});

test('CA-13 — email SILENCIADOR: el backtick suelto no rompe la paridad', () => {
    const q = buildOperatorQuestion({
        issue: 5421,
        reasonStr: 'branch-origin-unverified:agent/5421-*',
        branchOriginVerified: false,
        unverifiedAuthors: [EMAIL_SILENCIADOR],
    });
    assert.equal(contarBackticks(q) % 2, 0);
    assert.equal(tieneLinkClickeable(q), false);
    // El committer sigue siendo identificable pese al saneamiento.
    assert.match(q, /a\?b@x\.io/);
});

test('CA-13 — control benigno de CA-8: el email legítimo se sigue mostrando textual', () => {
    const q = buildOperatorQuestion({
        issue: 5421,
        reasonStr: 'branch-origin-unverified:agent/5421-*',
        branchOriginVerified: false,
        unverifiedAuthors: [EMAIL_BENIGNO],
    });
    assert.match(q, new RegExp(EMAIL_BENIGNO.replace('.', '\.')));
    assert.equal(contarBackticks(q) % 2, 0);
    assert.equal(tieneLinkClickeable(q), false);
    assert.doesNotMatch(q, /rama ajena/i);
});

test('CA-13 — el bot de GitHub NO se descarta y conserva el wording de configuración (anti-regresión CA-8)', () => {
    // `guru` detectó que la regex propuesta por el rechazo descartaba este
    // email legítimo (está en PIPELINE_COMMITTER_ALLOWLIST). Descartarlo dejaría
    // `unverifiedAuthors` vacío y el texto caería a "posible rama ajena", que es
    // exactamente el wording que CA-8 vino a eliminar.
    const q = buildOperatorQuestion({
        issue: 5421,
        reasonStr: 'branch-origin-unverified:agent/5421-*',
        branchOriginVerified: false,
        unverifiedAuthors: [EMAIL_BOT_GITHUB],
    });
    assert.doesNotMatch(q, /rama ajena/i, 'no debe degradar al wording de procedencia sospechosa');
    assert.match(q, /allowlist/i);
    // Identificable pese a que `[` y `]` se neutralizan.
    assert.match(q, /41898282\+github-actions\?bot\?@users\.noreply\.github\.com/);
    assert.equal(contarBackticks(q) % 2, 0);
    assert.equal(tieneLinkClickeable(q), false);
});

test('CA-12 — varios autores hostiles a la vez tampoco rompen el markup', () => {
    const q = buildOperatorQuestion({
        issue: 5421,
        reasonStr: 'branch-origin-unverified:agent/5421-*',
        branchOriginVerified: false,
        unverifiedAuthors: [EMAIL_PHISHING, EMAIL_SILENCIADOR, EMAIL_BENIGNO],
    });
    assert.equal(contarBackticks(q) % 2, 0);
    assert.equal(tieneLinkClickeable(q), false);
    assert.match(q, /committers/, 'con más de uno el texto va en plural');
});

test('CA-12 — un autor que el saneamiento deja vacío se descarta (default cerrado)', () => {
    // Sólo metacaracteres ⇒ tras sanear queda '' ⇒ no hay autor nombrable ⇒
    // corresponde el lenguaje de procedencia sospechosa, no un texto roto.
    const q = buildOperatorQuestion({
        issue: 5421,
        reasonStr: 'branch-origin-unverified:agent/5421-*',
        branchOriginVerified: false,
        unverifiedAuthors: ['```'],
    });
    assert.match(q, /posible rama ajena/i);
    assert.equal(contarBackticks(q) % 2, 0);
});

// ---- #5421 — TEXTO PLANO: el aviso crítico no depende del formato -----------
//
// Cambio de enfoque decidido por el operador (2026-08-06) después de seis ciclos
// de QA parcheando el escapado: el aviso de needs-human viaja SIN `parse_mode`.
//
// Lo que cerró el agujero no fue escapar mejor, fue dejar de depender del
// formato. El barrido del ciclo 6 mostró el modo de falla que el escapado no
// podía cubrir: el `slice(280)` del renderer corta por POSICIÓN y partía el code
// span al medio, dejando paridad impar de backticks con emails perfectamente
// VÁLIDOS y benignos (11 de 15 largos probados rompían, incluido el control
// `backend-dev-agent@intrale` en la línea del listado). Un corte posicional no
// se puede escapar.
//
// El invariante que fijan estos tests: el texto del operador NO LLEVA MARKUP
// DECORATIVO. Concretamente, cero backticks — el code span era la decoración que
// el truncado partía, y un backtick nunca es contenido legítimo acá.
//
// Ojo con el matiz, que es la médula del cambio de enfoque: el texto SÍ contiene
// `_` y `*` (`worktree_provenance.committers`, `agent/5421-*`) porque son parte
// del contenido real que el operador necesita leer para actuar. Bajo Markdown eso
// es munición viva; en texto plano es texto. No se puede "sanear" un nombre de
// config ni un glob de rama sin arruinar el mensaje: por eso el fix correcto era
// cambiar el transporte, no seguir escapando el contenido. El test
// `contenido con metacaracteres` de más abajo fija exactamente esa expectativa.

/** Decoración de code span: el markup que este texto ya NO debe emitir. */
const CODE_SPAN = /`/;

test('#5421 — buildOperatorQuestion no emite decoración de markup en NINGUNA de sus 3 ramas', () => {
    const casos = [
        ['configuración (committer no reconocido)', {
            issue: 5421, reasonStr: 'branch-origin-unverified:agent/5421-*',
            branchOriginVerified: false, unverifiedAuthors: [EMAIL_BENIGNO],
        }],
        ['procedencia sospechosa (sin committers)', {
            issue: 5421, reasonStr: 'branch-origin-unverified:agent/5421-*',
            branchOriginVerified: false, unverifiedAuthors: [],
        }],
        ['genérico (procedencia verificada)', {
            issue: 5421, reasonStr: 'worktree-path-exists-without-git-entry:/tmp/x',
            branchOriginVerified: true, unverifiedAuthors: [],
        }],
    ];
    for (const [etiqueta, args] of casos) {
        const q = buildOperatorQuestion(args);
        assert.doesNotMatch(q, CODE_SPAN, `rama "${etiqueta}" emitió un code span: ${q}`);
        assert.equal(tieneLinkClickeable(q), false, `rama "${etiqueta}" armó un link`);
    }
});

test('#5421 — el texto lleva contenido con metacaracteres y por eso EXIGE envío plano', () => {
    // Este test documenta la razón del cambio de transporte. El mensaje contiene
    // un `_` (nombre de la clave de config) y un `*` (glob de la rama) que son
    // información que el operador necesita. Enviado como Markdown, ese contenido
    // desbalancea el parseo y Telegram descarta el aviso con un HTTP 400; en
    // plano se lee tal cual. No es un defecto a sanear: es el motivo por el que
    // el aviso crítico no puede viajar con `parse_mode`.
    const q = buildOperatorQuestion({
        issue: 5421,
        reasonStr: 'branch-origin-unverified:agent/5421-*',
        branchOriginVerified: false,
        unverifiedAuthors: [EMAIL_BENIGNO],
    });
    assert.match(q, /worktree_provenance\.committers/, 'el `_` del nombre de config es contenido, no markup');
    assert.match(q, /agent\/5421-\*/, 'el `*` del glob de rama es contenido, no markup');
    // Paridad IMPAR por tipo de metacarácter, justamente: bajo Markdown cada uno
    // de estos abre un énfasis que nunca cierra ⇒ HTTP 400 ⇒ aviso perdido. En
    // plano se leen literales y no hay nada que balancear.
    assert.equal((q.match(/_/g) || []).length % 2, 1, 'un `_` suelto: inofensivo en plano, fatal en Markdown');
    assert.equal((q.match(/\*/g) || []).length % 2, 1, 'un `*` suelto: inofensivo en plano, fatal en Markdown');
    // Lo que NO puede haber es decoración nuestra.
    assert.doesNotMatch(q, CODE_SPAN);
});

test('#5421 — el wording de configuración sigue completo sin backticks (CA-8 intacto)', () => {
    const q = buildOperatorQuestion({
        issue: 5421,
        reasonStr: 'branch-origin-unverified:agent/5421-*',
        branchOriginVerified: false,
        unverifiedAuthors: [EMAIL_BENIGNO],
    });
    // El operador tiene que poder actuar: email + allowlist + archivo + acción.
    assert.match(q, new RegExp(EMAIL_BENIGNO.replace(/\./g, '\\.')));
    assert.match(q, /worktree_provenance\.committers/);
    assert.match(q, /\.pipeline\/config\.yaml/);
    assert.match(q, /re-encolá/i);
    assert.doesNotMatch(q, /rama ajena/i);
    // Los valores se delimitan con comillas dobles, legibles en plano.
    assert.match(q, /"worktree_provenance\.committers"/);
});

test('#5421 — el email hostil no aporta decoración ni URL auto-linkificable', () => {
    // El envío plano neutraliza el markup inyectado; el saneamiento sigue vivo
    // porque Telegram AUTO-LINKIFICA URLs planas incluso sin `parse_mode`.
    for (const email of [EMAIL_PHISHING, EMAIL_SILENCIADOR, EMAIL_BOT_GITHUB]) {
        const q = buildOperatorQuestion({
            issue: 5421,
            reasonStr: 'branch-origin-unverified:agent/5421-*',
            branchOriginVerified: false,
            unverifiedAuthors: [email],
        });
        assert.doesNotMatch(q, CODE_SPAN, `el email ${email} filtró un backtick: ${q}`);
        assert.equal(tieneLinkClickeable(q), false);
        // Anti-phishing: el esquema y el `//` no sobreviven al saneamiento, así
        // que no queda una URL que Telegram pueda auto-linkificar hacia el path
        // del atacante (queda `https???evil.tld?phish`, texto muerto).
        //
        // El dominio pelado SÍ sobrevive como texto, y está bien que así sea: es
        // indistinguible del dominio de un email legítimo (`@intrale.com.ar`),
        // que es justo lo que el operador necesita leer para reconocer al
        // committer. Recortarlo rompería CA-8 sin cerrar nada.
        assert.doesNotMatch(q, /https?:\/\//, 'no debe quedar un esquema de URL navegable');
        assert.doesNotMatch(q, /\/phish/, 'el path del atacante no debe sobrevivir');
    }
});

test('#5421 — emails VÁLIDOS de cualquier largo: el truncado no puede partir un span', () => {
    // Éste es el caso que el escapado NO cubría: sin metacaracteres en la
    // entrada, el code span lo aportaba el propio renderer y el corte posicional
    // lo partía al medio (barrido ciclo 6: 11 de 15 largos rompían la paridad).
    // Sin span, cortar en 280 o en 160 no puede romper nada.
    for (const len of [25, 40, 60, 80, 100, 120, 129, 140, 160, 180, 189, 200, 220, 240, 254]) {
        // Email de EXACTAMENTE `len` caracteres y forma válida (local@dominio.com),
        // dentro del tope RFC 5321 que aplica `sanitizeOperatorEmail`.
        const local = 'a'.repeat(Math.min(64, Math.floor(len / 2)));
        const email = `${local}@${'b'.repeat(len - local.length - 1 - 4)}.com`;
        assert.equal(email.length, len, 'el email del barrido debe medir lo pedido');
        const q = buildOperatorQuestion({
            issue: 5421,
            reasonStr: 'branch-origin-unverified:agent/5421-*',
            branchOriginVerified: false,
            unverifiedAuthors: [email],
        });
        assert.doesNotMatch(q, CODE_SPAN, `largo ${len} filtró un backtick: ${q.slice(0, 200)}`);
        assert.doesNotMatch(q.slice(0, 280), CODE_SPAN, `largo ${len} dejó un span cortado en 280`);
        assert.doesNotMatch(q.slice(0, 160), CODE_SPAN, `largo ${len} dejó un span cortado en 160`);
        // El email sigue siendo identificable para el operador.
        assert.ok(q.includes(email), `largo ${len}: el email debe seguir visible`);
    }
});

// ---- CA-12 end-to-end: paridad del MENSAJE ENTREGADO -------------------------
//
// Los tests de arriba pinean el CONTRIBUYENTE (la `question` no aporta ni un
// backtick). Éstos pinean el RESULTADO: el texto final que sale del renderer,
// que es lo que Telegram parsea y lo que decide si la alerta llega o se pierde
// con HTTP 400.
//
// La distinción importa porque el modo de falla del ciclo 6 no vivía en
// `buildOperatorQuestion` sino en la COMPOSICIÓN: el renderer cortaba la
// question por posición (`slice(0,280)` en el highlight, `slice(0,160)` en el
// listado) y partía al medio un code span que el propio wording había abierto.
// Un test que sólo mira la question no puede ver esa clase de bug: hace falta
// atravesar el renderer. Cubrimos los DOS caminos porque tienen cortes
// distintos, y el del listado es el que rompía incluso con el email benigno
// (una escalada real podía silenciar la alerta de OTRO issue).
const { buildBlockedSummaryMarkdown, buildBlockedSummaryPlain } = require('../human-block');

/** Arma la question del wording de configuración para un email dado. */
function questionDe(email) {
    return buildOperatorQuestion({
        issue: 5421,
        reasonStr: 'branch-origin-unverified:agent/5421-*',
        branchOriginVerified: false,
        unverifiedAuthors: [email],
    });
}

/** Email de forma 100% válida y EXACTAMENTE `len` caracteres. */
function emailDeLargo(len) {
    const local = 'a'.repeat(Math.min(64, Math.floor(len / 2)));
    return `${local}@${'b'.repeat(len - local.length - 1 - 4)}.com`;
}

test('CA-12 — el mensaje ENTREGADO queda con paridad PAR por el camino del HIGHLIGHT', () => {
    // Largos que en el ciclo 6 rompían la paridad de la alerta destacada.
    for (const len of [100, 129, 254]) {
        const email = emailDeLargo(len);
        assert.equal(email.length, len);
        const msg = buildBlockedSummaryMarkdown({
            blocked: [],
            highlight: {
                issue: 5421, skill: 'pipeline-dev', question: questionDe(email),
                reason: 'Fase verificacion: rama irresoluble.',
            },
        });
        assert.equal(
            contarBackticks(msg) % 2, 0,
            `largo ${len}: paridad IMPAR en el highlight ⇒ Telegram 400 ⇒ alerta perdida`,
        );
    }
});

test('CA-12 — el mensaje ENTREGADO queda con paridad PAR por el camino del LISTADO', () => {
    // El listado corta en 160, más agresivo que el highlight: es el camino que
    // rompía con MÁS largos (11 de 15 en el barrido del ciclo 6).
    for (const len of [100, 129, 254]) {
        const email = emailDeLargo(len);
        const msg = buildBlockedSummaryMarkdown({
            blocked: [{
                issue: 5421, skill: 'pipeline-dev', phase: 'verificacion',
                age_hours: 2, question: questionDe(email),
            }],
            highlight: null,
        });
        assert.equal(
            contarBackticks(msg) % 2, 0,
            `largo ${len}: paridad IMPAR en el listado ⇒ Telegram 400 ⇒ alerta perdida`,
        );
    }
});

test('CA-12 — el control benigno de CA-8 queda PAR también por el camino del LISTADO', () => {
    // Regresión directa del ciclo 6: `backend-dev-agent@intrale` daba 7
    // backticks (IMPAR) al listarse con `slice(160)`. No hacía falta atacante —
    // cualquier escalada real por committer fuera de allowlist silenciaba la
    // alerta, que podía ser la de otro issue.
    const msg = buildBlockedSummaryMarkdown({
        blocked: [{
            issue: 5421, skill: 'pipeline-dev', phase: 'verificacion',
            age_hours: 2, question: questionDe(EMAIL_BENIGNO),
        }],
        highlight: null,
    });
    assert.equal(contarBackticks(msg) % 2, 0, 'el control benigno no puede romper la paridad');
});

test('CA-12 — el renderer PLANO (el que realmente se envía) no emite un solo backtick', () => {
    // Éste es el camino de producción: todos los callers de `pulpo.js` mandan
    // `buildBlockedSummaryPlain` con `{ plain: true }`, así que el payload va
    // SIN `parse_mode`. Sin dialecto que parsear no hay paridad que romper —
    // es el kill-switch de la clase entera de bugs, no sólo de esta variante.
    for (const email of [EMAIL_BENIGNO, EMAIL_PHISHING, EMAIL_SILENCIADOR, emailDeLargo(129)]) {
        const q = questionDe(email);
        const conHighlight = buildBlockedSummaryPlain({
            blocked: [], highlight: { issue: 5421, skill: 'pipeline-dev', question: q },
        });
        const conListado = buildBlockedSummaryPlain({
            blocked: [{
                issue: 5421, skill: 'pipeline-dev', phase: 'verificacion',
                age_hours: 2, question: q,
            }],
            highlight: null,
        });
        assert.equal(contarBackticks(conHighlight), 0, `highlight plano con backticks para ${email}`);
        assert.equal(contarBackticks(conListado), 0, `listado plano con backticks para ${email}`);
        assert.equal(tieneLinkClickeable(conListado), false, `link clickeable entregado para ${email}`);
    }
});
