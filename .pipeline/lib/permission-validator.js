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
        // Codex CLI en full-auto corre auto-edit y auto-run sin confirmación,
        // usa herramientas gated del harness (Task/MCP) y sostiene procesos de
        // larga duración igual que Claude Code en bypass.
        //
        // CA-19 RESUELTO (2026-06-04): la verificación empírica pendiente de H3
        // se cerró en la prueba real Fase 2 del multi-provider. El launcher real
        // saltó a Codex y el ÚNICO bloqueante fue esta misma celda excluyendo
        // `tool_use_gated`/`long_running_watcher` por conservadurismo — no una
        // limitación real del provider. Se concede el set completo de agente
        // autónomo (idéntico a anthropic/bypassPermissions). file_write_outside_repo,
        // bash_elevated y network_in siguen FUERA (Codex respeta el cwd y no abre
        // servidor entrante), igual que Claude Code.
        'full-auto': immutableSet([
            'file_read',
            'file_write_repo',
            'bash',
            'network_out',
            'child_spawn',
            'long_running_watcher',
            'tool_use_gated',
        ]),
        // `--no-confirm` (sinónimo en versiones viejas de codex).
        // Mismo set autónomo que full-auto tras CA-19.
        'no-confirm': immutableSet([
            'file_read',
            'file_write_repo',
            'bash',
            'network_out',
            'child_spawn',
            'long_running_watcher',
            'tool_use_gated',
        ]),
        // Modo default sin flags: read-only seguro.
        'default': immutableSet([
            'file_read',
            'network_out',
        ]),
    }),

    // -------------------------------------------------------------------------
    // FREE PROVIDERS (#3220 / #3243) — gemini-google, cerebras, nvidia-nim.
    //
    // Defecto #2 del portero (#3820): estos tres providers figuran en las
    // cadenas de fallback de agent-models.json (resuelven a mode
    // `bypassPermissions` vía resolvePermissionMode) pero NO tenían celda en la
    // matriz → todo salto hacia ellos fallaba `mode_unknown` (fail-CLOSED).
    //
    // Corren como agentes autónomos del pipeline (CLIs propios) haciendo el
    // mismo trabajo de dev/qa/análisis que Claude/Codex en modo autónomo. Por
    // diseño conceden el set autónomo completo (idéntico a anthropic/bypass),
    // SALVO file_write_outside_repo / bash_elevated / network_in que ningún
    // provider del pipeline concede al spawn.
    //
    // PROVISIONAL hasta #3198 (runtime real de wrappers): los handlers hoy son
    // stubs. Cuando #3198 ejecute el binario real y un provider concreto
    // demuestre conceder MENOS, esta celda se recorta (mismo flujo que CA-19
    // para Codex: doc + parity test + CODEOWNERS).
    // -------------------------------------------------------------------------
    'gemini-google': Object.freeze({
        bypassPermissions: immutableSet([
            'file_read',
            'file_write_repo',
            'bash',
            'network_out',
            'child_spawn',
            'long_running_watcher',
            'tool_use_gated',
        ]),
    }),
    cerebras: Object.freeze({
        bypassPermissions: immutableSet([
            'file_read',
            'file_write_repo',
            'bash',
            'network_out',
            'child_spawn',
            'long_running_watcher',
            'tool_use_gated',
        ]),
    }),
    'nvidia-nim': Object.freeze({
        bypassPermissions: immutableSet([
            'file_read',
            'file_write_repo',
            'bash',
            'network_out',
            'child_spawn',
            'long_running_watcher',
            'tool_use_gated',
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

// -----------------------------------------------------------------------------
// Política de confianza en la cadena del operador (#3820 / corrección 2026-06-04).
//
// HISTORIA: #3820 introdujo `FULL_TRUST_PROVIDERS = {anthropic}` para impedir que
// los skills NON_DEGRADABLE corrieran en Codex/free aun cuando esas celdas (tras
// corregir los defectos #2 y #3) ya concedían el set autónomo completo. Era un
// portón a nivel provider que bloqueaba un provider TÉCNICAMENTE CAPAZ sólo por
// no ser "de confianza plena".
//
// DECISIÓN (Leo, operador): esa regla está mal. El orden de la cadena de fallback
// lo configura el operador en `agent-models.json`; si pone un provider en la lista,
// es una decisión deliberada y el portero debe CONFIAR en ella. El validador valida
// **capacidades técnicas** (¿el provider concede los tools que el skill necesita?),
// NO calidad ni jerarquía de confianza del provider. Por eso se elimina el portón
// `FULL_TRUST_PROVIDERS`: un skill NON_DEGRADABLE corre en cualquier provider de la
// cadena que conceda todas sus capabilities.
//
// Qué SIGUE protegiendo NON_DEGRADABLE_SKILLS (sigue siendo capability-based, no de
// confianza): estos skills críticos no se ejecutan con capabilities faltantes y NO
// admiten override que los degrade (ver bloque 3b en validateSpawn y findActiveOverride).
// -----------------------------------------------------------------------------

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

    // 3. Cadena del operador respetada (#3820 / corrección 2026-06-04): si el
    //    provider concede TODAS las capabilities requeridas, se autoriza —
    //    incluso para skills NON_DEGRADABLE en Codex/free. El portero confía en
    //    el orden de la cadena que configuró el operador; sólo valida capacidad
    //    técnica, no jerarquía de confianza del provider.
    if (missing.length === 0 && !modeUnknown) {
        return { ok: true, source: 'matrix', granted };
    }

    // 3b. NON_DEGRADABLE con capabilities faltantes: rechazo sin override (estos
    //     skills críticos no se degradan ni con override). Es un chequeo de
    //     CAPACIDAD, no de confianza — sólo dispara si el provider de la cadena
    //     NO concede algo que el skill necesita.
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
// pipeline contra su(s) provider(s) configurado(s) en agent-models. Pensado para
// llamarse desde pulpo.js al boot. Devuelve un array de fallos (vacío si OK).
//
// `skillsRegistry` es la fuente de verdad de qué skills existen + sus
// required_permissions. La carga la hace el caller (lib/skills-metadata.js
// — o equivalente). Acá solo iteramos.
//
// #4274 (CA-4 / SR-3) — validación CHAIN-AWARE: antes solo se validaba el
// provider primario (`resolveSkill(skill) → {provider, mode}`), por lo que una
// combinación inválida `(provider de fallback × modo)` era invisible al boot y
// recién explotaba en runtime (incidente 23:20 ART del 28/06). Ahora, si el
// caller pasa `resolveSkillChain(skill) → [{provider, mode}, …]` (primario +
// fallbacks), se valida CADA eslabón de la cadena. `resolveSkill` (single) se
// mantiene por compat: si no se pasa `resolveSkillChain`, se usa el primario.
// -----------------------------------------------------------------------------
function validateAllSkillsAtBoot({ skillsRegistry, resolveSkill, resolveSkillChain, now, overridesPath, fsImpl } = {}) {
    const failures = [];
    if (!skillsRegistry || typeof skillsRegistry !== 'object') {
        return failures;
    }
    if (typeof resolveSkill !== 'function' && typeof resolveSkillChain !== 'function') {
        throw new Error('[permission-validator] validateAllSkillsAtBoot requiere `resolveSkill(skill) → {provider, mode}` o `resolveSkillChain(skill) → [{provider, mode}, …]`.');
    }
    for (const [skill, meta] of Object.entries(skillsRegistry)) {
        const requiredCapabilities = (meta && Array.isArray(meta.required_permissions))
            ? meta.required_permissions
            : [];

        // Construir la cadena (primario + fallbacks) o caer al primario solo.
        let chain;
        if (typeof resolveSkillChain === 'function') {
            chain = resolveSkillChain(skill);
        } else {
            const single = resolveSkill(skill);
            chain = single ? [single] : null;
        }
        if (!Array.isArray(chain) || chain.length === 0) {
            failures.push({ skill, reason: 'resolve_failed', message: `[FAIL-CLOSED] No pude resolver la cadena provider/mode para skill '${skill}'.` });
            continue;
        }

        for (const link of chain) {
            if (!link || !link.provider || !link.mode) {
                failures.push({
                    skill,
                    provider: (link && link.provider) || null,
                    reason: 'resolve_failed',
                    message: `[FAIL-CLOSED] Eslabón de cadena sin provider/mode resoluble para skill '${skill}' (provider='${(link && link.provider) || '?'}', mode='${(link && link.mode) || '?'}').`,
                });
                continue;
            }
            // Skills determinísticos: el gate no aplica (son Node puro auditado
            // que corre con permisos del usuario). Su SKILL.md puede declarar
            // capabilities como metadata aspiracional para la versión LLM, no
            // como contrato de runtime. Coherente con agent-launcher.js.
            if (link.provider === 'deterministic') continue;
            const result = validateSpawn({
                skill,
                provider: link.provider,
                mode: link.mode,
                requiredCapabilities,
                now,
                overridesPath,
                fsImpl,
            });
            if (!result.ok) {
                failures.push({ skill, ...result });
            }
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
