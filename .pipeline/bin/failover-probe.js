#!/usr/bin/env node
// =============================================================================
// failover-probe.js — Sonda de failover reproducible (#4404 D5).
//
// POR QUÉ EXISTE
//   `test-failover.sh` necesita observar, de forma determinística y sin red,
//   que cuando el provider PRIMARIO de un skill queda indisponible el resolver
//   real salta al FALLBACK DECLARADO en `agent-models.json`. Este módulo maneja
//   esa observación apoyándose en la lógica real de
//   `lib/agent-launcher/dispatch-with-fallback.js::resolveSpawnWithFallback` —
//   NO reimplementa el chain-walking: sólo inyecta la señal de "primario caído"
//   y neutraliza el resto de las señales de estado vivo (cuota, horario, health,
//   pacing) para que el resultado dependa exclusivamente de la config declarada.
//
// MECANISMO DE "CAÍDA" (acoplado a RS-4)
//   El primario se considera caído cuando su credencial (la env var declarada
//   en `providers.<primario>.credentials_env`) está ENMASCARADA (vacía/ausente)
//   en el entorno del proceso. `test-failover.sh` la enmascara de forma
//   reversible (RS-4: masking a nivel env del hijo, nunca toca el archivo
//   canónico de secrets, restauración por trap). Así el enmascaramiento de la
//   credencial ES la causa observable del salto: credencial masked ⇒ primario
//   tratado como indisponible ⇒ el resolver real elige el fallback declarado.
//
// MODOS
//   node failover-probe.js credenv <skill>
//       → imprime, separadas por espacio, las env vars de credencial del
//         provider primario del skill (para que el shell sepa qué enmascarar).
//   node failover-probe.js resolve <skill>
//       → resuelve la cadena y, si el salto ocurrió al fallback declarado,
//         imprime  `<primario>|<fallback>|<source>|<masked>|<gate>`  y sale 0.
//         Si NO saltó como se esperaba, sale != 0 (fail del caso).
//
// SEGURIDAD
//   - NUNCA imprime el valor de una credencial: sólo nombres de env var,
//     nombres de provider y booleanos (RS-4.3).
//   - No hace requests de red ni escribe audit/telegram (todo inyectado no-op).
//   - Si el fallback resuelto es `non_anthropic`, demuestra que un payload de
//     prueba pasaría por `filterPathsForProvider()` (CA-F.3): el gate se ejerce,
//     nunca se bypassea para "simular".
// =============================================================================
'use strict';

const path = require('node:path');

const PIPELINE_DIR = path.resolve(__dirname, '..');

function readModels() {
    // require cachea; es un proceso one-shot, no importa.
    return require(path.join(PIPELINE_DIR, 'agent-models.json'));
}

function declaredFallbackOf(skillCfg) {
    const arr = Array.isArray(skillCfg && skillCfg.fallbacks) ? skillCfg.fallbacks : [];
    const first = arr[0];
    if (!first) return null;
    return typeof first === 'string' ? first : (first.provider || null);
}

function fail(msg, code = 2) {
    process.stderr.write(`[failover-probe] ${msg}\n`);
    process.exit(code);
}

function main() {
    const mode = process.argv[2];
    const skill = process.argv[3];
    if (!mode || !skill) fail('uso: failover-probe.js <credenv|resolve> <skill>', 3);

    const models = readModels();
    const skillCfg = models.skills && models.skills[skill];
    if (!skillCfg) fail(`skill '${skill}' no está en agent-models.json`, 3);

    const primaryProvider = skillCfg.provider || 'anthropic';
    const primaryDef = (models.providers && models.providers[primaryProvider]) || {};
    const credEnv = Array.isArray(primaryDef.credentials_env) ? primaryDef.credentials_env : [];

    // ── Modo credenv: sólo nombres de env var, nunca valores. ──────────────────
    if (mode === 'credenv') {
        process.stdout.write(credEnv.join(' '));
        process.exit(0);
    }

    if (mode !== 'resolve') fail(`modo desconocido '${mode}'`, 3);

    const declaredFallback = declaredFallbackOf(skillCfg);
    if (!declaredFallback) fail(`skill '${skill}' no declara fallbacks en agent-models.json`, 3);

    // ¿La credencial del primario está enmascarada (vacía/ausente) en el env?
    const primaryCredMasked = credEnv.length > 0 && credEnv.every((v) => {
        const val = process.env[v];
        return val === undefined || String(val).trim() === '';
    });

    // Inyecciones para aislar la decisión: sólo el primario "cae"; el resto de
    // las señales de estado quedan neutralizadas (verde) para que el salto
    // dependa exclusivamente de la cadena declarada, no del estado vivo del box.
    const downSet = new Set();
    if (primaryCredMasked) downSet.add(primaryProvider);

    const disabledModule = {
        isProviderDisabled: (p) => downSet.has(p),
        getDisabledEntry: (p) => (downSet.has(p) ? { source: 'test-failover-cred-masked' } : null),
    };
    const quotaModule = {
        shouldGateSpawn: () => false,
        sanitizeRawExcerpt: (s) => String(s == null ? '' : s),
        KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER: {},
    };
    const scheduleModule = { isProviderActiveNow: () => true };
    const softGateModule = { isPreventivelyDegraded: () => false };
    const pacingModule = { getPacingState: () => 'green' };

    const { resolveSpawnWithFallback } =
        require('../lib/agent-launcher/dispatch-with-fallback');

    const res = resolveSpawnWithFallback({
        skill,
        issue: 'failover-test',
        pipelineDir: PIPELINE_DIR,
        quotaModule,
        disabledModule,
        scheduleModule,
        softGateModule,
        pacingModule,
        healthReader: () => null,            // sin health-gate en el test
        notify: () => {},                    // sin telegram
        auditLog: { appendChained: () => {} }, // sin escritura de audit
        onLog: () => {},
        processEnv: process.env,
        now: Date.now(),
    });

    const chosen = res && res.provider;
    const source = res && res.source;

    // CA-F.3 — si el fallback resuelto es `non_anthropic`, demostrar que un
    // payload de prueba pasaría por el gate data-residency (nunca bypasseado).
    let gateStatus = 'n/a';
    if (chosen && chosen !== 'anthropic' && chosen !== 'deterministic') {
        try {
            const drf = require('../lib/data-residency-filter');
            const { exclusions, default_policy: defaultPolicy } = drf.loadExclusionsOrThrow();
            const sample = ['docs/pipeline/multi-provider.md']; // ruta benigna, no sensible
            const filt = drf.filterPathsForProvider({ paths: sample, provider: chosen, exclusions, defaultPolicy });
            gateStatus = `ok (${sample.length} path evaluado, ${filt.blocked.length} bloqueado)`;
        } catch (e) {
            gateStatus = `fail-closed (${e && e.message ? e.message.split('\n')[0] : 'error'})`;
        }
    }

    // Validación del caso: debe haber saltado al fallback DECLARADO.
    if (!primaryCredMasked) {
        fail(`el primario '${primaryProvider}' NO quedó enmascarado (credencial presente) — el shell no forzó la caída`, 2);
    }
    if (source !== 'fallback') {
        fail(`no hubo salto a fallback (source='${source}', provider='${chosen}')`, 2);
    }
    if (chosen !== declaredFallback) {
        fail(`saltó a '${chosen}' pero el fallback declarado es '${declaredFallback}'`, 2);
    }

    process.stdout.write(
        `${primaryProvider}|${chosen}|${source}|${primaryCredMasked}|${gateStatus}`,
    );
    process.exit(0);
}

try {
    main();
} catch (e) {
    fail(`excepción no controlada: ${e && e.message ? e.message : String(e)}`, 3);
}
