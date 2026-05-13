// =============================================================================
// permission-validator.js — Validación capability-level cross-provider.
//
// Issue: #3082 (S4 multi-provider) — CA-1, CA-8..CA-12, CA-14, CA-15 (PO/security).
//
// Resumen del contrato:
//   - **Matriz canónica `CAPABILITY_MATRIX`**: define qué capabilities concede
//     cada par (provider, mode). Es la fuente de verdad. La tabla flag↔flag
//     es derivada de esta (ver doc).
//   - **Fail-CLOSED por default (CA-S2 / CA-9)**: si un skill declara una
//     capability ausente del catálogo, o un mode ausente del mapping, o si
//     el set requerido NO es subset del set otorgado, el launcher rechaza
//     el spawn.
//   - **NON_DEGRADABLE_SKILLS (CA-S6 / CA-11)**: skills que requieren
//     capabilities altas y NO pueden correr en providers con capability set
//     reducido. Aun con override, no se admite ejecución degradada para
//     estos skills. Lista hardcoded acá (no en agent-models.json).
//   - **Overrides (CA-13..CA-17)**: persistidos en
//     `.pipeline/audit/permission-overrides.jsonl` vía hash chain (audit-log.js).
//     Override por (skill, provider) específico, TTL en horas (max 168 = 7d),
//     justificación libre, autor de git. Override expirado → fail-CLOSED
//     automático.
//
// **Llamado at-spawn-time (CA-S3 / CA-8)**: `validateSpawn(skill, provider, mode)`
// se invoca en cada lanzamiento. No cachear el resultado a boot — `agent-models.json`
// puede cambiar runtime y los rebotes cross-phase cambian el skill.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const capabilities = require('./capabilities');
const auditLog = require('./audit-log');

// Helper local: Set inmutable (Object.freeze sobre Set NO previene .add/.delete).
// Si más adelante extraemos `lib/immutable-set.js` (CR pendiente), migrar acá.
function immutableSet(values) {
    const s = new Set(values);
    const blocker = () => { throw new TypeError('Set inmutable — modificación denegada.'); };
    s.add = blocker; s.delete = blocker; s.clear = blocker;
    return Object.freeze(s);
}

// -----------------------------------------------------------------------------
// CAPABILITY_MATRIX — fuente de verdad capability×(provider, mode).
//
// Estructura: { provider: { mode: Set<capability> } }
//
// Justificación por celda en `docs/pipeline-multi-provider/permission-mapping.md`.
// Cualquier cambio acá requiere:
//   1. Actualizar la doc.
//   2. Actualizar el test de paridad (tests/permission-parity/*.yaml).
//   3. Pasar CODEOWNERS.
//
// NOTA sobre codex / openai-codex / --no-confirm (CA-19):
//   Hasta que H3 (#3076) integre el binario real de codex y se ejecute el
//   test empírico en sandbox, los valores acá son **conservadores**: solo
//   incluyen capabilities que la documentación oficial de OpenAI Codex CLI
//   confirma. Cuando H3 cierre, el dev de #3082 (o un fast-follow) debe:
//     - Correr el test empírico (CA-19).
//     - Ajustar este Set si el comportamiento observado contradice supuestos.
//     - Documentar el resultado en permission-mapping.md.
// -----------------------------------------------------------------------------
const CAPABILITY_MATRIX = Object.freeze({
    anthropic: Object.freeze({
        // `bypassPermissions` — Claude Code corre sin pedir confirmación.
        // Concede el set máximo dentro del repo y herramientas gated.
        // NO concede escritura fuera del repo (Claude Code respeta cwd) ni
        // network_in (no hay servidor entrante).
        bypassPermissions: immutableSet([
            'file_read',
            'file_write_repo',
            'bash',
            'network_out',
            'child_spawn',
            'long_running_watcher',
            'tool_use_gated',
        ]),
        // `acceptEdits` — confirma reads, escrituras necesitan accept-all once.
        // Operativamente igual a bypass para skills pipeline (que no son
        // interactivos), pero semánticamente acepta MENOS — la tabla refleja
        // que el set de capabilities OTORGADO es el mismo (el harness no
        // discrimina capabilities entre acceptEdits y bypass, solo UX).
        acceptEdits: immutableSet([
            'file_read',
            'file_write_repo',
            'bash',
            'network_out',
            'child_spawn',
            'long_running_watcher',
            'tool_use_gated',
        ]),
        // `plan` — modo análisis. Lectura sí, escritura/bash NO,
        // tool_use_gated NO (los tools como Task están deshabilitados en plan).
        plan: immutableSet([
            'file_read',
            'network_out',
        ]),
    }),

    'openai-codex': Object.freeze({
        // `--full-auto` (equivalente conceptual al bypass de Anthropic).
        // CONSERVADOR: Codex CLI documenta auto-edit y auto-run sin confirm.
        // long_running_watcher y tool_use_gated quedan FUERA hasta verificar
        // empíricamente con H3 mergeado (CA-19).
        'full-auto': immutableSet([
            'file_read',
            'file_write_repo',
            'bash',
            'network_out',
            'child_spawn',
        ]),
        // `--no-confirm` (sinónimo en versiones viejas de codex).
        // Mismo set conservador que full-auto hasta CA-19.
        'no-confirm': immutableSet([
            'file_read',
            'file_write_repo',
            'bash',
            'network_out',
            'child_spawn',
        ]),
        // Modo default sin flags: read-only seguro.
        'default': immutableSet([
            'file_read',
            'network_out',
        ]),
    }),

    deterministic: Object.freeze({
        // Scripts Node puros del pipeline. Corren con permisos del usuario
        // que lanzó el pulpo (full filesystem + bash + network). No hay
        // harness limitándolos — la matriz refleja eso. La validación a
        // nivel skill no aplica porque los scripts determinísticos NO
        // declaran `required_permissions` (son Node puro auditado).
        'native': immutableSet([
            'file_read',
            'file_write_repo',
            'file_write_outside_repo',
            'bash',
            'network_out',
            'child_spawn',
            'long_running_watcher',
        ]),
    }),
});

// -----------------------------------------------------------------------------
// NON_DEGRADABLE_SKILLS (CA-S6 / CA-11) — hardcoded en código del lanzador.
//
// Skills que requieren capabilities altas (típicamente bash, child_spawn,
// tool_use_gated) y NO pueden correr en providers con capability set < requerido.
// Aun con override válido, estos skills son rechazados si el provider no
// satisface sus capabilities.
//
// Coherencia con #3065 §6.11 y #3075/CA-S3:
//   - `security`: análisis de superficie de ataque — necesita gated tools.
//   - `review`: análisis cross-file de PR — necesita gated tools.
//   - `builder`: builds Gradle reales — necesita bash + child_spawn.
//   - `tester`: ejecución de tests reales — necesita bash + child_spawn.
//   - `backend-dev`: refactors arquitecturales sensibles — necesita gated tools.
//
// La lista vive como `Set` frozen. NO leer de archivo editable.
// -----------------------------------------------------------------------------
const NON_DEGRADABLE_SKILLS = immutableSet([
    'security',
    'review',
    'builder',
    'tester',
    'backend-dev',
]);

// Path canónico del audit log de overrides. Se puede overridear en tests.
const DEFAULT_OVERRIDES_PATH = path.join(
    process.env.PIPELINE_REPO_ROOT || process.cwd(),
    '.pipeline', 'audit', 'permission-overrides.jsonl'
);

// -----------------------------------------------------------------------------
// grantedCapabilities — devuelve el Set frozen de capabilities concedidas por
// (provider, mode). Si no existe la combinación, devuelve null (fail-CLOSED).
// -----------------------------------------------------------------------------
function grantedCapabilities(provider, mode) {
    const byMode = CAPABILITY_MATRIX[provider];
    if (!byMode) return null;
    const set = byMode[mode];
    if (!set) return null;
    return set;
}

// -----------------------------------------------------------------------------
// missingCapabilities — devuelve las capabilities requeridas que NO están
// concedidas por el (provider, mode). Si granted es null, devuelve `required`
// completo + marca `modeUnknown: true`.
// -----------------------------------------------------------------------------
function missingCapabilities(required, provider, mode) {
    const granted = grantedCapabilities(provider, mode);
    if (granted === null) {
        return { missing: required.slice(), modeUnknown: true, granted: null };
    }
    const missing = required.filter(c => !granted.has(c));
    return { missing, modeUnknown: false, granted };
}

// -----------------------------------------------------------------------------
// findActiveOverride — busca en el JSONL un override válido para (skill, provider).
//
// Definición de "válido":
//   - skill y provider matchean exactamente
//   - created_at + ttl_horas*3600*1000 > now (no expirado)
//   - el skill NO está en NON_DEGRADABLE_SKILLS (CA-12: estos no admiten override)
//
// Devuelve la entrada matcheada o null. Si hay varios matches, devuelve el
// más reciente (último en el archivo).
// -----------------------------------------------------------------------------
function findActiveOverride({ skill, provider, now, overridesPath, fsImpl } = {}) {
    if (NON_DEGRADABLE_SKILLS.has(skill)) return null;

    const file = overridesPath || DEFAULT_OVERRIDES_PATH;
    const _fs = fsImpl || fs;
    if (!_fs.existsSync(file)) return null;

    let entries;
    try {
        entries = auditLog.readAll(file, _fs);
    } catch (e) {
        // Archivo corrupto — fail-CLOSED por seguridad.
        return null;
    }
    const nowMs = typeof now === 'number' ? now : Date.now();

    // Construir set de hashes revocados (revocation = entry append-only que
    // referencia el hash_self del override original via target_hash).
    const revokedHashes = new Set();
    for (const e of entries) {
        if (e && e.type === 'permission_override_revocation' && typeof e.target_hash === 'string') {
            revokedHashes.add(e.target_hash);
        }
    }

    // Iteramos del más reciente al más viejo para devolver el último activo.
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (!e || e.type !== 'permission_override') continue;
        if (e.skill !== skill || e.provider !== provider) continue;
        if (revokedHashes.has(e.hash_self)) continue;
        const ttlMs = (Number(e.ttl_horas) || 0) * 3600 * 1000;
        const expiresAt = (Number(e.created_at) || 0) + ttlMs;
        if (expiresAt <= nowMs) continue;
        return e;
    }
    return null;
}

// -----------------------------------------------------------------------------
// formatFailClosedMessage — produce el string del CA-10 (estructura asserteable
// por regex en test de paridad).
//
// El mensaje cumple G1/G6 de UX:
//   - 1 línea de cabecera con etiqueta `[FAIL-CLOSED]` greppable.
//   - bloque "Capability faltante:" con el nombre exacto.
//   - lista de capabilities concedidas por el provider/mode actual.
//   - 3 acciones numeradas (cambiar provider / crear override / consultar doc).
//   - anchor estable a la doc canónica.
//
// Para skills en NON_DEGRADABLE_SKILLS, agrega la nota CA-12 ("no admite
// override") y omite la acción 2 (crear override).
// -----------------------------------------------------------------------------
function formatFailClosedMessage({ skill, provider, mode, missing, granted, modeUnknown }) {
    const isNonDegradable = NON_DEGRADABLE_SKILLS.has(skill);
    const grantedList = granted ? Array.from(granted).sort().join(', ') : '<mode desconocido — no hay set de capabilities mapeado>';
    const missingFirst = missing[0] || '<capability requerida no declarada>';

    const lines = [];
    lines.push(`[FAIL-CLOSED] Skill '${skill}' no puede correr en provider '${provider}' (mode '${mode}').`);
    lines.push(`  Capability faltante: '${missingFirst}' (requerida por el skill).`);
    if (missing.length > 1) {
        lines.push(`  Capabilities adicionales faltantes: ${missing.slice(1).join(', ')}.`);
    }
    lines.push(`  Capabilities concedidas por ${provider}/${mode}: ${grantedList}.`);

    if (modeUnknown) {
        lines.push(`  Causa: mode '${mode}' no está mapeado en la matriz canónica para provider '${provider}'.`);
    }

    if (isNonDegradable) {
        lines.push(`  Este skill está marcado como NON_DEGRADABLE — no admite override.`);
        lines.push(`  Acciones posibles:`);
        lines.push(`    1) Cambiar provider del skill en agent-models.json a uno que conceda '${missingFirst}'.`);
        lines.push(`    2) Consultar tabla canónica: docs/pipeline-multi-provider/permission-mapping.md#capability-matrix`);
    } else {
        lines.push(`  Acciones posibles:`);
        lines.push(`    1) Cambiar provider del skill en agent-models.json a uno que conceda '${missingFirst}' (recomendado).`);
        lines.push(`    2) Crear override temporal: node .pipeline/scripts/override-permission.js --skill ${skill} --provider ${provider} --justify '<motivo>' --ttl-horas 24`);
        lines.push(`    3) Consultar tabla canónica: docs/pipeline-multi-provider/permission-mapping.md#capability-matrix`);
    }

    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// validateSpawn — API principal. Llamada en cada spawn (CA-S3 / CA-8).
//
// Inputs:
//   - skill (string): nombre del skill que va a lanzarse.
//   - provider (string): provider declarado para el skill (ya resuelto).
//   - mode (string): permission mode efectivo del provider para este skill.
//   - requiredCapabilities (string[]): capabilities declaradas por el skill.
//
// Output:
//   { ok: true, source: 'matrix'|'override' } → spawn autorizado.
//   { ok: false, message, missing[], reason } → spawn rechazado fail-CLOSED.
//
// Reason posibles para rechazo:
//   - 'capability_unknown' → el skill declaró una capability fuera del catálogo.
//   - 'mode_unknown' → (provider, mode) no está en la matriz.
//   - 'capability_missing' → requeridas no subset de granted.
//   - 'non_degradable' → skill non-degradable + capabilities faltantes.
// -----------------------------------------------------------------------------
function validateSpawn({ skill, provider, mode, requiredCapabilities, now, overridesPath, fsImpl } = {}) {
    if (!skill || typeof skill !== 'string') {
        return { ok: false, reason: 'invalid_args', message: '[FAIL-CLOSED] validateSpawn: parámetro "skill" requerido y string.' };
    }
    if (!provider || typeof provider !== 'string') {
        return { ok: false, reason: 'invalid_args', message: '[FAIL-CLOSED] validateSpawn: parámetro "provider" requerido y string.' };
    }
    if (!mode || typeof mode !== 'string') {
        return { ok: false, reason: 'invalid_args', message: '[FAIL-CLOSED] validateSpawn: parámetro "mode" requerido y string.' };
    }
    if (!Array.isArray(requiredCapabilities)) {
        return { ok: false, reason: 'invalid_args', message: '[FAIL-CLOSED] validateSpawn: parámetro "requiredCapabilities" debe ser array.' };
    }

    // 1. Validar que todas las capabilities declaradas estén en el catálogo.
    const catalogCheck = capabilities.validateRequiredCapabilities(requiredCapabilities);
    if (!catalogCheck.ok) {
        return {
            ok: false,
            reason: 'capability_unknown',
            unknown: catalogCheck.unknown,
            missing: [],
            message: `[FAIL-CLOSED] Skill '${skill}' declara capabilities fuera del catálogo: ${catalogCheck.unknown.join(', ')}.\n` +
                `  Catálogo canónico: lib/capabilities.js (KNOWN_CAPABILITIES).\n` +
                `  Doc: docs/pipeline-multi-provider/permission-mapping.md#capability-catalog`,
        };
    }

    // 2. Calcular missing contra la matriz canónica.
    const { missing, modeUnknown, granted } = missingCapabilities(requiredCapabilities, provider, mode);

    if (missing.length === 0 && !modeUnknown) {
        return { ok: true, source: 'matrix', granted };
    }

    // 3. NON_DEGRADABLE: rechazo inmediato sin override.
    if (NON_DEGRADABLE_SKILLS.has(skill)) {
        return {
            ok: false,
            reason: 'non_degradable',
            missing,
            modeUnknown,
            message: formatFailClosedMessage({ skill, provider, mode, missing, granted, modeUnknown }),
        };
    }

    // 4. Buscar override activo. Si encontramos, autorizamos pero marcamos
    //    `source: 'override'` para que el caller pueda auditarlo en logs.
    const override = findActiveOverride({ skill, provider, now, overridesPath, fsImpl });
    if (override) {
        return {
            ok: true,
            source: 'override',
            override_hash: override.hash_self,
            override_expires_at: (Number(override.created_at) || 0) + (Number(override.ttl_horas) || 0) * 3600 * 1000,
            granted,
            missing_originally: missing,
        };
    }

    // 5. Sin override: fail-CLOSED.
    return {
        ok: false,
        reason: modeUnknown ? 'mode_unknown' : 'capability_missing',
        missing,
        modeUnknown,
        message: formatFailClosedMessage({ skill, provider, mode, missing, granted, modeUnknown }),
    };
}

// -----------------------------------------------------------------------------
// validateAllSkillsAtBoot — corre validateSpawn para cada skill conocido del
// pipeline contra su provider configurado en agent-models. Pensado para
// llamarse desde pulpo.js al boot. Devuelve un array de fallos (vacío si OK).
//
// `skillsRegistry` es la fuente de verdad de qué skills existen + sus
// required_permissions. La carga la hace el caller (lib/skills-metadata.js
// — o equivalente). Acá solo iteramos.
// -----------------------------------------------------------------------------
function validateAllSkillsAtBoot({ skillsRegistry, resolveSkill, now, overridesPath, fsImpl } = {}) {
    const failures = [];
    if (!skillsRegistry || typeof skillsRegistry !== 'object') {
        return failures;
    }
    if (typeof resolveSkill !== 'function') {
        throw new Error('[permission-validator] validateAllSkillsAtBoot requiere `resolveSkill(skill) → {provider, mode}`.');
    }
    for (const [skill, meta] of Object.entries(skillsRegistry)) {
        const requiredCapabilities = (meta && Array.isArray(meta.required_permissions))
            ? meta.required_permissions
            : [];
        const resolved = resolveSkill(skill);
        if (!resolved || !resolved.provider || !resolved.mode) {
            failures.push({ skill, reason: 'resolve_failed', message: `[FAIL-CLOSED] No pude resolver provider/mode para skill '${skill}'.` });
            continue;
        }
        // Skills determinísticos: el gate no aplica (son Node puro auditado
        // que corre con permisos del usuario). Su SKILL.md puede declarar
        // capabilities como metadata aspiracional para la versión LLM, no
        // como contrato de runtime. Coherente con la lógica de agent-launcher.js.
        if (resolved.provider === 'deterministic') continue;
        const result = validateSpawn({
            skill,
            provider: resolved.provider,
            mode: resolved.mode,
            requiredCapabilities,
            now,
            overridesPath,
            fsImpl,
        });
        if (!result.ok) {
            failures.push({ skill, ...result });
        }
    }
    return failures;
}

// -----------------------------------------------------------------------------
// recordOverride — escribe una entry de override en el audit JSONL.
//
// Validaciones obligatorias:
//   - skill + provider strings no vacíos
//   - skill NO en NON_DEGRADABLE_SKILLS (CA-12)
//   - ttl_horas en [1, 168]
//   - justificacion ≥ 30 chars (CA-13)
//   - autor (git user) presente
//
// Path por defecto: .pipeline/audit/permission-overrides.jsonl.
// -----------------------------------------------------------------------------
function recordOverride({ skill, provider, mode_requerido, mode_otorgado, capabilities_diff, justificacion, autor, ttl_horas, overridesPath, fsImpl, nowMs } = {}) {
    if (!skill || typeof skill !== 'string') {
        throw new Error('[permission-validator] recordOverride: "skill" requerido (string).');
    }
    if (!provider || typeof provider !== 'string') {
        throw new Error('[permission-validator] recordOverride: "provider" requerido (string).');
    }
    if (NON_DEGRADABLE_SKILLS.has(skill)) {
        throw new Error(`[permission-validator] recordOverride: skill '${skill}' está marcado como NON_DEGRADABLE — no admite override.`);
    }
    if (!justificacion || typeof justificacion !== 'string' || justificacion.trim().length < 30) {
        throw new Error('[permission-validator] recordOverride: "justificacion" requerida (string ≥ 30 chars).');
    }
    if (!autor || typeof autor !== 'string') {
        throw new Error('[permission-validator] recordOverride: "autor" requerido (string).');
    }
    const ttl = Number(ttl_horas);
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > 168) {
        throw new Error('[permission-validator] recordOverride: "ttl_horas" debe estar entre 1 y 168 (7 días).');
    }
    if (!Array.isArray(capabilities_diff)) {
        throw new Error('[permission-validator] recordOverride: "capabilities_diff" debe ser array de capabilities adicionales otorgadas.');
    }

    const file = overridesPath || DEFAULT_OVERRIDES_PATH;
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    const entry = {
        type: 'permission_override',
        skill,
        provider,
        mode_requerido: mode_requerido || null,
        mode_otorgado: mode_otorgado || null,
        capabilities_diff,
        justificacion: justificacion.trim(),
        autor,
        ttl_horas: ttl,
        created_at: now,
    };

    const result = auditLog.appendChained({ file, entry, fsImpl });
    return { ...entry, hash_self: result.hash_self, hash_prev: result.hash_prev };
}

// -----------------------------------------------------------------------------
// revokeOverride — marca un override existente como revocado escribiendo
// una entry inversa con `revoked: true` que apunta al hash original.
//
// No mutamos la entry original (append-only). Cuando findActiveOverride busca,
// recorre todo el archivo y descarta overrides cuyo hash_self aparezca en
// otra entry con `type: 'permission_override_revocation', target_hash: <hash>`.
// -----------------------------------------------------------------------------
function revokeOverride({ targetHash, motivo, autor, overridesPath, fsImpl, nowMs } = {}) {
    if (!targetHash || typeof targetHash !== 'string') {
        throw new Error('[permission-validator] revokeOverride: "targetHash" requerido (string).');
    }
    if (!motivo || typeof motivo !== 'string' || motivo.trim().length < 10) {
        throw new Error('[permission-validator] revokeOverride: "motivo" requerido (string ≥ 10 chars).');
    }
    if (!autor || typeof autor !== 'string') {
        throw new Error('[permission-validator] revokeOverride: "autor" requerido (string).');
    }
    const file = overridesPath || DEFAULT_OVERRIDES_PATH;
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    const entry = {
        type: 'permission_override_revocation',
        target_hash: targetHash,
        motivo: motivo.trim(),
        autor,
        created_at: now,
    };
    const result = auditLog.appendChained({ file, entry, fsImpl });
    return { ...entry, hash_self: result.hash_self, hash_prev: result.hash_prev };
}

module.exports = {
    CAPABILITY_MATRIX,
    NON_DEGRADABLE_SKILLS,
    DEFAULT_OVERRIDES_PATH,
    grantedCapabilities,
    missingCapabilities,
    findActiveOverride,
    formatFailClosedMessage,
    validateSpawn,
    validateAllSkillsAtBoot,
    recordOverride,
    revokeOverride,
};
