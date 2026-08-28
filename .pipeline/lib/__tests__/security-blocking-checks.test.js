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

test('#6612 SEC-A — runtime-state-guard en FAILURE bloquea aunque el ruleset no lo exija', () => {
    // Rollup REAL del PR #6602 (verificado en el análisis del issue): el único
    // check requerido está en verde y el secret scan del diff está en rojo.
    const v = classifySecurityBlockingChecks({
        rollup: [
            rojo('runtime-state-guard'),
            verde('pr-status'),
            verde('OWASP Dependency Check'),
            verde('Semgrep Static Analysis'),
            verde('detect-secrets Scan'),
        ],
    });
    assert.equal(v.verdict, 'block', 'el merge de #6602 no debería haber salido');
    assert.deepEqual(v.failing, ['runtime-state-guard']);
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
            rollup: [{ name: 'runtime-state-guard', status: 'COMPLETED', conclusion: c }],
        });
        assert.equal(v.verdict, 'block', `conclusion=${c} tiene que bloquear`);
    }
    // Forma StatusContext (el otro shape que devuelve GitHub).
    for (const s of triggers.CHECK_FAIL_STATES) {
        const v = classifySecurityBlockingChecks({
            rollup: [{ context: 'runtime-state-guard', state: s }],
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
        classifySecurityBlockingChecks({ rollup: [rojo('runtime-state-guard'), null] }).verdict,
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
    assert.ok(SECURITY_BLOCKING_CONTEXTS.includes('runtime-state-guard'));
    assert.equal(isSecurityBlockingContext('runtime-state-guard'), true);
    assert.equal(isSecurityBlockingContext('pr-status'), false);
    assert.equal(isSecurityBlockingContext(undefined), false);
});

test('#6612 — el piso mínimo se ancla al YAML: si el guard toma modo warning, esto avisa', () => {
    // Anti-erosión: la única razón por la que `runtime-state-guard` puede vetar
    // es que su job NO declara `continue-on-error`. Si alguien se lo agrega, la
    // allowlist queda decorativa igual que los SAST — y este test lo grita en
    // vez de dejar que el gate muera en silencio.
    const wf = path.join(__dirname, '..', '..', '..', '.github', 'workflows');
    const guard = fs.readFileSync(path.join(wf, 'runtime-state-guard.yml'), 'utf8');
    assert.equal(
        /continue-on-error/.test(guard), false,
        'runtime-state-guard dejó de poder vetar: moverlo a WARNING_MODE_SECURITY_CONTEXTS'
    );
    const sast = fs.readFileSync(path.join(wf, 'security-sast.yml'), 'utf8');
    assert.match(sast, /continue-on-error: true/, 'los SAST siguen en modo warning (#6615)');
});

test('#6612 — los contextos de la allowlist existen tal cual en los workflows del repo', () => {
    // Anti-typo: un nombre mal escrito hace que el gate NUNCA matchee y el
    // fail-open vuelve con los tests en verde.
    const wf = path.join(__dirname, '..', '..', '..', '.github', 'workflows');
    const sast = fs.readFileSync(path.join(wf, 'security-sast.yml'), 'utf8');
    const guard = fs.readFileSync(path.join(wf, 'runtime-state-guard.yml'), 'utf8');
    assert.match(sast, /name:\s*OWASP Dependency Check/);
    assert.match(sast, /name:\s*Semgrep Static Analysis/);
    assert.match(sast, /name:\s*detect-secrets Scan/);
    assert.match(guard, /^ {2}runtime-state-guard:/m, 'el contexto es la job key (el job no declara `name:`)');
});
