#!/usr/bin/env node
// =============================================================================
// planner-waves-cli.js — CLI invocable desde el skill `/planner` (#3488 H2).
//
// Comandos:
//   node .pipeline/scripts/planner-waves-cli.js olas
//   node .pipeline/scripts/planner-waves-cli.js horizonte <N>
//   node .pipeline/scripts/planner-waves-cli.js componer-ola <N> [--force]
//   node .pipeline/scripts/planner-waves-cli.js componer-ola <N> --json
//     (formato solo-JSON para consumo programático downstream)
//   node .pipeline/scripts/planner-waves-cli.js roadmap
//     (#4376 — vista unificada: activa / planificadas / archivadas con issues)
//   node .pipeline/scripts/planner-waves-cli.js crear-ola --nombre <n>
//     --concurrency <c> --window <m> --issues <#a #b> [--objetivo <o>]
//     (#4376 — crea una ola planificada sin editar waves.json a mano)
//
// Diseño:
//   - I/O del filesystem (waves.json) → lib/waves.js (entregado por #3489 H1).
//   - GitHub API (`gh issue list`) → child_process.spawnSync, NO via libs ajenas.
//     Single point para sanitizar argumentos y cap `--limit 200` (SEC-6).
//   - Lógica pura de composición → lib/planner-waves.js.
//   - Esta capa solo orquesta: parsea argv, llama gh, llama waves, llama lib,
//     imprime markdown.
//
// Códigos de salida:
//   0 — éxito (incluso si la composición devuelve "ola vacía", es output válido)
//   1 — error de parseo de argv (input inválido)
//   2 — error de schema (waves.json corrupto)
//   3 — error de gh (no se pudo listar issues)
//   4 — uso incorrecto del comando
// =============================================================================

'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const waves = require('../lib/waves');
const pw = require('../lib/planner-waves');

const PIPELINE_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PIPELINE_ROOT, 'config.yaml');

// ─── Helpers ──────────────────────────────────────────────────────────────

function die(code, msg) {
    process.stderr.write(`[planner-waves-cli] ${msg}\n`);
    process.exit(code);
}

function loadCapacityConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        const cfg = yaml.load(raw);
        const wavesCfg = (cfg && cfg.waves) || {};
        return {
            capacity: Number.isInteger(wavesCfg.capacity) && wavesCfg.capacity > 0
                ? wavesCfg.capacity
                : pw.DEFAULT_CAPACITY,
            max_horizon: Number.isInteger(wavesCfg.max_horizon) && wavesCfg.max_horizon > 0
                ? wavesCfg.max_horizon
                : pw.DEFAULT_MAX_HORIZON,
        };
    } catch (err) {
        // No abortamos: usamos defaults para mantener la operación.
        process.stderr.write(`[planner-waves-cli] WARN: no se pudo leer config.yaml waves: ${err.message}. Usando defaults.\n`);
        return { capacity: pw.DEFAULT_CAPACITY, max_horizon: pw.DEFAULT_MAX_HORIZON };
    }
}

/**
 * Invoca `gh issue list` con `--limit 200` (SEC-6). Si gh no está disponible
 * o falla, devuelve [] + log de warn (NO aborta — operación degradada con
 * mensaje claro al usuario).
 *
 * Adicional: argumentos hardcoded — no aceptamos labels arbitrarios del
 * usuario para evitar injection en el array de argv (ya es array, no shell
 * string, pero defensa en profundidad).
 */
function ghIssueList(label) {
    // Whitelist estricta para defensa en profundidad — solo 2 labels válidos acá.
    if (label !== 'Ready' && label !== 'needs-definition') {
        throw new Error(`ghIssueList: label no permitido (${label})`);
    }
    const repo = process.env.GH_REPO || 'intrale/platform';
    const args = [
        'issue', 'list',
        '--repo', repo,
        '--state', 'open',
        '--label', label,
        '--limit', '200',
        '--json', 'number,title,labels',
    ];
    const res = spawnSync('gh', args, { encoding: 'utf8', shell: false });
    if (res.error) {
        process.stderr.write(`[planner-waves-cli] WARN: gh ${args.join(' ')} → ${res.error.message}\n`);
        return { issues: [], truncated: false };
    }
    if (res.status !== 0) {
        process.stderr.write(`[planner-waves-cli] WARN: gh exit ${res.status}: ${(res.stderr || '').slice(0, 500)}\n`);
        return { issues: [], truncated: false };
    }
    let parsed;
    try {
        parsed = JSON.parse(res.stdout);
    } catch (err) {
        process.stderr.write(`[planner-waves-cli] WARN: gh output no es JSON: ${err.message}\n`);
        return { issues: [], truncated: false };
    }
    if (!Array.isArray(parsed)) return { issues: [], truncated: false };
    return {
        issues: parsed,
        truncated: parsed.length >= 200, // si pegamos el cap, hay más afuera
    };
}

function fetchOpenIssueNumbers() {
    // Para el carry-over necesitamos saber qué issues siguen open.
    // Usamos un solo gh list "todos los open" sin filtro de label.
    const repo = process.env.GH_REPO || 'intrale/platform';
    const res = spawnSync('gh', [
        'issue', 'list',
        '--repo', repo,
        '--state', 'open',
        '--limit', '500',
        '--json', 'number',
    ], { encoding: 'utf8', shell: false });
    if (res.error || res.status !== 0) return null; // null = "no sabemos"; carry-over no filtra
    try {
        const arr = JSON.parse(res.stdout);
        if (!Array.isArray(arr)) return null;
        return new Set(arr.map((i) => Number(i.number)).filter(Number.isFinite));
    } catch {
        return null;
    }
}

// ─── Comandos ─────────────────────────────────────────────────────────────

function cmdOlas() {
    const wavesList = waves.listWaves();
    process.stdout.write(pw.renderOlasList(wavesList));
    process.stdout.write('\n');
}

function cmdHorizonte(rawN) {
    let N;
    try {
        N = pw.parseHorizon(rawN);
    } catch (err) {
        die(1, err.message);
    }

    const state = waves.loadWaves();
    try {
        pw.assertWaveState(state);
    } catch (err) {
        die(2, err.message);
    }

    const cfg = loadCapacityConfig();
    const ready = ghIssueList('Ready');
    const needsDef = ghIssueList('needs-definition');
    const openSet = fetchOpenIssueNumbers() || new Set();

    // Punto de partida: ola activa + 1 (siguiente planeada).
    const activeNum = state.active_wave ? Number(state.active_wave.number) : 0;
    const startNum = activeNum + 1;

    const horizonResults = pw.composeHorizon({
        startWaveNumber: startNum,
        horizon: N,
        wavesState: state,
        readyIssues: ready.issues,
        needsDefIssues: needsDef.issues,
        openIssueNumbers: openSet,
        capacity: cfg.capacity,
    });

    // Backlog stats global post-horizonte (último resultado tiene el remanente).
    const last = horizonResults[horizonResults.length - 1];
    const remStats = last ? last.backlog_remaining : { ready: 0, needs_definition: 0 };

    process.stdout.write(pw.renderHorizon(horizonResults, remStats));
    if (ready.truncated || needsDef.truncated) {
        process.stdout.write('\n⚠️ Backlog con +200 issues — considerar archivar issues viejos. Los listados están truncados por seguridad (`--limit 200`).\n');
    }
    process.stdout.write('\n');
}

function cmdComponerOla(rawN, opts) {
    let N;
    try {
        N = pw.parseWaveNum(rawN);
    } catch (err) {
        die(1, err.message);
    }

    const state = waves.loadWaves();
    try {
        pw.assertWaveState(state);
    } catch (err) {
        die(2, err.message);
    }

    // SEC-5: idempotencia. Si la ola ya existe (activa o planificada), exigir --force.
    const planned = (state.planned_waves || []).find((w) => Number(w.number) === N);
    const isActive = state.active_wave && Number(state.active_wave.number) === N;
    if ((planned || isActive) && !opts.force) {
        const target = planned || state.active_wave;
        target.status = isActive ? 'active' : 'planned';
        process.stdout.write(pw.renderAlreadyComposed(target));
        return;
    }

    const cfg = loadCapacityConfig();
    const ready = ghIssueList('Ready');
    const needsDef = ghIssueList('needs-definition');
    const openSet = fetchOpenIssueNumbers() || new Set();

    // PreviousWave: la ola N-1 (busca primero en planned, luego en activa, luego archived).
    let previousWave = null;
    const allWaves = [
        ...(state.active_wave ? [{ ...state.active_wave, status: 'active' }] : []),
        ...(state.planned_waves || []).map((w) => ({ ...w, status: 'planned' })),
        ...(state.archived_waves || []).map((w) => ({ ...w, status: 'archived' })),
    ];
    previousWave = allWaves.find((w) => Number(w.number) === N - 1) || null;

    const result = pw.composeWave({
        waveNumber: N,
        previousWave,
        readyIssues: ready.issues,
        needsDefIssues: needsDef.issues,
        wavesState: state,
        openIssueNumbers: openSet,
        capacity: cfg.capacity,
    });

    // CA-V1: si quedó vacío, mensaje específico y NO mutación.
    if (result.issues.length === 0) {
        const stats = {
            ready: ready.issues.length,
            needs_definition: needsDef.issues.length,
        };
        process.stdout.write(pw.renderEmptyBacklog(N, stats));
        return;
    }

    if (opts.jsonOnly) {
        // Solo el bloque JSON, sin markdown — útil para pipes downstream.
        const md = pw.renderComposeWave(result);
        const jsonMatch = md.match(/```json\n([\s\S]+?)\n```/);
        if (jsonMatch) {
            process.stdout.write(jsonMatch[1] + '\n');
        } else {
            process.stdout.write(JSON.stringify(result) + '\n');
        }
        return;
    }

    process.stdout.write(pw.renderComposeWave(result));
    process.stdout.write('\n');

    if (ready.truncated || needsDef.truncated) {
        process.stdout.write('\n⚠️ Backlog con +200 issues — considerar archivar issues viejos.\n');
    }
}

// #4376 (split #4351) — crear-ola: crea una ola planificada sin editar el JSON
// a mano. Reusa `createPlannedWave` (único punto de mutación, CA-3) y la MISMA
// validación de input que el subcomando Commander `/wave create`
// (`lib/wave-create-input`, CA-4). Flags: --nombre --objetivo --concurrency
// --window --issues. Numeración auto-asignada (Opción A, cerrada por PO).
function cmdCrearOla(rawArgs) {
    const wci = require('../lib/wave-create-input');
    // argv es un array (no shell string) → reconstruimos la cadena de flags para
    // el parser de flags nombrados con valores que pueden contener espacios. No
    // se concatena input a paths ni comandos (A03 command/path injection).
    const raw = Array.isArray(rawArgs) ? rawArgs.join(' ') : String(rawArgs || '');
    const flags = wci.parseNamedFlags(raw);
    const res = wci.validateCreateInput(flags);
    if (!res.ok) {
        die(1, `input inválido (${res.field}): ${res.error}`);
    }

    let created;
    try {
        created = waves.createPlannedWave(res.spec, {
            updated_by: process.env.USER || process.env.USERNAME || 'operator-local',
            source: 'planner-waves-cli/crear-ola',
            note: `create planned wave "${res.spec.name}" con ${res.spec.issues.length} issue(s)`,
        });
    } catch (err) {
        // Errores semánticos del core (duplicado nombre/issue, bounds) → mensaje
        // accionable + exit 1 (input inválido). Sin escritura parcial (atómico).
        die(1, `no se pudo crear la ola: ${err.message}`);
        return;
    }

    process.stdout.write(renderCrearOlaOk(created));
    process.stdout.write('\n');
}

function renderCrearOlaOk(created) {
    const w = created.wave;
    const lines = [
        `✅ Ola ${created.waveNumber} creada — ${w.name}`,
    ];
    if (w.goal) lines.push(`   🎯 Objetivo: ${w.goal}`);
    lines.push(`   ⏱ Ventana: ${w.window_minutes} min · ⚙️ Concurrency: ${w.concurrency_max}`);
    lines.push(`   📦 Issues (${w.issues.length}): ${w.issues.map((i) => '#' + i.number).join(', ')}`);
    lines.push('   (número auto-asignado · active_wave intacta · waves.json versionado atómicamente)');
    return lines.join('\n');
}

// #4376 — roadmap: vista unificada del roadmap completo reusando `listWaves()`.
// Muestra las tres categorías (activa / planificadas en orden asc / archivadas
// más recientes primero), cada una con sus issues (CA-2). Categoría vacía →
// placeholder claro (UX-1). Consistente con `/wave status` en Commander (UX-4).
function cmdRoadmap() {
    const wavesList = waves.listWaves();
    process.stdout.write(renderRoadmap(wavesList));
    process.stdout.write('\n');
}

function renderRoadmap(wavesList) {
    const list = Array.isArray(wavesList) ? wavesList : [];
    const active = list.filter((w) => w.status === 'active');
    const planned = list
        .filter((w) => w.status === 'planned')
        .sort((a, b) => Number(a.number) - Number(b.number));
    const archived = list
        .filter((w) => w.status === 'archived' || w.status === 'closed')
        .sort((a, b) => Number(b.number) - Number(a.number));

    const fmtIssues = (w) => {
        if (!Array.isArray(w.issues) || w.issues.length === 0) return '(sin issues)';
        return w.issues
            .map((i) => (i && typeof i === 'object' ? '#' + i.number : '#' + i))
            .join(', ');
    };
    const fmtWave = (w) => {
        const head = `  • Ola ${w.number} — ${w.name || '(sin nombre)'}`;
        const goal = w.goal ? `\n    Objetivo: ${w.goal}` : '';
        return `${head}${goal}\n    Issues: ${fmtIssues(w)}`;
    };

    const out = ['## Roadmap de olas', ''];

    out.push('🟢 Activa');
    out.push(active.length ? active.map(fmtWave).join('\n') : '  — sin ola activa —');
    out.push('');

    out.push('🟡 Planificadas (orden ascendente)');
    out.push(planned.length ? planned.map(fmtWave).join('\n') : '  — sin olas planificadas —');
    out.push('');

    out.push('✅ Archivadas (más recientes primero)');
    out.push(archived.length ? archived.map(fmtWave).join('\n') : '  — sin olas archivadas —');

    return out.join('\n');
}

// ─── Entry point ──────────────────────────────────────────────────────────

function main(argv) {
    const [, , cmd, ...rest] = argv;
    if (!cmd) {
        die(4, 'Uso: olas | roadmap | horizonte <N> | componer-ola <N> [--force] [--json] | crear-ola --nombre <n> --concurrency <c> --window <m> --issues <#a #b> [--objetivo <o>]');
    }

    const opts = {
        force: rest.includes('--force'),
        jsonOnly: rest.includes('--json'),
    };
    const positional = rest.filter((x) => !x.startsWith('--'));

    switch (cmd) {
        case 'olas':
            return cmdOlas();
        case 'horizonte':
            if (positional.length < 1) die(4, 'Uso: horizonte <N>');
            return cmdHorizonte(positional[0]);
        case 'componer-ola':
            if (positional.length < 1) die(4, 'Uso: componer-ola <N> [--force] [--json]');
            return cmdComponerOla(positional[0], opts);
        case 'crear-ola':
            return cmdCrearOla(rest);
        case 'roadmap':
            return cmdRoadmap();
        default:
            die(4, `Comando desconocido: ${cmd}. Válidos: olas, roadmap, horizonte, componer-ola, crear-ola`);
    }
}

if (require.main === module) {
    try {
        main(process.argv);
    } catch (err) {
        die(1, `error inesperado: ${err.message}`);
    }
}

module.exports = {
    main,
    loadCapacityConfig,
    ghIssueList,
    fetchOpenIssueNumbers,
    // #4376 — exports para tests de la vista roadmap y creación de olas.
    renderRoadmap,
    renderCrearOlaOk,
    cmdCrearOla,
    cmdRoadmap,
};
