// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// #6612 SEC-A — Allowlist de checks de seguridad bloqueantes.
//
// QUÉ DEFECTO CUBRE ESTA SUITE. #6612 acota la espera de `delivery` a los checks
// que el ruleset de `main` REALMENTE exige. Verificado contra el repo:
//
//     $ gh api repos/intrale/platform/rules/branches/main \
//         --jq '[.[]|select(.type=="required_status_checks")
//                |.parameters.required_status_checks[].context]'
//     ["pr-status"]
//
// Un solo contexto => TODOS los escáneres de seguridad son "no requeridos".
// Hacer el acotamiento SIN esta allowlist los vuelve decorativos, y no es
// hipotético: el PR #6602 ya se mergeó con `runtime-state-guard` (el secret scan
// del diff del PR) en FAILURE.
//
// Sin red: el clasificador es puro y recibe el rollup ya leído.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    SECURITY_BLOCKING_CONTEXTS,
    WARNING_MODE_SECURITY_CONTEXTS,
    classifySecurityBlockingChecks,
    isSecurityBlockingContext,
} = require('../security-blocking-checks');
const triggers = require('../human-block-triggers');

const rojo = (name) => ({ name, status: 'COMPLETED', conclusion: 'FAILURE' });
const verde = (name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' });
const corriendo = (name) => ({ name, status: 'IN_PROGRESS', conclusion: null });

// ── SEC-A / SEC-G: el caso del episodio #6602 ────────────────────────────────

test('#6612 SEC-A — el secret scan bloqueante en FAILURE bloquea aunque el ruleset no lo exija', () => {
    // Rollup REAL del PR #6602 (verificado en el análisis del issue): el único
    // check requerido está en verde y el secret scan del diff está en rojo.
    // En #6602 el contexto rojo se llamaba `runtime-state-guard`; desde #7660
    // (fila 6 de #7658) ese workflow no existe y el secret scan bloqueante es
    // `Secret scan (blocking)` de `security-sast.yml`: mismo escáner, mismo diff.
    const v = classifySecurityBlockingChecks({
        rollup: [
            rojo('Secret scan (blocking)'),
            verde('pr-status'),
            verde('OWASP Dependency Check'),
            verde('Semgrep Static Analysis'),
            verde('detect-secrets Scan'),
        ],
    });
    assert.equal(v.verdict, 'block', 'el merge de #6602 no debería haber salido');
    assert.deepEqual(v.failing, ['Secret scan (blocking)']);
});

test('#6612 SEC-A — los 3 jobs de security-sast.yml NO bloquean: corren en modo warning', () => {
    // POR QUÉ NO BLOQUEAN, con evidencia y no con opinión. Los tres declaran
    // `continue-on-error: true` a nivel job, y eso hace que le reporten SUCCESS
    // a GitHub aunque sus pasos fallen. Rollup real del PR #6602 —el del
    // fail-open— con el secret scan en FAILURE:
    //
    //   runtime-state-guard      => COMPLETED/FAILURE
    //   OWASP Dependency Check   => COMPLETED/SUCCESS
    //   Semgrep Static Analysis  => COMPLETED/SUCCESS
    //   detect-secrets Scan      => COMPLETED/SUCCESS
    //
    // Bloquear por ellos sería un gate incapaz de dispararse, y encima
    // contradiría un criterio YA MERGEADO: #6599 CA-3 fija que un no requerido
    // en rojo mergea, usando justamente el OWASP como ejemplo.
    //
    // Igual NO se los ignora: salen por `warningMode` para que el log diga por
    // qué no frenaron, y un rojo suyo genera la constancia de UX-3 en el PR.
    for (const ctx of WARNING_MODE_SECURITY_CONTEXTS) {
        const v = classifySecurityBlockingChecks({ rollup: [verde('pr-status'), rojo(ctx)] });
        assert.equal(v.verdict, 'clear', `${ctx} corre en modo warning: no puede vetar`);
        assert.deepEqual(v.failing, []);
        assert.deepEqual(v.warningMode, [ctx], 'pero queda dicho que estaba en rojo');
    }
});

test('#6612 #6615 — sacar un escáner de modo warning es UNA sola mudanza de lista', () => {
    // Las dos listas son disjuntas y cubren juntas los 4 escáneres del repo.
    // Cuando #6615 saque a los SAST del modo warning, el cambio es mover el
    // nombre de una lista a la otra — y este test obliga a que sea consciente.
    for (const ctx of WARNING_MODE_SECURITY_CONTEXTS) {
        assert.equal(SECURITY_BLOCKING_CONTEXTS.includes(ctx), false,
            `${ctx} no puede estar en las dos listas`);
        assert.equal(isSecurityBlockingContext(ctx), false,
            'en modo warning no rotula como bloqueante por seguridad');
    }
    assert.ok(Object.isFrozen(WARNING_MODE_SECURITY_CONTEXTS));
});

test('#6612 SEC-A — todos los estados de fallo del enum cuentan, no sólo FAILURE', () => {
    // Si sólo se mirara `FAILURE`, un escáner cancelado o con timeout pasaría
    // como no-bloqueante. Por eso el enum se importa entero.
    for (const c of triggers.CHECK_FAIL_CONCLUSIONS) {
        const v = classifySecurityBlockingChecks({
            rollup: [{ name: 'Secret scan (blocking)', status: 'COMPLETED', conclusion: c }],
        });
        assert.equal(v.verdict, 'block', `conclusion=${c} tiene que bloquear`);
    }
    // Forma StatusContext (el otro shape que devuelve GitHub).
    for (const s of triggers.CHECK_FAIL_STATES) {
        const v = classifySecurityBlockingChecks({
            rollup: [{ context: 'Secret scan (blocking)', state: s }],
        });
        assert.equal(v.verdict, 'block', `state=${s} tiene que bloquear`);
    }
});

// ── SEC-B: la allowlist mira `failure`, NUNCA `pending` ──────────────────────

test('#6612 SEC-B — un check de la allowlist EN CURSO no frena (si no, OWASP vuelve a bloquear 3 h)', () => {
    const v = classifySecurityBlockingChecks({
        rollup: [verde('pr-status'), corriendo('OWASP Dependency Check')],
    });
    assert.equal(v.verdict, 'clear', 'bloquear por pending revive el defecto que #6612 vino a arreglar');
    assert.deepEqual(v.failing, []);
});

test('#6612 — un check NO listado en rojo no bloquea por este gate', () => {
    const v = classifySecurityBlockingChecks({ rollup: [verde('pr-status'), rojo('e2e-qa')] });
    assert.equal(v.verdict, 'clear');
});

// ── G-3: `null` != `[]` ──────────────────────────────────────────────────────

test('#6612 G-3 — rollup null es `unusable`, NUNCA `clear`', () => {
    const v = classifySecurityBlockingChecks({ rollup: null });
    assert.equal(v.verdict, 'unusable', 'leer "no pude consultar" como "nada en rojo" es el fail-open exacto');
    assert.equal(v.cause, 'rollup-no-legible');
    // Y las otras formas de "no lo leí".
    assert.equal(classifySecurityBlockingChecks({}).verdict, 'unusable');
    assert.equal(classifySecurityBlockingChecks({ rollup: 'x' }).verdict, 'unusable');
    assert.equal(classifySecurityBlockingChecks().verdict, 'unusable');
});

test('#6612 G-3 — rollup [] (leído y vacío) es `clear`', () => {
    const v = classifySecurityBlockingChecks({ rollup: [] });
    assert.equal(v.verdict, 'clear');
    assert.equal(v.cause, null);
});

test('#6612 — una entrada ilegible del rollup no se descarta: `unusable`, no `clear`', () => {
    // Podría ser justo el escáner en rojo. No se puede afirmar que no lo sea.
    assert.equal(classifySecurityBlockingChecks({ rollup: [verde('pr-status'), null] }).verdict, 'unusable');
    // Pero un rojo CONFIRMADO gana sobre la duda: `block` es más fuerte.
    assert.equal(
        classifySecurityBlockingChecks({ rollup: [rojo('Secret scan (blocking)'), null] }).verdict,
        'block'
    );
});

// ── Anti-divergencia (CA-23 de #6431) ────────────────────────────────────────

const SRC = fs.readFileSync(path.join(__dirname, '..', 'security-blocking-checks.js'), 'utf8');
// Fuente SIN comentarios: los asserts anti-config tienen que mirar lo que el
// módulo HACE, no lo que documenta. El comentario nombra `config.yaml` a
// propósito, para explicar por qué la lista NO sale de ahí.
const SRC_CODIGO = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('#6612 CA-23 — el módulo IMPORTA los enums de estado, no los re-declara', () => {
    assert.match(
        SRC,
        /require\(['"]\.\/human-block-triggers['"]\)/,
        'los enums salen de human-block-triggers; dos copias divergen y la vieja lee el valor nuevo como no-bloqueante'
    );
    assert.doesNotMatch(
        SRC,
        /const\s+CHECK_FAIL_(CONCLUSIONS|STATES)\s*=\s*Object\.freeze/,
        're-declarar la tabla es el fail-open silencioso que CA-23 prohíbe'
    );
});

// ── Anti-mutación (SEC-A) ────────────────────────────────────────────────────

test('#6612 SEC-A — la allowlist es inmutable y no se lee de config ni del entorno', () => {
    assert.equal(Object.isFrozen(SECURITY_BLOCKING_CONTEXTS), true, 'un push() en caliente cambia el gate');
    assert.throws(() => { SECURITY_BLOCKING_CONTEXTS.push('x'); }, 'la lista congelada no acepta escritura');

    // Si la lista saliera de config o del entorno, un agente con permiso de
    // escritura podría vaciar el gate de seguridad con un commit de una línea.
    // Se assertea sobre el CÓDIGO, no sobre los comentarios (que sí nombran
    // `config.yaml` justamente para explicar por qué no se usa).
    assert.doesNotMatch(SRC_CODIGO, /config\.yaml|config-resolver|configResolver/i);
    assert.doesNotMatch(SRC_CODIGO, /process\.env/);
    assert.doesNotMatch(SRC_CODIGO, /readFileSync|require\(['"](?!\.\/human-block-triggers)/);
});

test('#6612 — la allowlist cubre el piso mínimo: los escáneres con poder de veto', () => {
    // Piso mínimo = los que pueden vetar. Hoy es uno solo, y es exactamente el
    // que se escapó en #6602.
    assert.ok(SECURITY_BLOCKING_CONTEXTS.includes('Secret scan (blocking)'));
    assert.equal(isSecurityBlockingContext('Secret scan (blocking)'), true);
    assert.equal(isSecurityBlockingContext('pr-status'), false);
    assert.equal(isSecurityBlockingContext(undefined), false);
});

// ── Ancla YAML (#7660): el gate no puede quedar apuntando a un job que no existe ──
//
// Borrar o renombrar el job de un contexto de la allowlist NO rompe ningún
// test de lógica: el contexto simplemente deja de aparecer en el rollup, el
// veredicto sale `clear` y un secreto vuelve a mergear (el fail-open de
// #6602/#6612). Es exactamente el riesgo de la fila 6 de #7658, que eliminó
// `runtime-state-guard.yml`. Estos tests leen los workflows REALES del repo y
// exigen que cada contexto (a) exista como job, (b) pueda vetar y (c) corra en
// los PR.

const WORKFLOWS_DIR = path.join(__dirname, '..', '..', '..', '.github', 'workflows');

/** Todos los jobs de `.github/workflows/*.yml` con el contexto que publican. */
function jobsDeLosWorkflows() {
    const yaml = require('js-yaml');
    const out = [];
    for (const archivo of fs.readdirSync(WORKFLOWS_DIR)) {
        if (!/\.ya?ml$/.test(archivo)) continue;
        const doc = yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, archivo), 'utf8'));
        const jobs = (doc && doc.jobs) || {};
        for (const [key, job] of Object.entries(jobs)) {
            // El contexto del rollup es el `name:` del job; sin `name:`, la key.
            const contexto = job && typeof job.name === 'string' ? job.name : key;
            out.push({ archivo, key, contexto, job: job || {}, on: doc.on });
        }
    }
    return out;
}

test('#7660 — cada contexto de la allowlist es un job existente de .github/workflows', () => {
    const jobs = jobsDeLosWorkflows();
    for (const ctx of SECURITY_BLOCKING_CONTEXTS) {
        const hits = jobs.filter(j => j.contexto === ctx);
        assert.equal(
            hits.length, 1,
            `el contexto "${ctx}" tiene que salir de exactamente un job (hay ${hits.length}): ` +
            'si se borró o renombró, el gate de delivery quedó abierto — reapuntar la allowlist en el mismo cambio'
        );
    }
});

test('#7660 — los contextos de la allowlist pueden vetar: sin continue-on-error y en pull_request', () => {
    const jobs = jobsDeLosWorkflows();
    for (const ctx of SECURITY_BLOCKING_CONTEXTS) {
        const { archivo, job, on } = jobs.find(j => j.contexto === ctx);
        assert.notEqual(
            job['continue-on-error'], true,
            `${archivo}: "${ctx}" en modo warning reporta SUCCESS aunque falle — moverlo a WARNING_MODE_SECURITY_CONTEXTS`
        );
        for (const step of job.steps || []) {
            assert.notEqual(step['continue-on-error'], true, `${archivo}: un step de "${ctx}" no puede anular el rojo`);
        }
        // Tiene que aparecer en el rollup del PR: si no corre en pull_request,
        // nunca llega a vetar un merge.
        const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on || {});
        assert.ok(triggers.includes('pull_request'), `${archivo}: "${ctx}" tiene que correr en pull_request`);
        assert.ok(!triggers.includes('pull_request_target'), `${archivo}: nunca pull_request_target`);
    }
});

test('#7660 — el gate apunta al secret scan bloqueante de security-sast.yml (fila 6 de #7658)', () => {
    const jobs = jobsDeLosWorkflows();
    const scan = jobs.find(j => j.archivo === 'security-sast.yml' && j.key === 'secret-scan');
    assert.ok(scan, 'security-sast.yml declara el job secret-scan');
    assert.ok(SECURITY_BLOCKING_CONTEXTS.includes(scan.contexto), 'el contexto publicado por secret-scan está en la allowlist');
    assert.equal(scan.job['continue-on-error'], false, 'secret-scan declara continue-on-error: false explícito');
    // `runtime-state-guard.yml` se eliminó en #7660: su nombre ya no es un
    // contexto del repo y dejarlo en la allowlist sería un gate fantasma.
    assert.equal(fs.existsSync(path.join(WORKFLOWS_DIR, 'runtime-state-guard.yml')), false);
    assert.ok(!SECURITY_BLOCKING_CONTEXTS.includes('runtime-state-guard'));
});

test('#6612 — el piso mínimo se ancla al YAML: los SAST siguen en modo warning', () => {
    const sast = fs.readFileSync(path.join(WORKFLOWS_DIR, 'security-sast.yml'), 'utf8');
    assert.match(sast, /continue-on-error: true/, 'los SAST siguen en modo warning (#6615)');
});

test('#6612 — los contextos en modo warning existen tal cual en los workflows del repo', () => {
    // Anti-typo: un nombre mal escrito hace que la lista NUNCA matchee.
    const sast = fs.readFileSync(path.join(WORKFLOWS_DIR, 'security-sast.yml'), 'utf8');
    assert.match(sast, /name:\s*OWASP Dependency Check/);
    assert.match(sast, /name:\s*Semgrep Static Analysis/);
    assert.match(sast, /name:\s*detect-secrets Scan/);
});
