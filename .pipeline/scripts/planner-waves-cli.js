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

// ─── Entry point ──────────────────────────────────────────────────────────

function main(argv) {
    const [, , cmd, ...rest] = argv;
    if (!cmd) {
        die(4, 'Uso: olas | horizonte <N> | componer-ola <N> [--force] [--json]');
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
        default:
            die(4, `Comando desconocido: ${cmd}. Válidos: olas, horizonte, componer-ola`);
    }
}

if (require.main === module) {
    try {
        main(process.argv);
    } catch (err) {
        die(1, `error inesperado: ${err.message}`);
    }
}

module.exports = { main, loadCapacityConfig, ghIssueList, fetchOpenIssueNumbers };
