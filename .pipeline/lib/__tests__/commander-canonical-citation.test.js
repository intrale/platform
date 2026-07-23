// =============================================================================
// commander-canonical-citation.test.js — Suite de `/verificar` y la cita del
// comando canónico en el Commander (#3897 CA-5, split 3/3 del épico #3894).
//
// Cubre:
//   - CA-5/UX-2: la respuesta cita el hecho en forma `<hecho> (<fuente
//     legible>)` — verificable, no proxy ambiguo.
//   - A09/CWE-200 (test obligatorio del issue): claim cuyo comando canónico
//     embebe un token (`ghp_…` / `github_pat_…` / AWS key) → la cita sale
//     REDACTADA antes de tocar Telegram.
//   - UX-2: `not_verifiable` se comunica con lenguaje claro y honesto, sin
//     volcar el error crudo ni inventar una fuente.
//   - Sintaxis estricta de `/verificar` (allowlist de tipos + entero puro;
//     inyección `5;rm`, backticks, tokens extra → rechazados).
//   - E2E del dispatcher con impls fake (sin red/shell): `/verificar pr 3890`
//     responde con la cita canónica.
//
// Diseño: fakes inyectables vía `canonicalImpls`. CERO red/FS-de-prod/shell.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cd = require('../commander-deterministic');
const {
    classify,
    parseVerificarArgs,
    renderCanonicalCitation,
    canonicalCitationFor,
    VERIFICAR_NOT_VERIFIABLE_MSG,
    VERIFICAR_CLAIM_TYPES,
    createDispatcher,
} = cd;

// -----------------------------------------------------------------------------
// Sintaxis de `/verificar` — allowlist estricta.
// -----------------------------------------------------------------------------
test('parseVerificarArgs: formas válidas → claim canónico mapeado', () => {
    assert.deepEqual(parseVerificarArgs('pr 3890'),
        { tipo: 'pr', claimKey: 'pr_mergeado', param: 'pr', numero: 3890 });
    assert.deepEqual(parseVerificarArgs('issue #3897'),
        { tipo: 'issue', claimKey: 'issue_cerrado', param: 'issue', numero: 3897 });
    assert.deepEqual(parseVerificarArgs('rama 3897'),
        { tipo: 'rama', claimKey: 'rama_contiene_commits', param: 'issue', numero: 3897 });
    assert.deepEqual(parseVerificarArgs('main 3897'),
        { tipo: 'main', claimKey: 'entregable_en_main', param: 'issue', numero: 3897 });
    assert.deepEqual(parseVerificarArgs('entregable 3897'),
        { tipo: 'entregable', claimKey: 'entregable_en_main', param: 'issue', numero: 3897 });
    // Case-insensitive en el tipo.
    assert.equal(parseVerificarArgs('PR 42').claimKey, 'pr_mergeado');
});

test('parseVerificarArgs: inyección y sintaxis inválida → null (nada se ejecuta)', () => {
    const bad = [
        '', 'pr', '3890', 'pr 3890 extra', 'pr 5;rm -rf /', 'pr `whoami`',
        'pr $(id)', 'pr -1', 'pr 0', 'pr 3890.5', 'pr 0x10', 'pr 38 90',
        'sha abcdef1', 'branch 3897', 'pr #', 'pr ##3890', 'issue agent/9-malo',
    ];
    for (const args of bad) {
        assert.equal(parseVerificarArgs(args), null, `args "${args}" NO fue rechazado`);
    }
});

test('classify: `/verificar` y NLP "verificá ..." rutean al comando determinístico', () => {
    assert.deepEqual(
        { class: classify('/verificar pr 3890').class, command: classify('/verificar pr 3890').command },
        { class: 'deterministic', command: 'verificar' });
    assert.equal(classify('/verify issue 3897').command, 'verify');
    const nlp = classify('verificá pr 3890');
    assert.equal(nlp.class, 'deterministic');
    assert.equal(nlp.command, 'verificar');
    assert.equal(nlp.args, 'pr 3890');
});

// -----------------------------------------------------------------------------
// CA-5 / UX-2 — forma `<hecho> (<fuente legible>)`.
// -----------------------------------------------------------------------------
test('CA-5: cita hecho+fuente legible por claim (ej. UX-2 del épico)', () => {
    assert.equal(
        canonicalCitationFor('pr_mergeado', 3890, { value: true, status: 'consistent' }),
        'PR #3890 mergeado (gh pr view 3890 → state: MERGED)');
    assert.equal(
        canonicalCitationFor('pr_mergeado', 3890, { value: false, status: 'inconsistent' }),
        'PR #3890 NO mergeado (gh pr view 3890 → state: sin merge)');
    assert.equal(
        canonicalCitationFor('issue_cerrado', 3897, { value: true, status: 'consistent' }),
        '#3897 cerrado (gh issue view 3897 → state: CLOSED)');
    assert.equal(
        canonicalCitationFor('entregable_en_main', 3729, { value: true, status: 'consistent' }),
        '#3729 entregado en main (git branch --merged origin/main → rama agent/3729-* mergeada)');
});

test('UX-2: la cita NO contiene flags ruidosos, paths absolutos ni dumps', () => {
    for (const [tipo, meta] of Object.entries(VERIFICAR_CLAIM_TYPES)) {
        for (const value of [true, false]) {
            const cita = canonicalCitationFor(meta.claimKey, 4242, { value, status: 'consistent' });
            assert.ok(!/--json|--jq|C:\\|\/home\/|\\Workspaces/.test(cita),
                `${tipo}/${value}: la cita arrastra flags/paths: "${cita}"`);
            assert.match(cita, /^.+ \(.+\)$/, `${tipo}/${value}: no respeta <hecho> (<fuente>)`);
        }
    }
});

// -----------------------------------------------------------------------------
// UX-2 — not_verifiable: lenguaje claro y honesto.
// -----------------------------------------------------------------------------
test('UX-2: not_verifiable → mensaje claro, sin fuente inventada ni error crudo', () => {
    const cases = [
        canonicalCitationFor('pr_mergeado', 1, { value: null, status: 'not_verifiable' }),
        canonicalCitationFor('pr_mergeado', 1, null),
        canonicalCitationFor('claim_inexistente', 1, { value: true, status: 'consistent' }),
    ];
    for (const msg of cases) {
        assert.equal(msg, VERIFICAR_NOT_VERIFIABLE_MSG);
        assert.match(msg, /No pude verificar/, 'lenguaje claro requerido');
        assert.ok(!/\(.*→.*\)/.test(msg), 'no debe inventar una fuente');
        assert.ok(!/Error|stack|ENOENT|exit/i.test(msg), 'no debe volcar error crudo');
    }
});

// -----------------------------------------------------------------------------
// A09 / CWE-200 — test obligatorio del issue: token embebido → redactado.
// -----------------------------------------------------------------------------
test('A09: cita cuyo comando canónico embebe un token ghp_ → sale redactada', () => {
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const cita = renderCanonicalCitation({
        hecho: 'PR #3890 mergeado',
        fuente: `gh pr view 3890 --header "authorization: ${token}" → state: MERGED`,
    });
    assert.ok(!cita.includes(token), `token ghp_ fugó a la cita: "${cita}"`);
});

test('A09: PAT fine-grained github_pat_ embebido → redactado', () => {
    const pat = 'github_pat_' + '11ABCDEFG0'.repeat(8);
    const cita = renderCanonicalCitation({ hecho: `#1 cerrado con ${pat}`, fuente: 'gh issue view 1' });
    assert.ok(!cita.includes(pat), `PAT fine-grained fugó a la cita: "${cita}"`);
});

test('A09: AWS access key embebida → redactada', () => {
    const aws = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const cita = renderCanonicalCitation({ hecho: '#1 cerrado', fuente: `gh issue view 1 con ${aws}` });
    assert.ok(!cita.includes(aws), `AWS key fugó a la cita: "${cita}"`);
});

// -----------------------------------------------------------------------------
// E2E del dispatcher — `/verificar` responde con la cita canónica (fakes).
// -----------------------------------------------------------------------------
function mkDispatcher(canonicalImpls) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verificar-dispatch-'));
    fs.mkdirSync(path.join(tmp, 'logs'), { recursive: true });
    return createDispatcher({
        pipelineRoot: tmp,
        logsDir: path.join(tmp, 'logs'),
        destructiveCooldown: false,
        canonicalImpls,
    });
}

test('E2E: /verificar pr 3890 con ghApi fake (MERGED) → reply cita el comando canónico', async () => {
    const ghApi = async ({ args }) => {
        assert.deepEqual(args, ['pr', 'view', '3890', '--json', 'state,mergedAt']);
        return { ok: true, stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-06-10T11:33:00Z' }) };
    };
    const { dispatch } = mkDispatcher({ ghApi });
    const out = await dispatch({ chat_id: '1', text: '/verificar pr 3890' });
    assert.equal(out.status, 'ok');
    assert.match(out.reply, /PR \\#3890 mergeado/);
    assert.match(out.reply, /gh pr view 3890/);
    assert.match(out.reply, /state: MERGED/);
});

test('E2E: fuente canónica caída → not_verifiable con lenguaje claro (sin especular)', async () => {
    const ghApi = async () => ({ ok: false, stdout: '', stderr: 'rate limit' });
    const { dispatch } = mkDispatcher({ ghApi });
    const out = await dispatch({ chat_id: '1', text: '/verificar issue 3897' });
    assert.equal(out.status, 'ok');
    assert.match(out.reply, /No pude verificar/);
    assert.ok(!/rate limit/.test(out.reply), 'no debe volcar el stderr crudo');
});

test('E2E: args inválidos (/verificar pr 5;rm) → invalid_args, el handler NO corre', async () => {
    let called = false;
    const ghApi = async () => { called = true; return { ok: true, stdout: '{}' }; };
    const { dispatch } = mkDispatcher({ ghApi });
    const out = await dispatch({ chat_id: '1', text: '/verificar pr 5;rm -rf /' });
    assert.equal(out.status, 'invalid_args');
    assert.equal(called, false, 'la fuente canónica NUNCA debe ejecutarse con args inválidos');
});
