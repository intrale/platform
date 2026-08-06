// =============================================================================
// Tests de `code-scanning-alerts.js` + su integración con el detector de
// bloqueo por hallazgos de seguridad (#5337, CA-3 caso 1).
//
// El riesgo que cubren: si el fetcher trae alertas de `refs/heads/main` (deuda
// preexistente del repo, que al 2026-08-01 existe), TODO PR queda bloqueado y
// el pipeline se autobloquea entero. Es el problema inverso al que #5337
// arregla, así que se testea explícitamente.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const cs = require('../code-scanning-alerts');
const { detectSecurityFindingBlock, TRIGGERS } = require('../human-block-triggers');

// Runner falso con la firma de spawnSync. Devuelve, por ref consultado, lo que
// le indique el mapa `porRef`.
function fakeRunner(porRef, { status = 0 } = {}) {
    const llamadas = [];
    const fn = (bin, args) => {
        llamadas.push({ bin, args });
        const url = args[1] || '';
        const m = /ref=([^&]+)/.exec(url);
        const ref = m ? decodeURIComponent(m[1]) : '';
        const payload = Object.prototype.hasOwnProperty.call(porRef, ref) ? porRef[ref] : [];
        return { status, stdout: JSON.stringify(payload), stderr: '' };
    };
    fn.llamadas = llamadas;
    return fn;
}

function alerta(number, ref, { state = 'open', rule = 'js/injection' } = {}) {
    return {
        number,
        state,
        rule: { id: rule, security_severity_level: 'high' },
        most_recent_instance: { ref },
    };
}

test('CA-3: NUNCA consulta refs/heads/main (la deuda preexistente no bloquea)', () => {
    const runner = fakeRunner({});
    cs.fetchPrCodeScanningAlerts(
        { repo: 'intrale/platform', prNumber: 5281, headRefName: 'agent/5242-pipeline-dev' },
        { runner, ghBin: 'gh' }
    );
    const refsConsultados = runner.llamadas.map((c) => {
        const m = /ref=([^&]+)/.exec(c.args[1]);
        return m ? decodeURIComponent(m[1]) : '';
    });
    assert.ok(refsConsultados.includes('refs/pull/5281/head'), 'debe consultar el ref del PR');
    assert.ok(
        !refsConsultados.some((r) => r === 'refs/heads/main'),
        `jamás debe consultar main; consultó: ${refsConsultados.join(', ')}`
    );
});

test('CA-3: alertas del PR se detectan y producen bloqueo humano', () => {
    const runner = fakeRunner({
        'refs/pull/5281/head': [alerta(201, 'refs/pull/5281/head')],
    });
    const { alerts, error } = cs.fetchPrCodeScanningAlerts(
        { repo: 'intrale/platform', prNumber: 5281 },
        { runner }
    );
    assert.equal(error, null);
    assert.equal(alerts.length, 1);

    const veredicto = detectSecurityFindingBlock({ prNumber: 5281, alerts });
    assert.ok(veredicto, 'debe bloquear');
    assert.equal(veredicto.trigger, TRIGGERS.SECURITY_FINDINGS);
    assert.match(veredicto.reason, /5281/);
    assert.ok(veredicto.recommendation, 'CA-2: debe traer recomendación');
});

test('CA-3: una alerta de main que se colara NO bloquea el PR', () => {
    // Defensa en profundidad: aunque la API devolviera algo de main, el
    // detector lo descarta por ref.
    const veredicto = detectSecurityFindingBlock({
        prNumber: 5281,
        headRefName: 'agent/5242-pipeline-dev',
        alerts: [alerta(109, 'refs/heads/main')],
    });
    assert.equal(veredicto, null, 'la deuda de main no puede bloquear un PR');
});

test('CA-3: alertas ya resueltas (state != open) no bloquean', () => {
    const veredicto = detectSecurityFindingBlock({
        prNumber: 5281,
        alerts: [alerta(201, 'refs/pull/5281/head', { state: 'fixed' })],
    });
    assert.equal(veredicto, null);
});

test('CA-3: dedup entre los dos refs consultados', () => {
    const runner = fakeRunner({
        'refs/pull/5281/head': [alerta(201, 'refs/pull/5281/head')],
        'refs/heads/agent/5242-pipeline-dev': [alerta(201, 'refs/pull/5281/head')],
    });
    const { alerts } = cs.fetchPrCodeScanningAlerts(
        { repo: 'intrale/platform', prNumber: 5281, headRefName: 'agent/5242-pipeline-dev' },
        { runner }
    );
    assert.equal(alerts.length, 1, 'la misma alerta por dos refs cuenta una sola vez');
});

test('CA-3: no poder consultar NO inventa un bloqueo (404/403/timeout)', () => {
    for (const caso of [
        { runner: () => ({ status: 1, stdout: '', stderr: 'HTTP 404: no code scanning' }) },
        { runner: () => ({ status: 1, stdout: '', stderr: 'HTTP 403: missing scope' }) },
        { runner: () => ({ status: null, error: new Error('ETIMEDOUT') }) },
        { runner: () => ({ status: 0, stdout: 'no-es-json' }) },
        { runner: () => { throw new Error('spawn ENOENT'); } },
    ]) {
        const { alerts, error } = cs.fetchPrCodeScanningAlerts(
            { repo: 'intrale/platform', prNumber: 5281 },
            { runner: caso.runner }
        );
        assert.equal(alerts.length, 0, 'sin alertas');
        assert.ok(error, 'reporta el error para el log');
        // Lo importante: sin alertas, el detector no bloquea.
        assert.equal(detectSecurityFindingBlock({ prNumber: 5281, alerts }), null);
    }
});

test('CA-3: entrada inválida se rechaza sin invocar gh', () => {
    let invocado = false;
    const runner = () => { invocado = true; return { status: 0, stdout: '[]' }; };
    for (const args of [
        { repo: '', prNumber: 1 },
        { repo: 'intrale/platform', prNumber: 0 },
        { repo: 'intrale/platform', prNumber: -5 },
        { repo: 'no-es-un-repo', prNumber: 1 },
        { repo: 'a/b; rm -rf /', prNumber: 1 },
    ]) {
        const r = cs.fetchPrCodeScanningAlerts(args, { runner });
        assert.equal(r.alerts.length, 0);
        assert.ok(r.error);
    }
    assert.equal(invocado, false, 'nunca debe spawnear gh con entrada inválida');
});

test('CA-3: los args son un array (sin shell-string inyectable)', () => {
    const runner = fakeRunner({});
    cs.fetchPrCodeScanningAlerts({ repo: 'intrale/platform', prNumber: 5281 }, { runner });
    const { args } = runner.llamadas[0];
    assert.ok(Array.isArray(args), 'args debe ser array');
    assert.equal(args[0], 'api');
    assert.ok(args[1].startsWith('/repos/intrale/platform/code-scanning/alerts?'));
    assert.match(args[1], /state=open/);
});

test('CA-3: pr-info-fetcher pide mergeable y mergeStateStatus', () => {
    // Sin estos campos, el detector de conflicto/CODEOWNERS no tiene con qué
    // decidir y el cableado del pulpo queda mudo.
    const { __FIELDS } = require('../pr-info-fetcher');
    assert.match(__FIELDS, /\bmergeable\b/);
    assert.match(__FIELDS, /\bmergeStateStatus\b/);
});
