// =============================================================================
// provider-policy.js — Política formal de proveedores de IA (#7597).
//
// Lee `.pipeline/provider-policy.json` y responde, sin interpretación:
//   - "¿puedo habilitar el proveedor X para el rol Y?"      → canEnable()
//   - "¿los términos del proveedor X están vigentes?"         → termsStatus()
//   - "¿la matriz vigente coincide con la política escrita?"  → checkMatrixCoherence()
//   - "¿qué altas/bajas de rol trae este cambio de política?" → diffRolesAllowed()
//
// Reglas de diseño (SR-1..SR-8 de security, receta del arquitecto):
//   - UNA sola fuente de verdad para el entorno (SR-2): los scopes que recibe
//     cada rol NO se copian acá; se derivan de `lib/build-child-env.js`
//     (`_resolveSkillConfig` + `DEFAULT_REQUIRES_BY_SKILL` + `SCOPES_ALWAYS_ON`)
//     y de `agent-models.json`. `allowed_scopes` sólo admite claves que existan
//     en `CREDENTIAL_SCOPES`, leídas en runtime.
//   - Fail-closed (SR-3): archivo ausente, JSON inválido o política que no
//     valida ⇒ política VACÍA ⇒ todo prohibido. Un proveedor o rol que falte
//     cuenta como prohibido, nunca como permitido.
//   - Vencimiento (SR-4): fecha ausente o inválida ⇒ `vencido`. Un vencimiento
//     bloquea habilitaciones NUEVAS (canEnable) pero NO corta el ruteo vigente:
//     en la coherencia es warning, no violación.
//   - Nada de reloj implícito en decisiones testeables: toda función que mira
//     la fecha recibe `now` (default Date.now() sólo para runtime).
//   - Este módulo NO modifica `build-child-env.js` (lo achica #7598): sólo lo lee.
//
// Tests: lib/__tests__/provider-policy.test.js
//        lib/__tests__/provider-policy-coherence.test.js
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const bce = require('./build-child-env');

const POLICY_FILENAME = 'provider-policy.json';
const DATA_CATEGORIES = Object.freeze(['issues', 'logs', 'telegram', 'qa_evidence', 'handoff']);
const CODE_ACCESS = Object.freeze(['read', 'write', 'none']);
const FS_REACH = Object.freeze(['operator_home', 'worktree', 'sandbox']);
const PERMISSION_MODES = Object.freeze(['bypass', 'full-auto', 'restricted']);
const TOOLS = Object.freeze(['shell', 'network', 'git', 'gh', 'aws', 'gradle']);
const OPEN_DIFFERENCE_KINDS = Object.freeze(['scope_exceeded', 'role_not_allowed']);
const EXEMPT_ALLOWED = Object.freeze(['deterministic']);

const SIGNOFF_REF_RE = /^https:\/\/github\.com\/intrale\/platform\/(issues|pull)\/\d+#issuecomment-\d+$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SAFE_NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;
const EXPOSURE_RE = /^#\d+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_PIPELINE_DIR = path.resolve(__dirname, '..');

// ─── Fechas ──────────────────────────────────────────────────────────────────

/**
 * Parsea `YYYY-MM-DD` estricto a ms UTC (00:00). Rechaza fechas imposibles
 * (2026-02-30) comparando ida y vuelta. Devuelve null ante cualquier duda.
 */
function parseIsoDate(s) {
    if (typeof s !== 'string') return null;
    const m = ISO_DATE_RE.exec(s);
    if (!m) return null;
    const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
    const ms = Date.UTC(y, mo - 1, d);
    const back = new Date(ms);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return ms;
}

/** `YYYY-MM-DD` → `DD/MM/AAAA` armado a mano (sin toLocaleDateString, UX-1). */
function formatDateDMY(iso) {
    if (parseIsoDate(iso) === null) return null;
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
}

// ─── Validación ──────────────────────────────────────────────────────────────

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkKeys(obj, allowed, where, errors) {
    for (const k of Object.keys(obj)) {
        if (!allowed.includes(k)) errors.push(`${where}: campo no permitido '${k}'`);
    }
}

function isStringArray(v) {
    return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Valida la política completa. Espeja `provider-policy.schema.json` y agrega
 * los chequeos que el schema no puede expresar:
 *   - `allowed_scopes` ⊆ claves de CREDENTIAL_SCOPES (leídas en runtime, SR-2).
 *   - `data.<cat>.roles` ⊆ roles de `roles_allowed` del mismo proveedor.
 *   - `expires_at` > `verified_at` y vigencia ≤ `terms_max_validity_days`.
 *   - `open_differences` apunta a proveedores declarados.
 *
 * @returns {string[]} errores (vacío = válida)
 */
function validatePolicy(policy, opts = {}) {
    const errors = [];
    const scopeKeys = Object.keys(opts.credentialScopes || bce.CREDENTIAL_SCOPES);
    if (!isPlainObject(policy)) return ['la política no es un objeto'];

    checkKeys(policy, ['$schema', '_doc', 'version', 'doc_ref', 'terms_max_validity_days',
        'exempt_providers', 'providers', 'open_differences'], 'raíz', errors);
    if (parseIsoDate(policy.version) === null) errors.push('version: fecha YYYY-MM-DD inválida');
    if (policy.doc_ref !== 'docs/legal/proveedores-ia.md') errors.push('doc_ref: debe ser docs/legal/proveedores-ia.md');
    const maxDays = policy.terms_max_validity_days;
    if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 365) errors.push('terms_max_validity_days: entero entre 1 y 365');
    if (!isStringArray(policy.exempt_providers)
        || policy.exempt_providers.some((p) => !EXEMPT_ALLOWED.includes(p))) {
        errors.push(`exempt_providers: sólo admite ${EXEMPT_ALLOWED.join(', ')}`);
    }
    if (!isPlainObject(policy.providers)) {
        errors.push('providers: debe ser un objeto');
        return errors;
    }

    for (const [name, p] of Object.entries(policy.providers)) {
        const w = `providers.${name}`;
        if (!/^[a-z][a-z0-9-]{0,32}$/.test(name)) errors.push(`${w}: nombre de proveedor inválido`);
        if ((policy.exempt_providers || []).includes(name)) errors.push(`${w}: un proveedor exento no lleva entrada`);
        if (!isPlainObject(p)) { errors.push(`${w}: debe ser un objeto`); continue; }
        checkKeys(p, ['code', 'data', 'env', 'terms', 'roles_allowed', 'known_exposures'], w, errors);

        // Código.
        if (!isPlainObject(p.code) || !CODE_ACCESS.includes(p.code.access)
            || typeof p.code.note !== 'string' || !p.code.note.trim()) {
            errors.push(`${w}.code: requiere access (${CODE_ACCESS.join('|')}) y note`);
        } else {
            checkKeys(p.code, ['access', 'note'], `${w}.code`, errors);
        }

        // Roles habilitados (antes que data: data.roles se valida contra esto).
        const grantedRoles = new Set();
        if (!Array.isArray(p.roles_allowed)) {
            errors.push(`${w}.roles_allowed: debe ser un array`);
        } else {
            for (const [i, g] of p.roles_allowed.entries()) {
                const gw = `${w}.roles_allowed[${i}]`;
                if (!isPlainObject(g) || typeof g.role !== 'string' || !SAFE_NAME_RE.test(g.role)) {
                    errors.push(`${gw}: rol inválido`);
                    continue;
                }
                checkKeys(g, ['role', 'signoff_ref'], gw, errors);
                if (grantedRoles.has(g.role)) errors.push(`${gw}: rol '${g.role}' duplicado`);
                grantedRoles.add(g.role);
                if (typeof g.signoff_ref !== 'string' || !SIGNOFF_REF_RE.test(g.signoff_ref)) {
                    errors.push(`${gw}: signoff_ref ausente o fuera del formato de comentario de GitHub`);
                }
            }
        }

        // Datos: las 5 categorías cerradas.
        if (!isPlainObject(p.data)) {
            errors.push(`${w}.data: debe ser un objeto`);
        } else {
            checkKeys(p.data, DATA_CATEGORIES, `${w}.data`, errors);
            for (const cat of DATA_CATEGORIES) {
                const e = p.data[cat];
                const cw = `${w}.data.${cat}`;
                if (!isPlainObject(e) || typeof e.allowed !== 'boolean') {
                    errors.push(`${cw}: requiere allowed (boolean)`);
                    continue;
                }
                checkKeys(e, ['allowed', 'roles'], cw, errors);
                if (e.roles !== undefined) {
                    if (!isStringArray(e.roles)) { errors.push(`${cw}.roles: debe ser array de strings`); continue; }
                    if (!e.allowed && e.roles.length > 0) errors.push(`${cw}: una categoría no permitida no lista roles`);
                    for (const r of e.roles) {
                        if (!grantedRoles.has(r)) errors.push(`${cw}: el rol '${r}' no está en roles_allowed`);
                    }
                }
            }
        }

        // Entorno: 4 sub-dimensiones (SR-1).
        if (!isPlainObject(p.env)) {
            errors.push(`${w}.env: debe ser un objeto`);
        } else {
            checkKeys(p.env, ['allowed_scopes', 'fs_reach', 'permission_mode', 'tools'], `${w}.env`, errors);
            if (!isStringArray(p.env.allowed_scopes)) {
                errors.push(`${w}.env.allowed_scopes: debe ser array de strings`);
            } else {
                for (const s of p.env.allowed_scopes) {
                    if (!scopeKeys.includes(s)) errors.push(`${w}.env.allowed_scopes: '${s}' no existe en CREDENTIAL_SCOPES`);
                }
            }
            if (!FS_REACH.includes(p.env.fs_reach)) errors.push(`${w}.env.fs_reach: ${FS_REACH.join('|')}`);
            if (!PERMISSION_MODES.includes(p.env.permission_mode)) errors.push(`${w}.env.permission_mode: ${PERMISSION_MODES.join('|')}`);
            if (!isStringArray(p.env.tools) || p.env.tools.some((t) => !TOOLS.includes(t))) {
                errors.push(`${w}.env.tools: sólo ${TOOLS.join(', ')}`);
            }
        }

        // Términos.
        if (!isPlainObject(p.terms)) {
            errors.push(`${w}.terms: debe ser un objeto`);
        } else {
            checkKeys(p.terms, ['verified_at', 'expires_at', 'sources'], `${w}.terms`, errors);
            const v = parseIsoDate(p.terms.verified_at);
            const x = parseIsoDate(p.terms.expires_at);
            if (v === null) errors.push(`${w}.terms.verified_at: fecha YYYY-MM-DD inválida`);
            if (x === null) errors.push(`${w}.terms.expires_at: fecha YYYY-MM-DD inválida`);
            if (v !== null && x !== null) {
                if (x <= v) errors.push(`${w}.terms: expires_at debe ser posterior a verified_at`);
                if (Number.isInteger(maxDays) && (x - v) / DAY_MS > maxDays) {
                    errors.push(`${w}.terms: vigencia mayor a ${maxDays} días`);
                }
            }
            if (!isStringArray(p.terms.sources) || p.terms.sources.length === 0
                || p.terms.sources.some((s) => !/^https:\/\/\S+$/.test(s))) {
                errors.push(`${w}.terms.sources: al menos una URL https`);
            }
        }

        if (!isStringArray(p.known_exposures) || p.known_exposures.some((e) => !EXPOSURE_RE.test(e))) {
            errors.push(`${w}.known_exposures: sólo referencias a issues (#N)`);
        }
    }

    if (!Array.isArray(policy.open_differences)) {
        errors.push('open_differences: debe ser un array');
    } else {
        for (const [i, d] of policy.open_differences.entries()) {
            const dw = `open_differences[${i}]`;
            if (!isPlainObject(d)) { errors.push(`${dw}: debe ser un objeto`); continue; }
            checkKeys(d, ['provider', 'role', 'kind', 'scope', 'request_ref'], dw, errors);
            if (!policy.providers[d.provider]) errors.push(`${dw}: proveedor '${d.provider}' sin entrada en la política`);
            if (typeof d.role !== 'string' || !SAFE_NAME_RE.test(d.role)) errors.push(`${dw}: rol inválido`);
            if (!OPEN_DIFFERENCE_KINDS.includes(d.kind)) errors.push(`${dw}: kind ${OPEN_DIFFERENCE_KINDS.join('|')}`);
            if (d.kind === 'scope_exceeded' && !scopeKeys.includes(d.scope)) errors.push(`${dw}: scope inexistente`);
            if (typeof d.request_ref !== 'string' || !SIGNOFF_REF_RE.test(d.request_ref)) {
                errors.push(`${dw}: request_ref debe apuntar al pedido de firma (comentario de GitHub)`);
            }
        }
    }
    return errors;
}

// ─── Carga fail-closed ───────────────────────────────────────────────────────

function emptyPolicy(errors) {
    return {
        version: null,
        terms_max_validity_days: 0,
        exempt_providers: [],
        providers: {},
        open_differences: [],
        _loaded: false,
        _errors: errors,
    };
}

/**
 * Lee y valida la política. NUNCA lanza: ante cualquier problema devuelve la
 * política vacía (todo prohibido) con `_errors` para diagnóstico.
 */
function loadPolicy(opts = {}) {
    const pipelineDir = opts.pipelineDir || DEFAULT_PIPELINE_DIR;
    const _fs = opts.fsImpl || fs;
    const file = path.join(pipelineDir, POLICY_FILENAME);
    let raw;
    try {
        raw = _fs.readFileSync(file, 'utf8');
    } catch (e) {
        return emptyPolicy([`no se pudo leer ${POLICY_FILENAME}: ${e.code || e.message}`]);
    }
    let obj;
    try {
        obj = JSON.parse(raw);
    } catch (e) {
        return emptyPolicy([`${POLICY_FILENAME} no es JSON válido: ${e.message}`]);
    }
    const errors = validatePolicy(obj);
    if (errors.length > 0) return emptyPolicy(errors);
    return { ...obj, _loaded: true, _errors: [] };
}

function resolvePolicy(opts) {
    return (opts && opts.policy) || loadPolicy(opts || {});
}

function isExempt(provider, policy) {
    return Array.isArray(policy.exempt_providers) && policy.exempt_providers.includes(provider);
}

// ─── Términos ────────────────────────────────────────────────────────────────

/**
 * Estado de la verificación de términos de un proveedor.
 *
 * `expires_at` es inclusivo: vence al terminar ese día (UTC), igual que el
 * `until` de `admission.exception` (#6562).
 *
 * @param {string|object} provider — nombre (se busca en la política) o la
 *   entrada ya resuelta del proveedor.
 * @returns {{ state: 'vigente'|'vencido', reason: 'ok'|'expired'|'missing'|'invalid'|'no_entry',
 *             verified_at: string|null, expires_at: string|null }}
 */
function termsStatus(provider, opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    let entry = provider;
    if (typeof provider === 'string') {
        const policy = resolvePolicy(opts);
        entry = policy.providers[provider];
        if (!entry) return { state: 'vencido', reason: 'no_entry', verified_at: null, expires_at: null };
    }
    const terms = entry && entry.terms;
    if (!terms || terms.expires_at === undefined || terms.expires_at === null || terms.expires_at === '') {
        return { state: 'vencido', reason: 'missing', verified_at: null, expires_at: null };
    }
    const verifiedAt = typeof terms.verified_at === 'string' ? terms.verified_at : null;
    const exp = parseIsoDate(terms.expires_at);
    if (exp === null || parseIsoDate(verifiedAt) === null) {
        return { state: 'vencido', reason: 'invalid', verified_at: null, expires_at: null };
    }
    if (now >= exp + DAY_MS) {
        return { state: 'vencido', reason: 'expired', verified_at: verifiedAt, expires_at: terms.expires_at };
    }
    return { state: 'vigente', reason: 'ok', verified_at: verifiedAt, expires_at: terms.expires_at };
}

// ─── Entorno efectivo por rol (derivado, SR-2) ───────────────────────────────

/**
 * Scopes que el rol puede recibir en alguna fase: lo que declara
 * (`requires_credentials` de agent-models.json o `DEFAULT_REQUIRES_BY_SKILL`)
 * más `SCOPES_ALWAYS_ON`. Es el MÁXIMO: el techo por fase de build-child-env
 * sólo puede achicarlo, nunca agrandarlo, así que evaluar contra el máximo es
 * el lado conservador.
 *
 * `opts.agentModels` permite evaluar una matriz en memoria (fixtures) sin
 * tocar disco; sin él se lee `agent-models.json` de `pipelineDir`.
 */
function effectiveScopesForRole(role, opts = {}) {
    let skillCfg;
    if (opts.agentModels) {
        const skills = (opts.agentModels && opts.agentModels.skills) || {};
        skillCfg = skills[role] || {};
    } else {
        skillCfg = bce._resolveSkillConfig(role, {
            pipelineDir: opts.pipelineDir || DEFAULT_PIPELINE_DIR,
            fsImpl: opts.fsImpl,
        }).skillCfg;
    }
    const declared = Array.isArray(skillCfg.requires_credentials)
        ? skillCfg.requires_credentials
        : (bce.DEFAULT_REQUIRES_BY_SKILL[role] || []);
    return [...new Set([...declared, ...bce.SCOPES_ALWAYS_ON])];
}

// ─── canEnable (SR-8) ────────────────────────────────────────────────────────

// Textos de UX-4: frases completas, en el mismo orden que el checklist del doc.
const REASONS = Object.freeze({
    noEntry: (p) => `El proveedor ${p} no tiene entrada en la política: se trata como prohibido.`,
    roleNotAllowed: (r, p) => `El rol ${r} no está habilitado para ${p} en la política.`,
    noSignoff: (r, p) => `La habilitación de ${r} en ${p} no tiene sign-off del operador.`,
    scopeExceeded: (r, s, p) => `El rol ${r} recibe el scope ${s}, que ${p} no tiene permitido.`,
    termsExpired: (p, fecha) => `Los términos de ${p} están vencidos (${fecha}): no se aceptan habilitaciones nuevas.`,
});

function grantFor(entry, role) {
    return (Array.isArray(entry.roles_allowed) ? entry.roles_allowed : []).find((g) => g && g.role === role) || null;
}

/** Chequeos de habilitación que NO dependen de la fecha (compartidos con la coherencia). */
function structuralFindings(provider, role, entry, opts) {
    const out = [];
    const grant = grantFor(entry, role);
    if (!grant) out.push({ kind: 'role_not_allowed', reason: REASONS.roleNotAllowed(role, provider) });
    else if (typeof grant.signoff_ref !== 'string' || !SIGNOFF_REF_RE.test(grant.signoff_ref)) {
        out.push({ kind: 'no_signoff', reason: REASONS.noSignoff(role, provider) });
    }
    const allowed = (entry.env && Array.isArray(entry.env.allowed_scopes)) ? entry.env.allowed_scopes : [];
    for (const s of effectiveScopesForRole(role, opts)) {
        if (!allowed.includes(s)) out.push({ kind: 'scope_exceeded', scope: s, reason: REASONS.scopeExceeded(role, s, provider) });
    }
    return out;
}

/**
 * ¿Puedo habilitar el proveedor `provider` para el rol `role`?
 *
 * Rechaza si: el proveedor no tiene entrada, el rol no está en
 * `roles_allowed`, la habilitación no tiene `signoff_ref`, algún scope
 * efectivo del rol excede `env.allowed_scopes`, o los términos están vencidos.
 * Los proveedores exentos (`deterministic`) siempre pueden.
 *
 * @returns {{ ok: boolean, reasons: string[] }}
 */
function canEnable(provider, role, opts = {}) {
    const policy = resolvePolicy(opts);
    if (isExempt(provider, policy)) return { ok: true, reasons: [] };
    const entry = policy.providers[provider];
    if (!entry) return { ok: false, reasons: [REASONS.noEntry(provider)] };
    const reasons = structuralFindings(provider, role, entry, opts).map((f) => f.reason);
    const ts = termsStatus(entry, { now: opts.now });
    if (ts.state !== 'vigente') {
        reasons.push(REASONS.termsExpired(provider, formatDateDMY(ts.expires_at) || 'sin fecha válida'));
    }
    return { ok: reasons.length === 0, reasons };
}

// ─── Coherencia matriz ↔ política (SR-3) ─────────────────────────────────────

function chainOf(skillCfg) {
    const out = [];
    if (skillCfg && typeof skillCfg.provider === 'string') out.push(skillCfg.provider);
    for (const f of (skillCfg && Array.isArray(skillCfg.fallbacks)) ? skillCfg.fallbacks : []) {
        const p = typeof f === 'string' ? f : (f && f.provider);
        if (typeof p === 'string') out.push(p);
    }
    return out;
}

/**
 * Un par pendiente de firma NO figura en `roles_allowed` a propósito (la
 * política no lo habilita mientras no haya firma), así que su hallazgo
 * `role_not_allowed` es parte de la misma pendencia. Los scopes, en cambio,
 * tienen que coincidir exactamente: un scope nuevo en un par pendiente es una
 * diferencia NUEVA y falla.
 */
function matchesOpenDifference(policy, provider, role, finding) {
    return (policy.open_differences || []).some((d) => {
        if (d.provider !== provider || d.role !== role) return false;
        if (finding.kind === 'role_not_allowed') return true;
        return d.kind === finding.kind && (d.kind !== 'scope_exceeded' || d.scope === finding.scope);
    });
}

/**
 * Cruza TODA la matriz (primario y cada eslabón de `fallbacks`) contra la
 * política.
 *
 *   - violations: diferencias no resueltas → el test falla.
 *   - pending: diferencias registradas en `open_differences` (pendientes de
 *     firma, con link al pedido).
 *   - warnings: términos vencidos en pares vigentes (no cortan el ruteo).
 *
 * @returns {{ violations: object[], pending: object[], warnings: object[] }}
 */
function checkMatrixCoherence(agentModels, policy, opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const violations = [];
    const pending = [];
    const warnings = [];
    const skills = (agentModels && agentModels.skills) || {};
    const matrixProviders = new Set(Object.keys((agentModels && agentModels.providers) || {}));
    const routed = new Set(); // `${provider}|${role}`
    const matchedDiffs = new Set();
    const warnedTerms = new Set();
    const evalOpts = { ...opts, agentModels };

    for (const [role, cfg] of Object.entries(skills)) {
        for (const provider of chainOf(cfg)) {
            if (isExempt(provider, policy)) continue;
            routed.add(`${provider}|${role}`);
            const entry = policy.providers[provider];
            if (!entry) {
                violations.push({ provider, role, kind: 'provider_without_policy', reason: REASONS.noEntry(provider) });
                continue;
            }
            for (const f of structuralFindings(provider, role, entry, evalOpts)) {
                const item = { provider, role, ...f };
                if (matchesOpenDifference(policy, provider, role, f)) {
                    pending.push(item);
                    if (f.kind !== 'role_not_allowed') matchedDiffs.add(`${provider}|${role}|${f.kind}|${f.scope || ''}`);
                    else matchedDiffs.add(`${provider}|${role}|role_not_allowed|`);
                } else {
                    violations.push(item);
                }
            }
            const ts = termsStatus(entry, { now });
            if (ts.state !== 'vigente' && !warnedTerms.has(provider)) {
                warnedTerms.add(provider);
                warnings.push({ provider, kind: 'terms_expired', reason: REASONS.termsExpired(provider, formatDateDMY(ts.expires_at) || 'sin fecha válida') });
            }
        }
    }

    for (const [provider, entry] of Object.entries(policy.providers || {})) {
        if (!matrixProviders.has(provider)) {
            violations.push({ provider, kind: 'policy_provider_unknown', reason: `El proveedor ${provider} está en la política pero no existe en la matriz.` });
        }
        for (const g of (Array.isArray(entry.roles_allowed) ? entry.roles_allowed : [])) {
            if (!routed.has(`${provider}|${g.role}`)) {
                violations.push({ provider, role: g.role, kind: 'grant_not_routed', reason: `La política habilita ${g.role} en ${provider}, pero la matriz no lo rutea ahí.` });
            }
        }
    }

    for (const d of (policy.open_differences || [])) {
        if (!matchedDiffs.has(`${d.provider}|${d.role}|${d.kind}|${d.scope || ''}`)) {
            violations.push({ provider: d.provider, role: d.role, kind: 'stale_open_difference', reason: `La diferencia abierta ${d.role}→${d.provider} (${d.kind}) ya no ocurre: hay que quitarla.` });
        }
    }

    return { violations, pending, warnings };
}

// ─── Diff de habilitaciones (auditoría, SR-5) ────────────────────────────────

/**
 * Altas y bajas de `roles_allowed` entre dos versiones de la política.
 * Pura: no lee git. El autor/sha/fecha los pone el caller desde git.
 *
 * @returns {Array<{ provider: string, role: string, kind: 'added'|'removed', signoff_ref: string|null }>}
 */
function diffRolesAllowed(fromPolicy, toPolicy) {
    const index = (pol) => {
        const m = new Map();
        const provs = (pol && isPlainObject(pol.providers)) ? pol.providers : {};
        for (const [provider, entry] of Object.entries(provs)) {
            for (const g of (entry && Array.isArray(entry.roles_allowed)) ? entry.roles_allowed : []) {
                if (g && typeof g.role === 'string') m.set(`${provider}|${g.role}`, { provider, role: g.role, signoff_ref: g.signoff_ref || null });
            }
        }
        return m;
    };
    const a = index(fromPolicy);
    const b = index(toPolicy);
    const out = [];
    for (const [k, v] of b) if (!a.has(k)) out.push({ ...v, kind: 'added' });
    for (const [k, v] of a) if (!b.has(k)) out.push({ ...v, signoff_ref: null, kind: 'removed' });
    out.sort((x, y) => (x.provider + x.role + x.kind).localeCompare(y.provider + y.role + y.kind));
    return out;
}

module.exports = {
    POLICY_FILENAME,
    DATA_CATEGORIES,
    CODE_ACCESS,
    FS_REACH,
    PERMISSION_MODES,
    TOOLS,
    SIGNOFF_REF_RE,
    REASONS,
    parseIsoDate,
    formatDateDMY,
    validatePolicy,
    loadPolicy,
    termsStatus,
    effectiveScopesForRole,
    canEnable,
    checkMatrixCoherence,
    diffRolesAllowed,
};
