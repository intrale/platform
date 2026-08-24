#!/usr/bin/env node
// =============================================================================
// provider-contribution-report.js — Reporte de aporte real por proveedor (#6145)
// =============================================================================
//
// CLI READ-ONLY sobre el pipeline. Responde la pregunta del operador
// "¿que proveedores me estan costando mas de lo que aportan?" con la tabla de
// CA-1, la separacion de costo de CA-2 y el veredicto de permanencia de CA-6.
//
// LO QUE ESTE SCRIPT **NO** HACE (CA-7, REQ-SEC-3):
//   - No modifica `config.yaml` ni `agent-models.json`.
//   - No modifica `.pipeline/state/multi-provider-health.json`.
//   - No escribe en `.pipeline/logs/cross-provider-dispatch-*.jsonl`.
//   - No desactiva, reordena ni da de baja ningun proveedor.
//
// La UNICA escritura posible es OPT-IN (`--registrar`) y va a un audit
// append-only con hash-chain (`.pipeline/audit/provider-permanence.jsonl`) via
// `lib/audit-log.appendChained`. Nunca `writeFileSync` sobre ese path.
//
// FUENTE: `.pipeline/logs/cross-provider-dispatch-*.jsonl` (hash-chain).
// PROHIBIDO `.claude/activity-log.jsonl` — ver cabecera del modulo y el test
// de policy `el modulo no lee activity-log.jsonl`.
//
// -----------------------------------------------------------------------------
// USO
// -----------------------------------------------------------------------------
//
//   node .pipeline/scripts/provider-contribution-report.js [opts]
//
//   --dias=N              Ventana en dias (default 30, minimo exigido por CA-1).
//   --hasta=YYYY-MM-DD    Fin de la ventana (default: ahora).
//   --compacto            Tabla de 4 columnas (terminales angostas, CA-UX).
//   --json                Emitir SOLO el JSON canonico (sin texto para humanos).
//   --registrar           Registrar la decision en el audit append-only (CA-7).
//   --pipeline-dir=PATH   Override de `.pipeline/` (tests).
//   --umbral-muestra=N    Override de `min_sample`.
//   --umbral-tasa=F       Override de `min_contribution_rate` (0..1).
//   --umbral-dias=N       Override de `max_days_without_win`.
//
// Exit codes:
//   0 — reporte emitido.
//   1 — error de IO irrecuperable.
//   2 — ventana sin archivos verificables (todo `no evaluable`; no se decide).
//
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const contribution = require('../lib/multi-provider/provider-contribution');
const auditLog = require('../lib/audit-log');
// rev-2 (#6145) — BLOQUEANTE 4 del review. El repo tiene UN lector canonico de
// `config.yaml` y este CLI se lo estaba salteando con un parser regex propio
// sensible a la indentacion, que ante un YAML valido pero reindentado devolvia
// los defaults SIN avisar. Ese es exactamente el fail-open silencioso que
// `config-resolver` existe para erradicar ("22 lectores de produccion haciendo
// su propio yaml.load"). Contrato para CLIs, textual de su cabecera:
// "mensaje redactado + exit 1, sin defaults silenciosos".
const configResolver = require('../lib/config-resolver');

const AUDIT_FILE = 'provider-permanence.jsonl';

/** Falla explicita de configuracion. `main()` la traduce a exit 1. */
class ConfigUnavailable extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigUnavailable';
        this.code = 'CONFIG_UNAVAILABLE';
    }
}

/**
 * Claves de `multi_provider.quota_alert` que NO son nombres de proveedor.
 * Sin este filtro `defaults` y `preventive_switch` entrarian como proveedores.
 */
const NON_PROVIDER_CONFIG_KEYS = Object.freeze(new Set(['defaults', 'preventive_switch']));

// -----------------------------------------------------------------------------
// parseArgs
// -----------------------------------------------------------------------------

function parseArgs(argv) {
    const out = {
        dias: contribution.DEFAULT_WINDOW_DAYS,
        hasta: null,
        compacto: false,
        json: false,
        registrar: false,
        pipelineDir: path.resolve(__dirname, '..'),
        overrides: {},
        // rev-2 (#6145): un flag mal escrito ya no se ignora en silencio. Un
        // `--umbral-tasa=5` (queriendo decir 5%) corriendo como 0.05 por
        // defecto es la misma clase de fallo que el review encontro en la
        // lectura de config: el operador cree que tuneo y no tuneo nada.
        errors: [],
    };
    const numero = (k, v, { min, max, entero }) => {
        const n = Number(v);
        if (v === null || v === '' || !Number.isFinite(n) || n < min || (max !== undefined && n > max)) {
            out.errors.push(`${k}: valor invalido ${JSON.stringify(v)} (esperado numero`
                + ` entre ${min} y ${max === undefined ? '∞' : max})`);
            return null;
        }
        return entero ? Math.floor(n) : n;
    };
    for (const raw of argv || []) {
        const [k, v] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, null];
        switch (k) {
            case '--dias': {
                const n = numero(k, v, { min: 1, entero: true });
                if (n !== null) out.dias = n;
                break;
            }
            case '--hasta':
                if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) {
                    out.errors.push(`--hasta: formato invalido ${JSON.stringify(v)} (esperado YYYY-MM-DD)`);
                } else {
                    out.hasta = v;
                }
                break;
            case '--compacto': out.compacto = true; break;
            case '--json': out.json = true; break;
            case '--registrar': out.registrar = true; break;
            case '--pipeline-dir': if (v) out.pipelineDir = v; break;
            case '--umbral-muestra': {
                const n = numero(k, v, { min: 0, entero: true });
                if (n !== null) out.overrides.min_sample = n;
                break;
            }
            case '--umbral-tasa': {
                const n = numero(k, v, { min: 0, max: 1 });
                if (n !== null) out.overrides.min_contribution_rate = n;
                break;
            }
            case '--umbral-dias': {
                const n = numero(k, v, { min: 0, entero: true });
                if (n !== null) out.overrides.max_days_without_win = n;
                break;
            }
            default:
                out.errors.push(`opcion desconocida: ${k}`);
                break;
        }
    }
    return out;
}

// -----------------------------------------------------------------------------
// Lecturas auxiliares (best-effort, nunca tiran)
// -----------------------------------------------------------------------------

/**
 * Configuracion del pipeline, por el UNICO lector canonico del repo.
 *
 * rev-2 (#6145) — BLOQUEANTE 4. `resolve()` devuelve la config valida **o
 * lanza** el error tipado (ya redactado: `{archivo, causa, linea, columna}`,
 * sin el snippet crudo de js-yaml). Este CLI NO degrada a defaults ante un
 * fallo de lectura: un umbral que decide quien sale de la cadena no puede salir
 * de un `catch`. La ausencia de la SECCION opcional si es un caso legitimo y se
 * resuelve mas abajo, declarandola en el reporte.
 *
 * `reload: true` esquiva el cache por-archivo del resolver: el CLI puede
 * correrse varias veces en el mismo proceso (tests) contra fixtures distintos.
 */
function readPipelineConfig(pipelineDir, opts = {}) {
    const resolver = opts.configResolver || configResolver;
    try {
        return resolver.resolve({ pipelineDir, reload: true });
    } catch (err) {
        throw new ConfigUnavailable(
            `no se pudo resolver la configuracion del pipeline (${pipelineDir}): ${err.message}`,
        );
    }
}

/**
 * Umbrales de `multi_provider.permanence`.
 *
 * @param {object} cfg  Config ya resuelta por `readPipelineConfig`.
 * @returns {{thresholds: object, source: string, overriddenKeys: string[]}}
 *
 * La seccion ausente NO es un error (config-resolver, "Lo que NO es un error"):
 * es rollout gradual. Pero tampoco es invisible — `source` viaja al reporte y
 * se imprime, para que el operador que tuneo un umbral vea si se aplico o no.
 */
function readThresholds(cfg) {
    const thresholds = { ...contribution.DEFAULT_THRESHOLDS };
    const perm = cfg && cfg.multi_provider && cfg.multi_provider.permanence;
    if (!perm || typeof perm !== 'object' || Array.isArray(perm)) {
        return {
            thresholds,
            source: 'defaults del modulo (multi_provider.permanence ausente de config.yaml)',
            overriddenKeys: [],
        };
    }
    const overriddenKeys = [];
    for (const key of Object.keys(thresholds)) {
        if (Object.prototype.hasOwnProperty.call(perm, key) && perm[key] !== undefined) {
            thresholds[key] = perm[key];
            overriddenKeys.push(key);
        }
    }
    return {
        thresholds,
        source: overriddenKeys.length
            ? `config.yaml -> multi_provider.permanence (${overriddenKeys.join(', ')})`
            : 'defaults del modulo (multi_provider.permanence declarada pero vacia)',
        overriddenKeys,
    };
}

/**
 * Nombres de proveedor con calibracion operativa declarada en `config.yaml`.
 *
 * rev-2 (#6145) — BLOQUEANTE 3. La version anterior barria el YAML con regex y,
 * si el barrido no encontraba nada, devolvia "todos declarados" (fail-OPEN):
 * `kimi-moonshot` dejaba de ser `sin_declarar` y quedaba elegible para
 * `candidato_baja`, justo lo contrario de lo que manda el issue ("presente en
 * el log y ausente de config se reporta como sin_declarar, SIN EXCEPCION") y
 * contra el invariante 4 del modulo ("sin dato => no_evaluable, jamas 'no
 * aporta'"). Ahora sale del objeto ya parseado y falla CERRADO: si no hay
 * bloques por-proveedor, nadie queda declarado y por lo tanto nadie puede ser
 * candidato a baja.
 *
 * @param {object} cfg  Config ya resuelta.
 * @returns {Set<string>}
 */
function readProvidersDeclaredInConfig(cfg) {
    const found = new Set();
    if (!cfg || typeof cfg !== 'object') return found;

    const ttl = cfg.quota_detector && cfg.quota_detector.ttl_by_provider;
    if (ttl && typeof ttl === 'object') {
        for (const name of Object.keys(ttl)) found.add(name);
    }
    const alert = cfg.multi_provider && cfg.multi_provider.quota_alert;
    if (alert && typeof alert === 'object') {
        for (const name of Object.keys(alert)) {
            if (!NON_PROVIDER_CONFIG_KEYS.has(name)) found.add(name);
        }
    }
    return found;
}

/**
 * Proveedores declarados. Un proveedor esta plenamente declarado cuando
 * aparece en DOS lugares:
 *
 *   1. `agent-models.json` — de donde sale `billing` (paid/free).
 *   2. `config.yaml` — donde vive su calibracion operativa (TTL de cuota,
 *      umbrales de alerta). Sin esto el criterio lo evaluaria contra umbrales
 *      inexistentes.
 *
 * `kimi-moonshot` es el caso real: participa del dispatch y esta en
 * `agent-models.json`, pero **no** en `config.yaml` (#6153). Por eso su
 * veredicto es `sin_declarar` y nunca `candidato_baja`.
 *
 * `agent-models.json` ilegible tambien es una falla EXPLICITA (rev-2): sin
 * `billing` no se puede sostener el invariante "nunca marca a un pago".
 */
function readDeclaredProviders(pipelineDir, fsImpl, cfg) {
    const _fs = fsImpl || fs;
    const out = Object.create(null);
    const inConfig = readProvidersDeclaredInConfig(cfg);
    const file = path.join(pipelineDir, 'agent-models.json');
    let parsed;
    try {
        if (!_fs.existsSync(file)) {
            throw new ConfigUnavailable(`agent-models.json ausente en ${pipelineDir}`);
        }
        parsed = JSON.parse(_fs.readFileSync(file, 'utf8'));
    } catch (err) {
        if (err instanceof ConfigUnavailable) throw err;
        throw new ConfigUnavailable(`agent-models.json ilegible en ${pipelineDir}: ${err.message}`);
    }
    for (const [name, def] of Object.entries((parsed && parsed.providers) || {})) {
        // `deterministic` no es un proveedor de la cadena LLM: es el
        // ejecutor local sin modelo. No participa del criterio.
        if (name === 'deterministic') continue;
        out[name] = {
            billing: def && def.billing ? def.billing : null,
            model: def && def.model,
            // FAIL-CLOSED: sin evidencia de declaracion, NO declarado.
            declaredInConfig: inConfig.has(name),
        };
    }
    return out;
}

function readHealthSnapshot(pipelineDir, fsImpl) {
    const _fs = fsImpl || fs;
    const file = path.join(pipelineDir, 'state', 'multi-provider-health.json');
    try {
        if (!_fs.existsSync(file)) return null;
        const parsed = JSON.parse(_fs.readFileSync(file, 'utf8'));
        return parsed && Array.isArray(parsed.providers) ? parsed : null;
    } catch {
        return null;
    }
}

// -----------------------------------------------------------------------------
// buildReport — nucleo puro
// -----------------------------------------------------------------------------

function buildReport(opts) {
    const _fs = opts.fsImpl || fs;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const to = opts.hasta ? Date.parse(`${opts.hasta}T23:59:59.999Z`) : now;
    const toMs = Number.isFinite(to) ? to : now;
    const from = toMs - opts.dias * contribution.MS_PER_DAY;

    const { entries, integrity } = contribution.readWindow({
        pipelineDir: opts.pipelineDir,
        from,
        to: toMs,
        fsImpl: _fs,
        auditLog: opts.auditLog || auditLog,
    });

    const healthSnapshot = readHealthSnapshot(opts.pipelineDir, _fs);

    // Config por el lector canonico. Si no resuelve, esto LANZA: `main()` lo
    // convierte en exit 1 con mensaje redactado. Nunca defaults silenciosos.
    const cfg = opts.config || readPipelineConfig(opts.pipelineDir, opts);
    const declared = opts.declared || readDeclaredProviders(opts.pipelineDir, _fs, cfg);
    const base = readThresholds(cfg);
    const overrides = opts.overrides || {};
    const thresholds = { ...base.thresholds, ...overrides };
    const overrideKeys = Object.keys(overrides);

    const metrics = contribution.computeContribution(entries, { now, healthSnapshot });
    const verdicts = contribution.evaluatePermanence(metrics, thresholds, {
        chainOk: integrity.chainOk,
        noData: integrity.noData,
        declared,
        now,
    });
    const failoverCost = contribution.computeFailoverCost(entries);

    return {
        computedAt: new Date(now).toISOString(),
        window: {
            days: opts.dias,
            from: new Date(from).toISOString(),
            to: new Date(toMs).toISOString(),
            hasta: opts.hasta || null,
        },
        source: '.pipeline/logs/cross-provider-dispatch-*.jsonl',
        integrity,
        thresholds,
        // rev-2 (#6145): de donde salio CADA umbral. El review probo que un
        // config valido pero reindentado corria con los defaults sin una sola
        // advertencia; ahora la procedencia es parte del reporte.
        thresholdsSource: overrideKeys.length
            ? `${base.source} + overrides de linea de comando (${overrideKeys.join(', ')})`
            : base.source,
        // Latencia: se reporta el ultimo live-ping, NO una mediana (CA-1 queda
        // parcialmente abierto por falta de instrumentacion — #6152).
        latencyDisclaimer: 'La columna de latencia es el ULTIMO live-ping del snapshot de salud, '
            + 'no una mediana de la ventana: el log de dispatch no registra latencia por '
            + 'invocacion. Es volatil (mismo proveedor, mismo dia: 15,9 s / 2,3 s / 1,26 s) y '
            + 'NINGUN veredicto de este reporte se apoya en ella. La mediana real requiere '
            + 'instrumentar latencia por invocacion: #6152.',
        metrics,
        verdicts,
        failoverCost,
        table: contribution.renderMarkdownTable(metrics, { verdicts, compact: opts.compacto }),
        conclusion: buildConclusion({
            verdicts, integrity, failoverCost, declared, window: { from, to: toMs },
        }),
    };
}

/**
 * CA-UX-3 — la conclusion PRECEDE a la evidencia y esta en lenguaje
 * llano. Si nadie sale de la cadena, esa frase aparece literal y primera.
 */
function buildConclusion(ctx) {
    const { verdicts, integrity, failoverCost } = ctx;
    const V = contribution.VERDICT;
    const all = Object.values(verdicts);
    const by = (v) => all.filter((x) => x.verdict === v).map((x) => x.provider).sort();

    const candidatos = by(V.CANDIDATO_BAJA);
    const acotados = by(V.ROL_ACOTADO);
    const mantener = by(V.MANTENER);
    const noEval = by(V.NO_EVALUABLE);
    const sinDeclarar = by(V.SIN_DECLARAR);

    const lines = [];
    lines.push(
        candidatos.length === 0
            ? 'No se propone dar de baja a ningún proveedor en esta ventana.'
            : `Se proponen como candidatos a baja: ${candidatos.join(', ')}.`,
    );
    if (mantener.length) lines.push(`Se mantienen sin cambios: ${mantener.join(', ')}.`);
    if (acotados.length) {
        lines.push(
            `Quedan con rol acotado (aportan poco por una causa propia, no del proveedor): ${acotados.join(', ')}.`,
        );
    }
    if (noEval.length) {
        lines.push(`Sin muestra suficiente para decidir (no evaluable, nunca "no aporta"): ${noEval.join(', ')}.`);
    }
    if (sinDeclarar.length) {
        lines.push(`Despachan pero no están declarados en configuración (#6153): ${sinDeclarar.join(', ')}.`);
    }
    if (failoverCost && failoverCost.scheduleGating && failoverCost.scheduleGating.pct !== null) {
        // rev-3 (#6145) — la frase decía "política horaria" sumando adentro los
        // `fallback_also_gated`, que son cupo del proveedor. Ahora cada causa se
        // nombra por separado y el operador ve las dos cifras reales.
        const pctH = String(failoverCost.scheduleGating.pct).replace('.', ',');
        const pctC = failoverCost.quotaFlagGating && failoverCost.quotaFlagGating.pct !== null
            ? String(failoverCost.quotaFlagGating.pct).replace('.', ',')
            : null;
        lines.push(
            `El ${pctH} % del gating de la ventana es política horaria, no proveedores muertos: `
            + 'ese costo no es imputable a los gratuitos.'
            + (pctC !== null
                ? ` Otro ${pctC} % es el flag de cuota agotada del propio proveedor `
                  + '(un corte emite un evento por cada intento de dispatch mientras dura, '
                  + 'así que la cifra mide la duración del corte y no cuántas veces el proveedor se negó).'
                : ''),
        );
    }
    if (failoverCost && failoverCost.operatorGating && failoverCost.operatorGating.events > 0) {
        // rev-3 (#6145) — el kill-switch del operador se publicaba como 0.
        lines.push(
            `Hubo ${failoverCost.operatorGating.events} saltos porque NOSOTROS apagamos el proveedor `
            + `(${failoverCost.operatorGating.killSwitch} por kill-switch manual, `
            + `${failoverCost.operatorGating.pacing} por freno de ritmo). No bajan la tasa de aporte de nadie: `
            + 'un proveedor apagado a mano no es un proveedor que no aporta (REQ-SEC-3).',
        );
    }
    // rev-2 (#6145): "sin datos" y "cadena rota" dejan de ser la misma frase.
    if (integrity.noData) {
        lines.push(
            'ATENCIÓN: no hay ni un archivo de dispatch en la ventana pedida. '
            + 'No es que la cadena de hash haya fallado: no hay nada que verificar. '
            + 'Por eso ningún proveedor es evaluable y no se decide nada.',
        );
    } else if (!integrity.chainOk) {
        lines.push(
            'ATENCIÓN: la cadena de hash de la ventana no verificó '
            + `(${integrity.brokenFiles.length} archivo/s con integridad rota: `
            + `${integrity.brokenFiles.join(', ')}). `
            + 'Por eso ningún proveedor es evaluable y no se decide nada.',
        );
    }
    // rev-2: si NADIE quedó declarado en configuración, el criterio no puede
    // evaluar a nadie. Es la dirección segura del fail-closed, pero tiene que
    // decirse: si no, un reporte inservible se lee como "todo en orden".
    const declaredCount = Object.values(ctx.declared || {}).filter((d) => d.declaredInConfig).length;
    if (Object.keys(ctx.declared || {}).length > 0 && declaredCount === 0) {
        lines.push(
            'ATENCIÓN: ningún proveedor tiene calibración operativa en config.yaml '
            + '(quota_detector.ttl_by_provider / multi_provider.quota_alert). El criterio '
            + 'falla cerrado: todos quedan "sin declarar" y ninguno puede ser candidato a baja.',
        );
    }
    const unclas = failoverCost && failoverCost.unclassified;
    if (unclas && unclas.events > 0) {
        lines.push(
            `Nota de taxonomía: ${unclas.events} evento/s de la ventana no pertenecen a ninguna `
            + `familia conocida (${Object.keys(unclas.byEvent).join(', ')}). Están contados en el `
            + 'total y no se imputan a ningún proveedor.',
        );
    }
    return lines;
}

// -----------------------------------------------------------------------------
// Render para humanos (CA-UX-3/4/6)
// -----------------------------------------------------------------------------

const RULE = '═'.repeat(76);

function renderHuman(report, argvLine) {
    const out = [];
    out.push(RULE);
    out.push(' APORTE REAL POR PROVEEDOR — ventana '
        + `${report.window.from.slice(0, 10)} → ${report.window.to.slice(0, 10)} (${report.window.days} días)`);
    out.push(` Fuente: ${report.source}  ·  hash-chain: ${report.integrity.chainOk ? 'OK' : 'ROTA'}`
        + ` (${report.integrity.filesChecked} archivo/s)`);
    // CA-UX-6 — el comando exacto que regenera el reporte, copiable tal cual.
    out.push(` Regenerar: ${argvLine}`);
    out.push(RULE);
    out.push('');
    out.push(' CONCLUSIÓN');
    report.conclusion.forEach((l, i) => out.push(` ${i + 1}. ${l}`));
    out.push('');
    out.push(report.table);
    out.push('');
    out.push(' COSTO DE FAILOVER POR CAUSA (CA-2) — el total NO es culpa de los gratuitos');
    const fc = report.failoverCost;
    const bucket = (label, b) => `   ${label.padEnd(26, '.')} ${String(b.events).padStart(7)} eventos`
        + ` (${b.pct === null ? contribution.ABSENCE.SIN_MUESTRA : String(b.pct).replace('.', ',')} %)`;
    out.push(bucket('política horaria ', fc.scheduleGating));
    // rev-3 (#6145) — `fallback_also_gated` salió de "política horaria": es el
    // flag de cuota agotada del proveedor, y va con su nombre real.
    out.push(bucket('cupo del proveedor (flag) ', fc.quotaFlagGating));
    out.push(bucket('kill-switch del operador ', fc.operatorGating)
        + ` [manual ${fc.operatorGating.killSwitch} · ritmo ${fc.operatorGating.pacing}]`);
    out.push(bucket('bloqueo por proveedor ', fc.providerBlocking));
    out.push(bucket('dispatch resuelto ', fc.wins));
    out.push(bucket('eventos de cadena ', fc.chainExhausted));
    out.push(bucket('fuera de taxonomía ', fc.unclassified));
    out.push(`   ${'TOTAL'.padEnd(26, '.')} ${String(fc.totalEvents).padStart(7)} eventos`
        + `  ·  los buckets ${fc.reconciles ? 'CIERRAN' : 'NO CIERRAN'} contra el total`);
    out.push('');
    out.push(' MOTIVO DEL VEREDICTO POR PROVEEDOR');
    for (const v of Object.values(report.verdicts).sort((a, b) => (a.provider < b.provider ? -1 : 1))) {
        out.push(`   ${v.provider}: ${v.verdictLabel}`);
        for (const r of v.reasons) out.push(`     · ${r}`);
    }
    out.push('');
    out.push(` Umbrales aplicados: min_sample=${report.thresholds.min_sample}`
        + ` · min_contribution_rate=${report.thresholds.min_contribution_rate}`
        + ` · max_days_without_win=${report.thresholds.max_days_without_win}`
        + ` · min_survivors=${report.thresholds.min_survivors}`
        + ` · enabled=${report.thresholds.enabled}`);
    // rev-2 (#6145): la PROCEDENCIA del umbral se imprime siempre. Sin esto, un
    // operador que tuneó `min_contribution_rate` no tenía forma de notar que el
    // reporte estaba corriendo con los defaults del módulo.
    out.push(` Procedencia de los umbrales: ${report.thresholdsSource}`);
    out.push('');
    out.push(` Sobre la latencia: ${report.latencyDisclaimer}`);
    out.push('');
    out.push(' Este reporte MARCA candidatos; no da de baja a nadie. La baja es un PR de configuración.');
    return out.join('\n');
}

// -----------------------------------------------------------------------------
// Audit append-only (CA-7: la decision queda registrada de forma trazable)
// -----------------------------------------------------------------------------

function registrarDecision(report, opts) {
    const _fs = opts.fsImpl || fs;
    const _auditLog = opts.auditLog || auditLog;
    const file = path.join(opts.pipelineDir, 'audit', AUDIT_FILE);
    try {
        _fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch { /* best-effort */ }

    // SOLO metadatos y veredictos (REQ-SEC-1): nada de texto de prompts.
    const entry = {
        event: 'provider_permanence_evaluated',
        issue: '6145',
        window_from: report.window.from,
        window_to: report.window.to,
        window_days: report.window.days,
        source: report.source,
        chain_ok: report.integrity.chainOk,
        files_checked: report.integrity.filesChecked,
        broken_files: report.integrity.brokenFiles,
        thresholds: report.thresholds,
        verdicts: Object.fromEntries(
            Object.values(report.verdicts).map((v) => [v.provider, {
                verdict: v.verdict,
                declared: v.declared,
                billing: v.billing,
                evidence: v.evidence,
            }]),
        ),
        executed_action: 'none',   // CA-6/REQ-SEC-3: marca, no ejecuta.
    };
    // Append-only con hash-chain. NUNCA `writeFileSync` sobre este path.
    return _auditLog.appendChained({ file, entry, fsImpl: _fs });
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

function main(argv, deps = {}) {
    const stdout = deps.stdout || process.stdout;
    const stderr = deps.stderr || process.stderr;
    const args = { ...parseArgs(argv || process.argv.slice(2)), ...(deps.args || {}) };
    if (args.errors && args.errors.length) {
        for (const e of args.errors) {
            stderr.write(`[provider-contribution-report] ${e}\n`);
        }
        return 1;
    }
    let report;
    try {
        report = buildReport(args);
    } catch (err) {
        // Contrato de config-resolver para CLIs: mensaje redactado + exit 1.
        // NO se degrada a defaults ni se emite un reporte a medias.
        stderr.write(`[provider-contribution-report] ${err.message}\n`);
        return 1;
    }

    if (args.registrar) {
        try {
            registrarDecision(report, args);
        } catch (err) {
            stderr.write(`[provider-contribution-report] audit: ${err.message}\n`);
        }
    }

    if (args.json) {
        stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
        stdout.write(`${renderHuman(report, reproducibleCommand(args))}\n`);
    }

    return report.integrity.chainOk ? 0 : 2;
}

/**
 * CA-UX-6 — el comando EXACTO que regenera este reporte, copiable tal cual.
 *
 * rev-2 (#6145): antes omitía `--hasta`, con lo cual el comando "reproducible"
 * daba OTRA ventana y OTROS números en cuanto pasaba un día. Ahora emite todos
 * los flags que cambian el resultado, incluidos los overrides de umbral.
 */
function reproducibleCommand(args) {
    const parts = ['node .pipeline/scripts/provider-contribution-report.js', `--dias=${args.dias}`];
    if (args.hasta) parts.push(`--hasta=${args.hasta}`);
    if (args.compacto) parts.push('--compacto');
    const ov = args.overrides || {};
    if (ov.min_sample !== undefined) parts.push(`--umbral-muestra=${ov.min_sample}`);
    if (ov.min_contribution_rate !== undefined) parts.push(`--umbral-tasa=${ov.min_contribution_rate}`);
    if (ov.max_days_without_win !== undefined) parts.push(`--umbral-dias=${ov.max_days_without_win}`);
    return parts.join(' ');
}

module.exports = {
    parseArgs,
    readPipelineConfig,
    readThresholds,
    readProvidersDeclaredInConfig,
    readDeclaredProviders,
    readHealthSnapshot,
    buildReport,
    buildConclusion,
    renderHuman,
    reproducibleCommand,
    registrarDecision,
    main,
    AUDIT_FILE,
    ConfigUnavailable,
    NON_PROVIDER_CONFIG_KEYS,
};

if (require.main === module) {
    process.exitCode = main();
}
