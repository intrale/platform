#!/usr/bin/env node
// =============================================================================
// audit-paraguas-resuelto.js — #6801 CA-7
//
// Auditoría del radio de impacto del auto-cierre espurio de paraguas.
//
// El brazo de desbloqueo cerraba como `completed` cualquier issue con el label
// `split` cuando sus DEPENDENCIAS cerraban, confundiéndolas con sus hijas. Como
// el label `split` lo llevan tanto el paraguas como cada `[Split de #N]`, se
// llevó puestas historias hijas que nunca se implementaron.
//
// Este script recorre los issues cerrados que tienen el comentario del brazo y
// reabre SOLO los que cumplen las TRES condiciones (la clasificación es pura y
// vive en `lib/brazo-desbloqueo-core.classifySpuriousUmbrellaClose`):
//
//   a) el título es `[Split de #N]`  → es una hija, no un paraguas
//   b) la cerró el brazo             → comentario "Paraguas resuelto" + firma
//   c) no tiene PR asociado          → `closedByPullRequestsReferences` vacío
//
// La condición (c) es la que evita destruir trabajo legítimo: #5797 volvió a
// cerrar con PR real (#6806) y NO debe reabrirse aunque el comentario espurio
// siga en su historial.
//
// Uso:
//   node .pipeline/bin/audit-paraguas-resuelto.js            # dry-run (default)
//   node .pipeline/bin/audit-paraguas-resuelto.js --apply    # reabre de verdad
//   node .pipeline/bin/audit-paraguas-resuelto.js --limit 60
//   node .pipeline/bin/audit-paraguas-resuelto.js --issues 5798,5799
//
// Es idempotente: un issue ya reabierto queda en estado OPEN y el clasificador
// lo descarta con `no-esta-cerrado` en la corrida siguiente.
// =============================================================================

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const { classifySpuriousUmbrellaClose } = require(path.join(__dirname, '..', 'lib', 'brazo-desbloqueo-core'));
const { parseSplitParent } = require(path.join(__dirname, '..', 'lib', 'split-guard'));

const REPO = process.env.PIPELINE_AUDIT_REPO || 'intrale/platform';
const GH_BIN = process.env.GH_BIN || 'gh';

function parseArgs(argv) {
    const out = { apply: false, limit: 60, issues: null };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--apply') out.apply = true;
        else if (a === '--limit') out.limit = Math.max(1, Number.parseInt(argv[++i], 10) || 60);
        else if (a === '--issues') {
            out.issues = String(argv[++i] || '')
                .split(',')
                .map((n) => Number.parseInt(n.trim(), 10))
                .filter((n) => Number.isInteger(n) && n > 0);
        }
    }
    return out;
}

function gh(args) {
    return execFileSync(GH_BIN, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

// Candidatos: issues CERRADOS que mencionan el texto del comentario del brazo.
// La búsqueda es sólo el embudo — quien decide es el clasificador puro.
function buscarCandidatos(limit) {
    try {
        const raw = gh(['search', 'issues', '--repo', REPO, 'Paraguas resuelto',
            '--state', 'closed', '--limit', String(limit), '--json', 'number']);
        const list = JSON.parse(raw || '[]');
        return list.map((i) => Number(i.number)).filter((n) => Number.isInteger(n) && n > 0);
    } catch (e) {
        console.error(`[ERROR] búsqueda de candidatos falló: ${e.message}`);
        return [];
    }
}

function verIssue(n) {
    try {
        const raw = gh(['issue', 'view', String(n), '--repo', REPO, '--json',
            'number,title,state,comments,closedByPullRequestsReferences']);
        return JSON.parse(raw);
    } catch (e) {
        console.error(`[ERROR] no se pudo leer #${n}: ${e.message}`);
        return null;
    }
}

// Un hijo de split puede haber sido re-partido y ser, a su vez, padre de otras
// hijas. Si TODAS sus propias sub-historias están cerradas, su cierre quedó
// cubierto por el trabajo real aunque el comentario que lo cerró fuera espurio:
// reabrirlo sería ensuciar el backlog con un issue sin trabajo pendiente.
function hijasPropias(numero) {
    try {
        const raw = gh(['issue', 'list', '--repo', REPO, '--search', `"[Split de #${numero}]" in:title`,
            '--state', 'all', '--json', 'number,title,state', '--limit', '50']);
        const list = JSON.parse(raw || '[]');
        return (Array.isArray(list) ? list : []).filter(
            (i) => i && parseSplitParent(i.title || '') === Number(numero)
        );
    } catch (e) {
        // Fail-closed hacia la reapertura: si no se puede verificar la cobertura,
        // se reabre. Un issue abierto de más se cierra a mano; uno cerrado de
        // menos se pierde en silencio, que es justamente el daño de #6801.
        console.error(`     [WARN] no se pudieron listar las hijas de #${numero}: ${e.message}`);
        return [];
    }
}

function reabrir(issue, veredicto) {
    const comment = [
        '## ♻️ Reapertura por auditoría del auto-cierre de paraguas (#6801)',
        '',
        `Este issue se había cerrado como \`completed\` por el brazo de desbloqueo, que confundía la lista de **dependencias** con la lista de **hijas** y trataba a cualquier issue con el label \`split\` como si fuera el paraguas del split.`,
        '',
        `Se reabre porque cumple las tres condiciones del defecto: es una hija (\`[Split de #${veredicto.parent}]\`), la cerró el brazo con el comentario "Paraguas resuelto", y **no tiene ningún PR asociado** — o sea, el trabajo nunca se hizo.`,
        '',
        '_Reapertura automática de la auditoría de #6801._',
    ].join('\n');

    gh(['issue', 'reopen', String(issue.number), '--repo', REPO, '--comment', comment]);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const candidatos = args.issues && args.issues.length ? args.issues : buscarCandidatos(args.limit);

    console.log(`Auditoría de auto-cierre espurio (#6801) — repo ${REPO}`);
    console.log(`Modo: ${args.apply ? 'APPLY (reabre)' : 'DRY-RUN (no toca nada)'}`);
    console.log(`Candidatos: ${candidatos.length}\n`);

    const reabiertos = [];
    const descartados = [];

    for (const n of candidatos) {
        const issue = verIssue(n);
        if (!issue) {
            descartados.push({ number: n, reason: 'ilegible' });
            continue;
        }
        const veredicto = classifySpuriousUmbrellaClose(issue);
        const titulo = String(issue.title || '').slice(0, 70);

        if (!veredicto.reopen) {
            descartados.push({ number: n, reason: veredicto.reason });
            console.log(`  ⏭️  #${n} — ${veredicto.reason} — ${titulo}`);
            continue;
        }

        // Cuarta condición (más conservadora que las tres del issue): si la
        // hija fue re-partida y sus propias sub-historias están todas cerradas,
        // el scope quedó entregado → no se reabre.
        const propias = hijasPropias(n);
        if (propias.length && propias.every((h) => String(h.state).toUpperCase() === 'CLOSED')) {
            descartados.push({ number: n, reason: 'sub-historias-propias-cerradas' });
            console.log(`  ⏭️  #${n} — sub-historias-propias-cerradas (${propias.map((h) => '#' + h.number).join(', ')}) — ${titulo}`);
            continue;
        }

        console.log(`  ♻️  #${n} — REABRIR (hija de #${veredicto.parent}, 0 PRs) — ${titulo}`);
        if (args.apply) {
            try {
                reabrir(issue, veredicto);
                reabiertos.push(n);
            } catch (e) {
                console.error(`     [ERROR] no se pudo reabrir #${n}: ${e.message}`);
                descartados.push({ number: n, reason: `error-reapertura: ${e.message}` });
            }
        } else {
            reabiertos.push(n);
        }
    }

    console.log('');
    console.log(`A reabrir (${reabiertos.length}): ${reabiertos.map((n) => '#' + n).join(', ') || '(ninguno)'}`);
    console.log(`Descartados (${descartados.length}):`);
    const porMotivo = {};
    for (const d of descartados) porMotivo[d.reason] = (porMotivo[d.reason] || 0) + 1;
    for (const [reason, count] of Object.entries(porMotivo)) console.log(`  - ${reason}: ${count}`);
    if (!args.apply && reabiertos.length) {
        console.log('\nRe-ejecutá con --apply para aplicar las reaperturas.');
    }
}

if (require.main === module) main();

module.exports = { parseArgs };
