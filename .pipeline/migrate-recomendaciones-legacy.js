#!/usr/bin/env node
// =============================================================================
// migrate-recomendaciones-legacy.js — Migración del backlog legacy de #5678
// (parte 3 de 3, issue #5691). REESCRITO EN BLOQUE: la versión previa (#2653,
// commit ff077b2d1) hacía exactamente lo contrario — AGREGABA `needs-human` +
// `tipo:recomendacion` detectando candidatos por heurística de título.
//
// QUÉ HACE
// --------
// Toma el candidate set legacy —issues abiertos que tienen `needs-human` Y
// `tipo:recomendacion` y NO tienen `recommendation:approved`— y los mueve a la
// cola de triaje: agrega `needs:triage-backlog` y remueve `needs-human`, de
// modo que la notificación de bloqueo real deje de nacer ahogada en ruido de
// backlog.
//
// 🔴 BYPASS AUDITADO DEL CHOKE POINT DE `servicio-github.js` (#5690)
// -----------------------------------------------------------------
// El invariante que #5690 blindó es: *nadie remueve `needs-human` sin origen
// autorizado declarado*. La operación central de este módulo es exactamente
// eso, N veces seguidas. Este migrador NO pasa por la cola de `servicio-github`
// —el único consumidor de `lib/label-guardrail.js`— y va directo a `gh`. Es una
// decisión deliberada, por dos razones:
//
//   (i)  la cola modela UNA ACCIÓN POR ORDEN (`case 'label'` y
//        `case 'remove-label'` son ramas distintas), así que "una sola
//        secuencia fail-safe add→remove por issue" no es expresable por esa
//        ruta; y
//   (ii) enrutar por la cola no evita nada: el guardrail seguiría exigiendo la
//        misma declaración de procedencia que este módulo hace explícita.
//
// La contrapartida es obligatoria y está implementada acá: **antes de cada
// remoción de `needs-human` se invoca `evaluateLabelOrder()` con procedencia
// declarada** (`guardrail_authorized: true`, `authorized_by: 'migracion-5678'`),
// y el `authorizedBy` que devuelve el guardrail se persiste en el registro
// `intent` del write-ahead log. Sin eso, el WAL no podría responder *"quién
// autorizó"*, que es justo para lo que el guardrail existe. Si el veredicto es
// `allowed: false`, la corrida ENTERA aborta — nunca se saltea el ítem.
//
// SEGURIDAD (auditorías de `security` sobre #5678/#5691)
// -----------------------------------------------------
//  · SEC-3  — predicado EXCLUSIVAMENTE por label. No hay `TITLE_RE` ni
//             `AGENT_LABEL_RE`: el título de un issue es entrada no confiable.
//  · REQ-SEC-2 — `--apply` exige, además del flag, una confirmación fuera de
//             banda no automatizable (env `MIGRATE_5678_CONFIRM` que debe
//             coincidir con un secreto guardado FUERA del repo). Si falta,
//             degrada a dry-run (fail-closed, nunca al revés).
//  · REQ-SEC-3 — redacción con `redactSecretValue()` (NUNCA `redactSensitive()`,
//             que deja el valor del token en claro) sobre stdout, stderr y el
//             registro COMPLETO antes de persistirlo.
//  · REQ-SEC-4 — un label por flag, jamás CSV: `--add-label "a,b"` aplica DOS
//             labels y los nombres los controla cualquiera con permiso de
//             escritura en el repo. Vale para la migración Y para la reversión.
//  · REQ-SEC-5 — TOCTOU: se re-leen los labels y se re-evalúa el predicado
//             completo inmediatamente antes de mutar. Si ya no califica →
//             `skipped` (no abort: un cambio legítimo no es una query mala).
//  · REQ-SEC-6 — el WAL vive en `.pipeline/audit/` (gitignoreado) dentro de un
//             repo sometido a `reset --hard`: al terminar se copia fuera del
//             árbol del repo. Perder el WAL es perder la reversibilidad.
//  · REQ-SEC-D — sin `--token` por argv; `--repo` validado contra regex.
//  · Orden fail-safe — se AGREGA `needs:triage-backlog` y recién después se
//             REMUEVE `needs-human`, en dos invocaciones. Una falla intermedia
//             deja el issue con AMBOS labels (recuperable) y nunca sin ninguno.
//
// ⚠️ NO usar `isRecommendationIssue()` de `recommendation-labels.js`: ese helper
// devuelve `true` con `source:recommendation` sola, y el candidate set exige
// `tipo:recomendacion` ESPECÍFICAMENTE. Usarlo metería issues fuera del set y
// haría saltar el assert de aborto de este mismo módulo. Sí se importa la
// CONSTANTE `RECOMMENDATION_APPROVED_LABEL` para no hardcodear el string.
//
// USO
// ---
//   node .pipeline/migrate-recomendaciones-legacy.js                  # dry-run
//   MIGRATE_5678_CONFIRM=<token> node .pipeline/migrate-recomendaciones-legacy.js --apply
//   node .pipeline/migrate-recomendaciones-legacy.js --revert <wal.jsonl>
// =============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const {
    RECOMMENDATION_APPROVED_LABEL,
    normalizeLabelNames,
} = require('./lib/recommendation-labels');
const guardrail = require('./lib/label-guardrail');
const { redactSecretValue, SECRET_VALUE_PATTERNS } = require('./lib/redact');

// --- Constantes de dominio ---------------------------------------------------

const NEEDS_HUMAN_LABEL = 'needs-human';
const TIPO_RECOMENDACION_LABEL = 'tipo:recomendacion';
const TRIAGE_BACKLOG_LABEL = 'needs:triage-backlog';

// Procedencia declarada ante el guardrail de #5690 (ver header, G-A).
const AUTHORIZED_BY = 'migracion-5678';

// REQ-SEC-D — `--repo` es `owner/name`, nada más.
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

const DEFAULT_REPO = 'intrale/platform';
const PER_PAGE = 100;

// Rate limit de mutaciones (bucket de abuse detection secundario de GitHub).
const MAX_MUTACIONES_POR_MINUTO = 30;
const VENTANA_RATE_LIMIT_MS = 60_000;

// Backoff exponencial ante HTTP 403 (abuse detection). Con un candidate set
// chico no se ejercita nunca en producción: se prueba con fixture.
const BACKOFF_MAX_INTENTOS = 5;
const BACKOFF_BASE_MS = 1_000;

// Labels que indican que el issue está en el FLUJO de trabajo del pipeline y no
// es una recomendación de agente pura (G-B menor). Cumplen el predicado y van a
// ser mutados —es lo correcto según el contrato— pero el dry-run los lista
// aparte para que el operador los revise antes del `--apply`: un bug reportado
// que queda enterrado en la cola de triaje es un daño silencioso.
const LABELS_FLUJO_PIPELINE = Object.freeze([
    'needs-definition', 'Ready', 'ready', 'in-progress', 'bug',
]);

// Nombre del archivo con el secreto de confirmación fuera de banda (REQ-SEC-2).
// Vive FUERA del árbol del repo a propósito: un agente que lee el repositorio
// no puede derivarlo, y un `reset --hard` no lo toca.
const CONFIRM_FILE_DEFAULT = path.join(os.homedir(), '.claude', 'secrets', 'migrate-5678-confirm.txt');

const AUDIT_DIR_DEFAULT = path.join(__dirname, 'audit');

// Error que corta la corrida ENTERA (nunca se saltea el ítem).
class AbortoMigracion extends Error {
    constructor(motivo, detalle) {
        super(motivo);
        this.name = 'AbortoMigracion';
        this.motivo = motivo;
        this.detalle = detalle || null;
    }
}

// --- Predicado ---------------------------------------------------------------

/**
 * ¿El issue pertenece al candidate set legacy de #5678?
 *
 * EXCLUSIVAMENTE por label (SEC-3). Sin heurística de título ni de label de
 * agente: el título lo escribe cualquiera y es entrada no confiable.
 *
 * @param {Array<string|{name?:string}>} labels
 * @returns {boolean}
 */
function esCandidato(labels) {
    const names = normalizeLabelNames(labels);
    return names.includes(NEEDS_HUMAN_LABEL) &&
        names.includes(TIPO_RECOMENDACION_LABEL) &&
        !names.includes(RECOMMENDATION_APPROVED_LABEL);
}

/**
 * ¿El candidato lleva labels del flujo de trabajo del pipeline? (G-B menor)
 * @param {Array<string|{name?:string}>} labels
 * @returns {boolean}
 */
function esCandidatoNoRecomendacion(labels) {
    const names = normalizeLabelNames(labels);
    return LABELS_FLUJO_PIPELINE.some((l) => names.includes(l));
}

// --- Runner de `gh` ----------------------------------------------------------

/**
 * Runner por defecto. `spawnSync` con ARRAY de argumentos y SIN `shell: true`:
 * es lo que corta la inyección vía título hostil. No migrar a `execSync` con
 * template string (A5).
 *
 * @param {string[]} args
 * @returns {{ok:boolean, stdout:string, stderr:string, status:(number|null)}}
 */
function defaultGhRunner(args) {
    const bin = process.env.GH_PATH || 'gh';
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 120_000, shell: false });
    return {
        ok: r.status === 0,
        stdout: r.stdout || '',
        stderr: r.stderr || '',
        status: typeof r.status === 'number' ? r.status : null,
    };
}

// --- Redacción (REQ-SEC-3) ---------------------------------------------------

/**
 * Reemplazo LITERAL del valor de los tokens del entorno + patrones por
 * proveedor. En el stderr de `gh` aparece el VALOR del token, nunca el nombre
 * de la variable: redactar por nombre de variable no redacta nada.
 *
 * @param {string} s
 * @returns {string}
 */
function redactarTexto(s) {
    if (typeof s !== 'string' || s.length === 0) return s;
    let out = s;
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']) {
        const v = process.env[name];
        if (typeof v === 'string' && v.length >= 8) out = out.split(v).join('[REDACTED]');
    }
    return redactSecretValue(out);
}

/**
 * Red final sobre la LÍNEA ya serializada: aplica sólo los patrones de secreto
 * (sin la heurística de entropía whole-string, que sobre un JSON compacto
 * daría falso positivo y borraría el registro entero).
 *
 * @param {string} linea
 * @returns {string}
 */
function redactarLinea(linea) {
    let out = String(linea);
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']) {
        const v = process.env[name];
        if (typeof v === 'string' && v.length >= 8) out = out.split(v).join('[REDACTED]');
    }
    for (const { re, topology } of SECRET_VALUE_PATTERNS) {
        if (topology) continue;
        out = out.replace(re, '[REDACTED]');
    }
    return out;
}

/**
 * Walk recursivo: redacta TODOS los valores string del registro, no sólo la
 * rama de error.
 * @param {*} valor
 * @returns {*}
 */
function redactarRegistro(valor) {
    if (typeof valor === 'string') return redactarTexto(valor);
    if (Array.isArray(valor)) return valor.map(redactarRegistro);
    if (valor && typeof valor === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(valor)) out[k] = redactarRegistro(v);
        return out;
    }
    return valor;
}

// --- Write-ahead log (sección C) ---------------------------------------------

/**
 * Path del WAL de una corrida. `.pipeline/audit/` está gitignoreado.
 * @param {{dir?:string, ts?:string}} [opts]
 * @returns {string}
 */
function walPathFor({ dir = AUDIT_DIR_DEFAULT, ts = new Date().toISOString() } = {}) {
    const slug = String(ts).replace(/[:.]/g, '-');
    return path.join(dir, `migrate-5678-${slug}.jsonl`);
}

/**
 * Escribe un registro en el WAL. `appendFileSync` en modo append, NUNCA
 * `writeFileSync`: el WAL es la única vía de reversión y de reanudación.
 *
 * @param {string} walFile
 * @param {object} rec
 * @returns {object} el registro tal cual quedó persistido (ya redactado)
 */
function appendWal(walFile, rec) {
    const conTs = { ts: new Date().toISOString(), ...rec };
    const redactado = redactarRegistro(conTs);
    const linea = redactarLinea(JSON.stringify(redactado)) + '\n';
    fs.mkdirSync(path.dirname(walFile), { recursive: true });
    fs.appendFileSync(walFile, linea, 'utf8');
    return redactado;
}

/**
 * Lee un WAL y devuelve sus registros. Tolera líneas corruptas (una corrida
 * cortada a mitad de escritura no debe volver el log ilegible).
 * @param {string} walFile
 * @returns {object[]}
 */
function leerWal(walFile) {
    if (!fs.existsSync(walFile)) return [];
    const out = [];
    for (const linea of fs.readFileSync(walFile, 'utf8').split('\n')) {
        const s = linea.trim();
        if (!s) continue;
        try { out.push(JSON.parse(s)); } catch { /* línea truncada por un corte */ }
    }
    return out;
}

/**
 * Issues ya migrados con éxito, para reanudar sin repetir (C4).
 * @param {object[]} registros
 * @returns {Set<number>}
 */
function issuesCompletados(registros) {
    const out = new Set();
    for (const r of registros) {
        if (r && r.status === 'ok' && Number.isFinite(Number(r.issue))) out.add(Number(r.issue));
    }
    return out;
}

/**
 * Estado previo de cada issue mutado con éxito, para revertir (C5).
 * @param {object[]} registros
 * @returns {Map<number, string[]>}
 */
function estadoPrevioDesdeWal(registros) {
    const intents = new Map();
    for (const r of registros) {
        if (r && r.status === 'intent' && Array.isArray(r.labels_antes)) {
            intents.set(Number(r.issue), r.labels_antes.map(String));
        }
    }
    const out = new Map();
    for (const num of issuesCompletados(registros)) {
        if (intents.has(num)) out.set(num, intents.get(num));
    }
    return out;
}

/**
 * Candidate set congelado en el `run-start` (C2). Es el conjunto sobre el que
 * se evalúan idempotencia y cierre (D4).
 * @param {object[]} registros
 * @returns {{startedAt:(string|null), candidateSet:number[]}}
 */
function runStartDesdeWal(registros) {
    const h = registros.find((r) => r && r.tipo === 'run-start');
    if (!h) return { startedAt: null, candidateSet: [] };
    return {
        startedAt: h.started_at || h.ts || null,
        candidateSet: Array.isArray(h.candidate_set) ? h.candidate_set.map(Number) : [],
    };
}

// --- Confirmación fuera de banda (REQ-SEC-2) ---------------------------------

/**
 * `--apply` no debe ser alcanzable por un agente. Los agentes ejecutan Bash y
 * leen issues de GitHub (entrada no confiable), así que un script versionado
 * que desarma el gate humano en masa es objetivo directo de prompt injection.
 *
 * El secreto esperado vive FUERA del árbol del repo: leer el repositorio no
 * alcanza para derivarlo. Si no está, o no coincide, se DEGRADA A DRY-RUN
 * (fail-closed, nunca al revés).
 *
 * @param {{env?:object, confirmFile?:string}} [opts]
 * @returns {{ok:boolean, motivo:string}}
 */
function verificarConfirmacion({ env = process.env, confirmFile = CONFIRM_FILE_DEFAULT } = {}) {
    const provisto = typeof env.MIGRATE_5678_CONFIRM === 'string' ? env.MIGRATE_5678_CONFIRM.trim() : '';
    if (!provisto) return { ok: false, motivo: 'falta-env-MIGRATE_5678_CONFIRM' };

    const file = (typeof env.MIGRATE_5678_CONFIRM_FILE === 'string' && env.MIGRATE_5678_CONFIRM_FILE.trim())
        ? env.MIGRATE_5678_CONFIRM_FILE.trim()
        : confirmFile;

    let esperado = '';
    try { esperado = fs.readFileSync(file, 'utf8').trim(); } catch { esperado = ''; }
    if (!esperado) return { ok: false, motivo: 'falta-secreto-fuera-de-banda' };

    const a = Buffer.from(provisto, 'utf8');
    const b = Buffer.from(esperado, 'utf8');
    // Comparación de longitud constante sobre digests: `timingSafeEqual` exige
    // buffers del mismo largo, y comparar largos filtra información.
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    if (!crypto.timingSafeEqual(ha, hb)) return { ok: false, motivo: 'confirmacion-no-coincide' };
    return { ok: true, motivo: 'confirmacion-valida' };
}

// --- Listado paginado (A6) ---------------------------------------------------

/**
 * `gh api --paginate` sobre un endpoint que devuelve arrays emite un array JSON
 * por página, concatenados sin separador (`[...][...]`). Este scanner los
 * parsea todos, y también soporta la forma de un único array.
 *
 * @param {string} stdout
 * @returns {object[]}
 */
function parseJsonArrays(stdout) {
    const s = String(stdout || '');
    const out = [];
    let i = 0;
    while (i < s.length) {
        while (i < s.length && s[i] !== '[') i++;
        if (i >= s.length) break;
        let depth = 0;
        let inStr = false;
        let esc = false;
        let j = i;
        for (; j < s.length; j++) {
            const c = s[j];
            if (inStr) {
                if (esc) esc = false;
                else if (c === '\\') esc = true;
                else if (c === '"') inStr = false;
                continue;
            }
            if (c === '"') inStr = true;
            else if (c === '[') depth++;
            else if (c === ']') {
                depth--;
                if (depth === 0) { j++; break; }
            }
        }
        const trozo = s.slice(i, j);
        try {
            const arr = JSON.parse(trozo);
            if (Array.isArray(arr)) out.push(...arr);
        } catch { /* fragmento incompleto: se ignora */ }
        i = j;
    }
    return out;
}

/**
 * Lista el candidate set paginando hasta agotarlo.
 *
 * Se usa el REST de listado y no la Search API: el REST hace AND por labels y
 * no tiene el techo de 1000 resultados. Se filtran los `pull_request`, porque
 * el REST de issues incluye PRs.
 *
 * @param {{ghRunner?:function, repo?:string}} [opts]
 * @returns {{items:Array<{number:number,title:string,labels:string[],createdAt:(string|null)}>}}
 */
function listarCandidatos({ ghRunner = defaultGhRunner, repo = DEFAULT_REPO } = {}) {
    const endpoint = `repos/${repo}/issues?state=open&labels=${encodeURIComponent(`${NEEDS_HUMAN_LABEL},${TIPO_RECOMENDACION_LABEL}`)}&per_page=${PER_PAGE}`;
    const r = ghRunner(['api', '--paginate', endpoint]);
    if (!r.ok) {
        throw new AbortoMigracion('listado-fallido', redactarTexto(r.stderr || `gh exit ${r.status}`));
    }
    const crudos = parseJsonArrays(r.stdout).filter((it) => it && !it.pull_request);
    const items = crudos.map((it) => ({
        number: Number(it.number),
        title: String(it.title || ''),
        labels: normalizeLabelNames(it.labels),
        createdAt: it.created_at || it.createdAt || null,
    }));
    return { items };
}

/**
 * Total del candidate set según la Search API, para el cross-check del dry-run.
 * @param {{ghRunner?:function, repo?:string}} [opts]
 * @returns {number|null} null si la consulta falla
 */
function contarPorSearch({ ghRunner = defaultGhRunner, repo = DEFAULT_REPO } = {}) {
    const q = `repo:${repo} is:open is:issue label:${NEEDS_HUMAN_LABEL} label:${TIPO_RECOMENDACION_LABEL}`;
    // `-X GET` es obligatorio: `gh api` con `-f` hace POST por default y la
    // Search API responde 404 a un POST (verificado, no asumido).
    const r = ghRunner(['api', '-X', 'GET', 'search/issues', '-f', `q=${q}`, '--jq', '.total_count']);
    if (!r.ok) return null;
    const n = Number(String(r.stdout).trim());
    return Number.isFinite(n) ? n : null;
}

// --- Rate limit y backoff (A11) ----------------------------------------------

/**
 * Milisegundos a esperar antes de la próxima mutación para no exceder el
 * límite de la ventana móvil.
 * @param {number[]} timestamps mutaciones ya hechas (ms epoch)
 * @param {number} ahora
 * @param {number} [max]
 * @returns {number}
 */
function esperaPorRateLimit(timestamps, ahora, max = MAX_MUTACIONES_POR_MINUTO) {
    const enVentana = timestamps.filter((t) => ahora - t < VENTANA_RATE_LIMIT_MS);
    if (enVentana.length < max) return 0;
    const masViejo = Math.min(...enVentana);
    return Math.max(0, VENTANA_RATE_LIMIT_MS - (ahora - masViejo));
}

/**
 * ¿El resultado de `gh` es un 403 de abuse detection? Devuelve la espera
 * sugerida por `Retry-After`, o null si no es 403.
 * @param {{ok:boolean, stderr:string, stdout:string}} r
 * @returns {number|null} ms
 */
function esperaPorRetryAfter(r) {
    if (!r || r.ok) return null;
    const texto = `${r.stderr || ''}\n${r.stdout || ''}`;
    if (!/\b403\b|rate limit|abuse|secondary/i.test(texto)) return null;
    const m = texto.match(/retry[- ]after[":\s]+(\d+)/i);
    if (m) return Number(m[1]) * 1000;
    return BACKOFF_BASE_MS;
}

/**
 * Ejecuta una invocación de `gh` con backoff exponencial ante 403.
 * @param {function():object} invocar
 * @param {{sleep?:function, maxIntentos?:number, baseMs?:number}} [opts]
 * @returns {Promise<object>}
 */
async function ejecutarConBackoff(invocar, { sleep = defaultSleep, maxIntentos = BACKOFF_MAX_INTENTOS, baseMs = BACKOFF_BASE_MS } = {}) {
    let r = invocar();
    let intento = 0;
    while (intento < maxIntentos - 1) {
        const sugerida = esperaPorRetryAfter(r);
        if (sugerida === null) return r;
        const espera = Math.max(sugerida, baseMs * Math.pow(2, intento));
        await sleep(espera);
        intento++;
        r = invocar();
    }
    return r;
}

function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Guardrail (sección B) ---------------------------------------------------

/**
 * Declara procedencia ante el guardrail de #5690 antes de remover
 * `needs-human`. Si el veredicto es negativo se aborta la corrida entera.
 * @returns {string} el `authorizedBy` devuelto por el guardrail
 */
function autorizarRemocion() {
    const veredicto = guardrail.evaluateLabelOrder({
        action: 'remove-label',
        label: NEEDS_HUMAN_LABEL,
        order: { guardrail_authorized: true, authorized_by: AUTHORIZED_BY },
    });
    if (!veredicto || !veredicto.allowed) {
        throw new AbortoMigracion('guardrail-rechazo-la-remocion', veredicto ? veredicto.motivo : 'sin-veredicto');
    }
    return veredicto.authorizedBy || AUTHORIZED_BY;
}

// --- Mutación de un issue ----------------------------------------------------

/**
 * Re-lee los labels actuales de un issue (REQ-SEC-5, TOCTOU).
 * @returns {string[]|null} null si no se pudo leer
 */
function leerLabelsActuales({ ghRunner, repo, numero }) {
    const r = ghRunner(['issue', 'view', String(numero), '--repo', repo, '--json', 'labels']);
    if (!r.ok) return null;
    try {
        const j = JSON.parse(r.stdout);
        return normalizeLabelNames(j.labels);
    } catch { return null; }
}

/**
 * Migra un issue del candidate set.
 *
 * ORDEN FAIL-SAFE: primero AGREGA `needs:triage-backlog`, después REMUEVE
 * `needs-human`, en DOS invocaciones. El `--remove`/`--add` de un mismo
 * `gh issue edit` no es atómico del lado del servidor; con este orden, una
 * falla intermedia deja el issue con AMBOS labels (recuperable) y nunca sin
 * ninguno — que sería peor que no migrar. La seguridad fail-safe tiene
 * prioridad sobre el conteo de invocaciones.
 *
 * UN LABEL POR FLAG, nunca CSV (REQ-SEC-4).
 *
 * @returns {Promise<{estado:'ok'|'skipped'|'error', motivo?:string}>}
 */
async function migrarIssue({ numero, labelsSnapshot, ghRunner, repo, walFile, apply, sleep = defaultSleep }) {
    // REQ-SEC-5 — re-leer y re-evaluar el predicado completo justo antes de
    // mutar. Si un humano aprobó la recomendación mientras corríamos, su
    // `recommendation:approved` la sacó del set: reponerle `needs:triage-backlog`
    // devolvería a la cola algo que ya fue liberado.
    const actuales = apply ? leerLabelsActuales({ ghRunner, repo, numero }) : labelsSnapshot;
    if (apply && actuales === null) {
        appendWal(walFile, { issue: numero, status: 'error', msg: 'no-se-pudieron-releer-los-labels' });
        return { estado: 'error', motivo: 'relectura-fallida' };
    }
    if (!esCandidato(actuales)) {
        appendWal(walFile, { issue: numero, status: 'skipped', motivo: 'predicado-invalidado' });
        return { estado: 'skipped', motivo: 'predicado-invalidado' };
    }

    // B1 — procedencia declarada ANTES de cada remoción. Aborta la corrida
    // entera si el guardrail la rechaza.
    const authorizedBy = autorizarRemocion();

    const labelsAntes = actuales.slice();
    const labelsDespues = labelsAntes
        .filter((l) => l !== NEEDS_HUMAN_LABEL)
        .concat(labelsAntes.includes(TRIAGE_BACKLOG_LABEL) ? [] : [TRIAGE_BACKLOG_LABEL]);

    // C3 — registro `intent` ANTES de mutar. Con un solo registro no se
    // distingue "lo intenté" de "salió bien".
    appendWal(walFile, {
        issue: numero,
        labels_antes: labelsAntes,
        labels_despues: labelsDespues,
        authorized_by: authorizedBy,
        status: 'intent',
    });

    if (!apply) return { estado: 'skipped', motivo: 'dry-run' };

    const add = await ejecutarConBackoff(
        () => ghRunner(['issue', 'edit', String(numero), '--repo', repo, '--add-label', TRIAGE_BACKLOG_LABEL]),
        { sleep },
    );
    if (!add.ok) {
        appendWal(walFile, { issue: numero, status: 'error', msg: redactarTexto(add.stderr || `gh exit ${add.status}`) });
        return { estado: 'error', motivo: 'add-label-fallido' };
    }

    const rem = await ejecutarConBackoff(
        () => ghRunner(['issue', 'edit', String(numero), '--repo', repo, '--remove-label', NEEDS_HUMAN_LABEL]),
        { sleep },
    );
    if (!rem.ok) {
        appendWal(walFile, { issue: numero, status: 'error', msg: redactarTexto(rem.stderr || `gh exit ${rem.status}`) });
        return { estado: 'error', motivo: 'remove-label-fallido' };
    }

    appendWal(walFile, { issue: numero, status: 'ok' });
    return { estado: 'ok' };
}

// --- Control de regresión del gate (D3) --------------------------------------

/**
 * Alerta de pérdida del gate (R6), reformulada para que no nazca en cry-wolf.
 *
 * El criterio NO es "el total de `needs-human` llegó a 0": post-migración ese 0
 * es el resultado ESPERADO, y una alerta que grita en la corrida exitosa se
 * normaliza (OWASP A09 — el día que el gate se pierda de verdad nadie la mira).
 *
 * El criterio es la DESAPARICIÓN de un elemento de la lista de bloqueos reales
 * capturada antes de la corrida, más el canario. Con lista previa vacía, 0 es
 * lo esperado y no se alerta.
 *
 * @param {{listaPrevia?:number[], canario?:(number|null), conNeedsHumanDespues?:number[]}} params
 * @returns {{alerta:boolean, desaparecidos:number[], motivo:string}}
 */
function detectarPerdidaDeGate({ listaPrevia = [], canario = null, conNeedsHumanDespues = [] } = {}) {
    const esperados = new Set(listaPrevia.map(Number));
    if (canario !== null && canario !== undefined) esperados.add(Number(canario));
    const presentes = new Set((conNeedsHumanDespues || []).map(Number));
    const desaparecidos = [...esperados].filter((n) => !presentes.has(n));
    if (esperados.size === 0) {
        return { alerta: false, desaparecidos: [], motivo: 'lista-previa-vacia-cero-es-lo-esperado' };
    }
    if (desaparecidos.length === 0) {
        return { alerta: false, desaparecidos: [], motivo: 'todos-los-bloqueos-reales-conservan-needs-human' };
    }
    return { alerta: true, desaparecidos, motivo: 'perdida-del-gate-humano' };
}

// --- Reversión (C5) ----------------------------------------------------------

/**
 * Revierte una corrida a partir del WAL: por cada issue con `status:"ok"`,
 * repone sus `labels_antes`.
 *
 * REQ-SEC-4 — UN LABEL POR FLAG. Reconstruir con `join(',')` convertiría un
 * nombre de label que contenga una coma en inyección de labels arbitrarios
 * (incluido reponer `needs-human` donde no estaba), que es exactamente la clase
 * de bypass que #5690 documentó.
 *
 * @returns {Promise<{revertidos:number[], fallidos:Array<{issue:number,label:string}>}>}
 */
async function revertirDesdeWal({ walFile, ghRunner = defaultGhRunner, repo = DEFAULT_REPO, apply = false, sleep = defaultSleep }) {
    const previos = estadoPrevioDesdeWal(leerWal(walFile));
    const revertidos = [];
    const fallidos = [];
    for (const [numero, labels] of previos) {
        let okIssue = true;
        for (const label of labels) {
            if (!apply) continue;
            const r = await ejecutarConBackoff(
                () => ghRunner(['issue', 'edit', String(numero), '--repo', repo, '--add-label', label]),
                { sleep },
            );
            if (!r.ok) { okIssue = false; fallidos.push({ issue: numero, label }); }
        }
        // El label agregado por la migración se saca sólo si no estaba antes.
        if (apply && !labels.includes(TRIAGE_BACKLOG_LABEL)) {
            const r = await ejecutarConBackoff(
                () => ghRunner(['issue', 'edit', String(numero), '--repo', repo, '--remove-label', TRIAGE_BACKLOG_LABEL]),
                { sleep },
            );
            if (!r.ok) { okIssue = false; fallidos.push({ issue: numero, label: TRIAGE_BACKLOG_LABEL }); }
        }
        if (okIssue) revertidos.push(numero);
    }
    return { revertidos, fallidos };
}

// --- Verificación del label destino ------------------------------------------

/**
 * El label destino tiene que existir antes de arrancar: `gh issue edit
 * --add-label` con un label inexistente falla issue por issue y dejaría la
 * corrida a mitad de camino.
 * @returns {boolean}
 */
function labelDestinoExiste({ ghRunner = defaultGhRunner, repo = DEFAULT_REPO } = {}) {
    const r = ghRunner(['label', 'list', '--repo', repo, '--search', TRIAGE_BACKLOG_LABEL, '--json', 'name']);
    if (!r.ok) return false;
    try {
        const arr = JSON.parse(r.stdout);
        return Array.isArray(arr) && arr.some((l) => l && l.name === TRIAGE_BACKLOG_LABEL);
    } catch { return false; }
}

// --- Corrida completa --------------------------------------------------------

/**
 * Ejecuta la migración.
 *
 * @param {object} opts
 * @param {boolean} [opts.apply]        aplicar (requiere confirmación fuera de banda)
 * @param {string}  [opts.repo]
 * @param {function}[opts.ghRunner]
 * @param {string}  [opts.walFile]
 * @param {string}  [opts.resumeFrom]   WAL de una corrida cortada, para reanudar
 * @param {object}  [opts.env]
 * @param {function}[opts.log]
 * @returns {Promise<object>} resumen de la corrida
 */
async function run({
    apply = false,
    repo = DEFAULT_REPO,
    ghRunner = defaultGhRunner,
    walFile = null,
    resumeFrom = null,
    env = process.env,
    confirmFile = CONFIRM_FILE_DEFAULT,
    auditDir = AUDIT_DIR_DEFAULT,
    sleep = defaultSleep,
    now = () => Date.now(),
    log = console.log,
} = {}) {
    if (!REPO_RE.test(String(repo))) {
        throw new AbortoMigracion('repo-invalido', String(repo));
    }

    // REQ-SEC-2 — fail-closed: sin confirmación fuera de banda, `--apply`
    // DEGRADA a dry-run. Nunca al revés.
    let aplicar = apply;
    let motivoDegradacion = null;
    if (apply) {
        const conf = verificarConfirmacion({ env, confirmFile });
        if (!conf.ok) {
            aplicar = false;
            motivoDegradacion = conf.motivo;
            log(`⚠️  --apply DEGRADADO A DRY-RUN: ${conf.motivo}`);
            log('    La migración exige confirmación fuera de banda (MIGRATE_5678_CONFIRM).');
        }
    }

    if (aplicar && !labelDestinoExiste({ ghRunner, repo })) {
        throw new AbortoMigracion('label-destino-inexistente', TRIAGE_BACKLOG_LABEL);
    }

    const { items } = listarCandidatos({ ghRunner, repo });

    // A4 — assert de aborto. Si un elemento del candidate set no tiene
    // `tipo:recomendacion`, la query está malformada y la corrida entera se
    // corta: mutar igual le arrancaría el gate a bloqueos reales.
    for (const it of items) {
        if (!it.labels.includes(TIPO_RECOMENDACION_LABEL)) {
            throw new AbortoMigracion('candidato-sin-tipo-recomendacion', `#${it.number}`);
        }
    }
    const candidatos = items.filter((it) => esCandidato(it.labels));

    // A6 — cross-check del dry-run. Si el total paginado no coincide con el de
    // la Search API, NO se habilita `--apply`.
    const totalSearch = contarPorSearch({ ghRunner, repo });
    const crossCheckOk = totalSearch === null ? null : totalSearch === items.length;
    log(`Candidate set: paginado=${items.length} search=${totalSearch === null ? 'n/d' : totalSearch} → ${crossCheckOk === null ? 'sin cross-check' : (crossCheckOk ? 'coincide' : 'DIFIEREN')}`);
    if (aplicar && crossCheckOk === false) {
        throw new AbortoMigracion('cross-check-fallido', `paginado=${items.length} search=${totalSearch}`);
    }

    // D6 — candidatos que cumplen el predicado pero están en el flujo de
    // trabajo del pipeline: se listan APARTE para revisión del operador.
    const noRecomendacion = candidatos.filter((it) => esCandidatoNoRecomendacion(it.labels));
    if (noRecomendacion.length) {
        log(`⚠️  ${noRecomendacion.length} candidato(s) con labels de flujo del pipeline — revisar antes del --apply:`);
        for (const it of noRecomendacion) log(`    #${it.number} [${it.labels.join(', ')}] ${it.title}`);
    }

    const startedAt = new Date().toISOString();
    const file = walFile || walPathFor({ dir: auditDir, ts: startedAt });

    // C4 — reanudación: los `status:"ok"` de una corrida previa se saltean.
    const yaHechos = resumeFrom ? issuesCompletados(leerWal(resumeFrom)) : new Set();

    appendWal(file, {
        tipo: 'run-start',
        started_at: startedAt,
        candidate_set: candidatos.map((c) => c.number),
        total: candidatos.length,
        apply: aplicar,
        repo,
        ...(motivoDegradacion ? { degradado: motivoDegradacion } : {}),
        ...(resumeFrom ? { resume_from: path.basename(resumeFrom) } : {}),
    });

    const resumen = { total: candidatos.length, ok: 0, skipped: 0, error: 0, reanudados: 0, walFile: file, apply: aplicar, crossCheckOk, noRecomendacion: noRecomendacion.map((c) => c.number) };
    const mutaciones = [];

    for (const it of candidatos) {
        if (yaHechos.has(it.number)) {
            resumen.reanudados++;
            appendWal(file, { issue: it.number, status: 'skipped', motivo: 'ya-migrado-en-corrida-previa' });
            continue;
        }
        if (aplicar) {
            const espera = esperaPorRateLimit(mutaciones, now());
            if (espera > 0) await sleep(espera);
        }
        const r = await migrarIssue({
            numero: it.number, labelsSnapshot: it.labels, ghRunner, repo,
            walFile: file, apply: aplicar, sleep,
        });
        if (r.estado === 'ok') { resumen.ok++; mutaciones.push(now()); }
        else if (r.estado === 'error') resumen.error++;
        else resumen.skipped++;
    }

    appendWal(file, { tipo: 'run-end', ...resumen });
    log(`\nResumen: candidatos=${resumen.total} migrados=${resumen.ok} salteados=${resumen.skipped} errores=${resumen.error}`);
    log(`WAL: ${file}`);
    if (!aplicar) log('(dry-run — usar --apply con MIGRATE_5678_CONFIRM para ejecutar)');
    else log('⚠️  Copiar el WAL FUERA del árbol del repo antes de dar la corrida por buena (REQ-SEC-6).');
    return resumen;
}

// --- CLI ---------------------------------------------------------------------

function parseFlag(argv, name) {
    const i = argv.indexOf(name);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
    return null;
}

async function main(argv = process.argv.slice(2)) {
    // REQ-SEC-D — sin `--token` por argv (quedaría en `ps` y en el historial).
    if (argv.includes('--token')) {
        console.error('El token no se pasa por argumento (queda en `ps` y en el historial). Usar GH_TOKEN.');
        process.exit(1);
    }
    const repo = parseFlag(argv, '--repo') || DEFAULT_REPO;
    const revert = parseFlag(argv, '--revert');
    const apply = argv.includes('--apply');

    try {
        if (revert) {
            const r = await revertirDesdeWal({ walFile: revert, repo, apply });
            console.log(`Reversión: revertidos=${r.revertidos.length} fallidos=${r.fallidos.length}`);
            if (!apply) console.log('(dry-run de reversión — usar --apply para ejecutar)');
            return;
        }
        await run({ apply, repo, resumeFrom: parseFlag(argv, '--resume') });
    } catch (e) {
        if (e instanceof AbortoMigracion) {
            console.error(`ABORTO DE LA CORRIDA: ${e.motivo}${e.detalle ? ` — ${e.detalle}` : ''}`);
            process.exit(1);
        }
        console.error(`Error inesperado: ${redactarTexto(String(e && e.message || e))}`);
        process.exit(1);
    }
}

if (require.main === module) main();

module.exports = {
    // constantes
    NEEDS_HUMAN_LABEL,
    TIPO_RECOMENDACION_LABEL,
    TRIAGE_BACKLOG_LABEL,
    RECOMMENDATION_APPROVED_LABEL,
    AUTHORIZED_BY,
    REPO_RE,
    MAX_MUTACIONES_POR_MINUTO,
    LABELS_FLUJO_PIPELINE,
    AbortoMigracion,
    // predicado
    esCandidato,
    esCandidatoNoRecomendacion,
    // gh
    defaultGhRunner,
    listarCandidatos,
    contarPorSearch,
    parseJsonArrays,
    labelDestinoExiste,
    // seguridad
    verificarConfirmacion,
    redactarTexto,
    redactarLinea,
    redactarRegistro,
    autorizarRemocion,
    // wal
    walPathFor,
    appendWal,
    leerWal,
    issuesCompletados,
    estadoPrevioDesdeWal,
    runStartDesdeWal,
    // rate limit / backoff
    esperaPorRateLimit,
    esperaPorRetryAfter,
    ejecutarConBackoff,
    // operación
    migrarIssue,
    revertirDesdeWal,
    detectarPerdidaDeGate,
    run,
    main,
};
