// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

/**
 * #7635 — GATE DE PERMISOS DEL ENTORNO DE AGENTES (guard puro, sin I/O propio).
 *
 * Decide si un PR cambia lo que un hijo del pipeline puede recibir en su
 * entorno. Si hay motivos, delivery NO mergea: responde `needs-human` con gate
 * `permisos` y el operador lo revisa y mergea a mano. No hay label llave: el
 * pipeline opera con la misma cuenta que el operador (#5986), así que un label
 * se lo podría poner el propio agente.
 *
 * Qué se mira:
 *   - POR PATH (cualquier cambio: alta, baja, modificación o renombre, incluido
 *     `previous_filename`): `PATHS_SENSIBLES`.
 *   - POR CONTENIDO (base contra head, texto leído con `git show` por el caller;
 *     NUNCA `require()` de código del PR):
 *       · `.pipeline/agent-models.json`: `requires_credentials` por skill (alta,
 *         baja o modificación) y `credentials_env` / `auth_mode` por provider
 *         (definen qué key recibe el hijo). Un cambio sólo de provider/modelo de
 *         un skill NO cuenta.
 *       · `.pipeline/config.yaml`: `pipeline.env_isolation_enabled`.
 *       · `.pipeline/skills-deterministicos/delivery.js`: autoprotección — si la
 *         base invoca `detectPermissionChanges` y el head no, cuenta.
 *
 * Fail-closed: lista de archivos incompleta, `readAt*` que tira, archivo que
 * falta en base y head, o JSON/YAML que no parsea ⇒ motivo. Nunca "sin cambios".
 *
 * Los motivos son frases cortas generadas acá (nunca contenido del PR salvo
 * nombres de skill/provider revalidados con una regex de identificador).
 */

const PATHS_SENSIBLES = Object.freeze([
    '.pipeline/env-exceptions.yaml',
    '.pipeline/lib/child-env-scopes.json',
    '.pipeline/lib/child-env-exceptions.js',
    '.pipeline/lib/permission-change-guard.js',
    // Motor de permisos: aunque los datos viven en el JSON, este archivo arma
    // el env del hijo (transporte, reservadas, assert). Un cambio acá puede
    // ampliar el entorno igual que un scope.
    '.pipeline/lib/build-child-env.js',
]);

const AGENT_MODELS = '.pipeline/agent-models.json';
const CONFIG_YAML = '.pipeline/config.yaml';
const DELIVERY_JS = '.pipeline/skills-deterministicos/delivery.js';
const GUARD_SYMBOL = 'detectPermissionChanges';

const IDENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function normPath(p) {
    if (typeof p !== 'string') return null;
    let s = p.replace(/\\/g, '/').trim();
    while (s.startsWith('./')) s = s.slice(2);
    // Comparación sin mayúsculas: en Windows `Env-Exceptions.yaml` ES el mismo archivo.
    return s.toLowerCase();
}

function nombreSeguro(n) {
    return (typeof n === 'string' && IDENT.test(n)) ? n : '(nombre no imprimible)';
}

function basename(p) {
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Lee un archivo en base o head. Devuelve `{ ok: true, texto }` (texto null =
 * no existe en ese lado) o `{ ok: false }` si el lector tiró o no es función.
 */
function leer(reader, p) {
    if (typeof reader !== 'function') return { ok: false };
    try {
        const t = reader(p);
        if (t === null || t === undefined) return { ok: true, texto: null };
        return { ok: true, texto: String(t) };
    } catch {
        return { ok: false };
    }
}

function normRequires(v) {
    if (v === undefined) return '(sin declarar)';
    if (!Array.isArray(v)) return `(no-lista:${JSON.stringify(v)})`;
    return [...new Set(v.map(String))].sort().join(',');
}

function compararAgentModels(base, head, motivos) {
    const skillsB = (base && typeof base.skills === 'object' && base.skills) || {};
    const skillsH = (head && typeof head.skills === 'object' && head.skills) || {};
    const skills = new Set([...Object.keys(skillsB), ...Object.keys(skillsH)]);
    for (const s of [...skills].sort()) {
        const b = skillsB[s] && typeof skillsB[s] === 'object' ? skillsB[s].requires_credentials : undefined;
        const h = skillsH[s] && typeof skillsH[s] === 'object' ? skillsH[s].requires_credentials : undefined;
        if (normRequires(b) === normRequires(h)) continue;
        const tipo = b === undefined ? 'alta' : (h === undefined ? 'baja' : 'modificación');
        motivos.push(`requires_credentials: ${tipo} en skill ${nombreSeguro(s)}`);
    }
    const provB = (base && typeof base.providers === 'object' && base.providers) || {};
    const provH = (head && typeof head.providers === 'object' && head.providers) || {};
    const provs = new Set([...Object.keys(provB), ...Object.keys(provH)]);
    for (const p of [...provs].sort()) {
        for (const campo of ['credentials_env', 'auth_mode']) {
            const b = provB[p] && typeof provB[p] === 'object' ? provB[p][campo] : undefined;
            const h = provH[p] && typeof provH[p] === 'object' ? provH[p][campo] : undefined;
            if (JSON.stringify(b) !== JSON.stringify(h)) {
                motivos.push(`${campo}: cambio en provider ${nombreSeguro(p)}`);
            }
        }
    }
}

function flagAislamiento(doc) {
    return !!(doc && typeof doc === 'object' && doc.pipeline && typeof doc.pipeline === 'object'
        && doc.pipeline.env_isolation_enabled);
}

/**
 * @param {{ files: Array<{path:string, previous_filename?:string}|string>, filesComplete: boolean,
 *           readAtBase: (p:string)=>string|null, readAtHead: (p:string)=>string|null,
 *           yamlImpl?: object }} input
 * @returns {{ motivos: string[] }}
 */
function detectPermissionChanges(input = {}) {
    const motivos = [];
    try {
        const { files, filesComplete, readAtBase, readAtHead } = input || {};
        if (filesComplete !== true) motivos.push('lista de archivos incompleta (≥100 o desconocida)');
        if (!Array.isArray(files)) {
            motivos.push('lista de archivos ausente');
            return { motivos };
        }

        const sensibles = new Map(PATHS_SENSIBLES.map((p) => [p.toLowerCase(), p]));
        const tocados = new Set();
        for (const f of files) {
            const actual = normPath(typeof f === 'string' ? f : (f && f.path));
            const previo = normPath(f && typeof f === 'object' ? f.previous_filename : null);
            if (actual === null) {
                motivos.push('entrada de archivo ilegible en la lista del PR');
                continue;
            }
            tocados.add(actual);
            if (previo) tocados.add(previo);
        }
        for (const [lower, canonico] of sensibles) {
            if (tocados.has(lower)) motivos.push(`${basename(canonico)} modificado (alta, baja, cambio o renombre)`);
        }

        const contenido = (p, fn) => {
            if (!tocados.has(p.toLowerCase())) return;
            const b = leer(readAtBase, p);
            const h = leer(readAtHead, p);
            if (!b.ok || !h.ok) {
                motivos.push(`${basename(p)}: no se pudo leer base o head (fail-closed)`);
                return;
            }
            if (b.texto === null && h.texto === null) {
                motivos.push(`${basename(p)}: no existe ni en base ni en head (fail-closed)`);
                return;
            }
            fn(b.texto, h.texto);
        };

        contenido(AGENT_MODELS, (bt, ht) => {
            if (bt === null || ht === null) {
                motivos.push(`agent-models.json ${bt === null ? 'creado' : 'borrado'} (cambia los defaults de credenciales)`);
                return;
            }
            let b; let h;
            try { b = JSON.parse(bt); h = JSON.parse(ht); } catch {
                motivos.push('agent-models.json ilegible en base o head (fail-closed)');
                return;
            }
            compararAgentModels(b, h, motivos);
        });

        contenido(CONFIG_YAML, (bt, ht) => {
            if (bt === null || ht === null) {
                motivos.push(`config.yaml ${bt === null ? 'creado' : 'borrado'} (fail-closed)`);
                return;
            }
            let yaml;
            try { yaml = input.yamlImpl || require('js-yaml'); } catch {
                motivos.push('config.yaml: parser YAML no disponible (fail-closed)');
                return;
            }
            let b; let h;
            try {
                b = yaml.load(bt, { schema: yaml.JSON_SCHEMA });
                h = yaml.load(ht, { schema: yaml.JSON_SCHEMA });
            } catch {
                motivos.push('config.yaml ilegible en base o head (fail-closed)');
                return;
            }
            const fb = flagAislamiento(b);
            const fh = flagAislamiento(h);
            if (fb !== fh) motivos.push(`env_isolation_enabled: ${fb} → ${fh}`);
        });

        contenido(DELIVERY_JS, (bt, ht) => {
            const baseLoInvoca = bt !== null && bt.includes(GUARD_SYMBOL);
            const headLoInvoca = ht !== null && ht.includes(GUARD_SYMBOL);
            if (baseLoInvoca && !headLoInvoca) motivos.push('delivery.js deja de invocar el gate de permisos');
        });
    } catch {
        motivos.push('error inesperado evaluando el gate de permisos (fail-closed)');
    }
    return { motivos: [...new Set(motivos)] };
}

module.exports = {
    detectPermissionChanges,
    PATHS_SENSIBLES,
    AGENT_MODELS,
    CONFIG_YAML,
    DELIVERY_JS,
    GUARD_SYMBOL,
};
