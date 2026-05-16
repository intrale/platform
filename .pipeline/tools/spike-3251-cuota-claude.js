// =============================================================================
// spike-3251-cuota-claude.js — Harness empírico del spike #3251.
//
// Simula los escenarios E1-E5 SIN spawnear agentes reales (CA-7: minimizar
// consumo de tokens). Usa el dispatcher real (`resolveSpawnWithFallback`)
// + módulo de cuota real (`quota-exhausted`) + handlers reales (incluidos
// stubs) para observar comportamiento end-to-end del path de fallback.
//
// Guardrails de security aplicados:
//  - Keys sintéticas obvias (sk-ant-invalid-spike-3251). Nunca commit.
//  - Scope local: NO export global de ANTHROPIC_API_KEY (Commander vivo).
//  - Limpia el flag entre escenarios.
//  - No redacta secretos en el output (no usa secretos reales).
//
// Uso: node .pipeline/tools/spike-3251-cuota-claude.js
// =============================================================================
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const PIPELINE = path.join(__dirname, '..');
const ROOT = path.join(PIPELINE, '..');

const dispatch = require(path.join(PIPELINE, 'lib/agent-launcher/dispatch-with-fallback'));
const quotaExhausted = require(path.join(PIPELINE, 'lib/quota-exhausted'));
const resolveProv = require(path.join(PIPELINE, 'lib/agent-launcher/resolve-provider'));

const FLAG = path.join(PIPELINE, 'quota-exhausted.json');

// ----- helpers -----
function cleanup() {
    try { fs.unlinkSync(FLAG); } catch {}
}
function header(t) {
    console.log('\n' + '='.repeat(78));
    console.log(t);
    console.log('='.repeat(78));
}
function pretty(o) { return JSON.stringify(o, null, 2); }

// ----- E0: pre-condiciones (CA-2 / CA-3 / CA-4 estáticas) -----
function escenarioPrecondiciones() {
    header('E0 — Pre-condiciones (CA-2 / CA-3 / CA-4 estáticas)');

    const models = require(path.join(PIPELINE, 'agent-models.json'));
    const skillCount = Object.keys(models.skills || {}).length;
    console.log(`agent-models.json skills cargados: ${skillCount}`);
    console.log(`Providers válidos (tabla hardcoded): ${resolveProv.VALID_PROVIDERS.join(', ')}`);

    // CA-2: confirmar config cargada en runtime
    console.log('\nSkills y sus providers/fallbacks:');
    for (const [k, v] of Object.entries(models.skills)) {
        const fb = (v.fallbacks || []).map(f => typeof f === 'string' ? f : f.provider).join(',') || '(none)';
        console.log(`  ${k.padEnd(14)} primary=${(v.provider || '?').padEnd(14)} fallbacks=[${fb}]`);
    }
    return { skillCount };
}

// ----- E1: Claude API key inválida ⇒ flag de cuota agotada -----
// Simulamos el flag (el setFlag exige errorType + provider).
function escenarioE1() {
    header('E1 — Claude API key inválida (cuota tipo "credenciales") ⇒ fallback skill por skill');
    cleanup();
    // Setear flag Anthropic
    const seteo = quotaExhausted.setFlag({
        errorType: 'credit_balance_too_low',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        resetsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        agent: 'spike-3251',
        rawExcerpt: '[SPIKE-3251] simulación E1: clave inválida (sintético).',
        auditLogEnabled: false,
    });
    console.log('setFlag result:', pretty(seteo));

    // Verificar que el flag bloquea Anthropic para un skill con fallbacks
    const skill = 'doc';
    const result = dispatch.resolveSpawnWithFallback({
        skill,
        issue: 3251,
        pipelineDir: PIPELINE,
        quotaModule: quotaExhausted,
        onLog: (lvl, msg) => console.log(`[log/${lvl}] ${msg}`),
    });
    console.log(`resolveSpawnWithFallback("${skill}"):`);
    console.log(`  provider=${result.provider}  model=${result.model}  source=${result.source}`);
    console.log(`  gated=${result.gated}  fallbackUsed=${pretty(result.fallbackUsed)}`);
    console.log(`  chainTried=[${result.chainTried.join(' → ')}]  crossProvider=${result.crossProvider}`);

    // Intentar buildSpawn del handler resuelto — confirma o desmiente el hallazgo de guru
    console.log(`\nProbando handler.buildSpawn() del fallback resuelto:`);
    try {
        const sd = result.handler.buildSpawn({ args: [], cwd: ROOT, env: {} });
        console.log(`  ✅ buildSpawn OK (no esperado para stubs): ${pretty(sd)}`);
        return { spawnOk: true, fallback: result.provider };
    } catch (e) {
        const firstLine = String(e.message).split('\n')[0];
        console.log(`  🛑 buildSpawn throw: ${firstLine}`);
        return { spawnOk: false, fallback: result.provider, errorFirstLine: firstLine };
    }
}

// ----- E2: 429 rate-limited ⇒ flag con errorType="rate_limited" -----
function escenarioE2() {
    header('E2 — Rate limited 429 ⇒ provider gated, fallback intentado');
    cleanup();
    quotaExhausted.setFlag({
        errorType: 'rate_limit',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        resetsAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        agent: 'spike-3251',
        rawExcerpt: '[SPIKE-3251] simulación E2: HTTP 429 (sintético).',
        auditLogEnabled: false,
    });
    const skill = 'guru';  // tiene 3 fallbacks
    const r = dispatch.resolveSpawnWithFallback({
        skill, issue: 3251, pipelineDir: PIPELINE, quotaModule: quotaExhausted,
        onLog: (lvl, msg) => console.log(`[log/${lvl}] ${msg}`),
    });
    console.log(`  provider=${r.provider}  source=${r.source}  gated=${r.gated}`);
    console.log(`  chainTried=[${r.chainTried.join(' → ')}]`);
    let spawnOk = false;
    try {
        r.handler.buildSpawn({ args: [], cwd: ROOT, env: {} });
        spawnOk = true;
    } catch (e) {
        console.log(`  🛑 buildSpawn de ${r.provider} throw: ${String(e.message).split('\n')[0]}`);
    }
    return { spawnOk, fallback: r.provider };
}

// ----- E3: quota exhausted real-shape -----
function escenarioE3() {
    header('E3 — Cuota mensual exhausta (Anthropic body real)');
    cleanup();
    // Simular evento Anthropic con el shape REAL del stream-json del CLI claude-code
    // (`evt.type === 'result' && evt.is_error === true && evt.error_type ∈ allowlist`).
    const fakeEvt = {
        type: 'result',
        is_error: true,
        error_type: 'usage_limit_error',
        result: 'Claude AI usage limit reached',
        resets_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    };
    // Cargar el providerDef REAL desde agent-models.json (no inventar shape).
    const agentModels = require(path.join(PIPELINE, 'agent-models.json'));
    const providerDef = agentModels.providers && agentModels.providers.anthropic;
    const det = quotaExhausted.detectQuotaError
        ? quotaExhausted.detectQuotaError(fakeEvt, providerDef)
        : (quotaExhausted.detectFromResultEvent ? quotaExhausted.detectFromResultEvent(fakeEvt, {}) : { matched: false });
    console.log(`detectQuotaError: matched=${det.matched}  errorType=${det.errorType || '-'}`);
    cleanup();

    // Si matched, simulamos seteo (como hace el commander):
    if (det.matched) {
        quotaExhausted.setFlag({
            errorType: det.errorType,
            provider: 'anthropic',
            model: 'claude-opus-4-7',
            resetsAt: fakeEvt.resets_at || null,
            agent: 'spike-3251',
            rawExcerpt: '[SPIKE-3251] simulación E3 (sintético).',
            auditLogEnabled: false,
        });
    }
    // Probar dashboard: el flag tiene la causa real?
    let payload = null;
    try { payload = JSON.parse(fs.readFileSync(FLAG, 'utf8')); } catch {}
    console.log('quota-exhausted.json:');
    if (payload) {
        // Mostramos solo campos relevantes (sin volcar todo crudo)
        console.log(`  errorType=${payload.errorType}  provider=${payload.provider}  resetsAt=${payload.resetsAt || '-'}`);
    } else {
        console.log('  (no flag escrito)');
    }
    return { matchedRealShape: !!det.matched, errorType: det.errorType || null };
}

// ----- E4: Pulpo sin LLM (lectura de código + observación filesystem) -----
function escenarioE4() {
    header('E4 — Pulpo orquestador sin Claude (observación de codepath)');
    // No tiene sentido "bajar Claude solo para el Pulpo" porque el Pulpo NO usa LLM
    // en su core loop. Lo verificamos por grep determinístico.
    const pulpoSrc = fs.readFileSync(path.join(PIPELINE, 'pulpo.js'), 'utf8');
    const llmCalls = [];
    // Patrones que indicarían uso LLM directo
    for (const m of pulpoSrc.matchAll(/spawn\(CLAUDE_LAUNCHER\.cmd|@anthropic-ai|ejecutarClaude\(/g)) {
        llmCalls.push({ idx: m.index, snippet: pulpoSrc.slice(Math.max(0, m.index - 30), m.index + 60).replace(/\n/g, ' ⏎ ') });
    }
    console.log(`Referencias LLM en pulpo.js: ${llmCalls.length}`);
    // Pero ¿son del core loop (orquestación) o del Commander/historias?
    // Heurística: contar funciones que las contienen
    const fnContext = [];
    for (const m of pulpoSrc.matchAll(/function\s+(\w+)\s*\(/g)) {
        fnContext.push({ name: m[1], idx: m.index });
    }
    function fnAt(idx) {
        let last = '(top-level)';
        for (const f of fnContext) {
            if (f.idx < idx) last = f.name; else break;
        }
        return last;
    }
    const byFn = {};
    for (const c of llmCalls) {
        const fn = fnAt(c.idx);
        byFn[fn] = (byFn[fn] || 0) + 1;
    }
    console.log('Llamadas LLM por función contenedora:');
    for (const [fn, n] of Object.entries(byFn)) console.log(`  ${fn}: ${n}`);
    console.log('Conclusión: si todas caen en ejecutarClaude o funciones del Commander/historias,');
    console.log('el core loop del pulpo (intake/outtake/dispatch) NO consume LLM directamente.');
    return { llmCallSites: llmCalls.length, byFn };
}

// ----- E5: Commander hardcoded a Anthropic -----
function escenarioE5() {
    header('E5 — Telegram Commander queda mudo si Anthropic cae (sin fallback)');
    const pulpoSrc = fs.readFileSync(path.join(PIPELINE, 'pulpo.js'), 'utf8');
    // Indicador 1: ejecutarClaude usa spawn(CLAUDE_LAUNCHER.cmd ...) (NO resolveSpawnWithFallback)
    const usesGlobalLauncher = /function ejecutarClaude[\s\S]{0,4500}spawn\(cmdSpawn,\s*cmdArgs/.test(pulpoSrc);
    // Indicador 2: bloquea provider 'anthropic' explícitamente en env-isolation
    const hardcodedAnthropic = /skill:\s*\{\s*provider:\s*['"]anthropic['"]/.test(pulpoSrc);
    // Indicador 3: cmdProvider = 'anthropic' fijo en quota-detector del commander
    const hardcodedCmdProvider = /cmdProvider\s*=\s*['"]anthropic['"]/.test(pulpoSrc);
    // Indicador 4: ¿llama alguna vez a resolveSpawnWithFallback en ejecutarClaude?
    const ejecutarClaudeBody = pulpoSrc.slice(
        pulpoSrc.indexOf('function ejecutarClaude'),
        pulpoSrc.indexOf('function ejecutarClaude') + 6000
    );
    const usesFallbackInCommander = /resolveSpawnWithFallback/.test(ejecutarClaudeBody);
    console.log(`commander → spawn directo de CLAUDE_LAUNCHER: ${usesGlobalLauncher}`);
    console.log(`commander → env-isolation hardcodea provider 'anthropic': ${hardcodedAnthropic}`);
    console.log(`commander → quota-detector hardcodea cmdProvider 'anthropic': ${hardcodedCmdProvider}`);
    console.log(`commander → usa resolveSpawnWithFallback: ${usesFallbackInCommander}`);
    return {
        usesGlobalLauncher,
        hardcodedAnthropic,
        hardcodedCmdProvider,
        usesFallbackInCommander,
        veredicto: !usesFallbackInCommander && (usesGlobalLauncher || hardcodedAnthropic)
            ? 'SPoF confirmado'
            : 'fallback detectado',
    };
}

// ----- main -----
(function main() {
    cleanup();
    const out = {};
    out.E0 = escenarioPrecondiciones();
    out.E1 = escenarioE1();
    out.E2 = escenarioE2();
    out.E3 = escenarioE3();
    out.E4 = escenarioE4();
    out.E5 = escenarioE5();
    cleanup();
    header('RESUMEN DEL SPIKE #3251');
    console.log(pretty(out));
})();
