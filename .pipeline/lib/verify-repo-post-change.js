'use strict';

// Verificación explícita y de solo lectura: nunca ejecuta PATCH ni imprime credenciales.
const { execFileSync } = require('node:child_process');
const { resolveGhBin } = require('./gh-bin');

function createGithubClient(exec = execFileSync) {
    return (endpoint, paginate = false) => {
        const args = ['api', '--method', 'GET', endpoint];
        if (paginate) args.push('--paginate', '--slurp');
        try {
            return JSON.parse(exec(resolveGhBin(), args, {
                encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024,
                stdio: ['ignore', 'pipe', 'pipe'],
            }));
        } catch (_) {
            // stderr puede contener información sensible del credential helper.
            throw new Error(`No se pudo leer ${endpoint}; revisar acceso o disponibilidad (sin inferir ausencia).`);
        }
    };
}

function validateOptions(options) {
    if (!/^intrale\/[A-Za-z0-9_.-]+$/.test(options.repo || '')) throw new Error('repo debe ser intrale/<nombre>');
    if (!['public', 'private'].includes(options.visibility)) throw new Error('visibility debe ser public o private');
    if (typeof options.archived !== 'boolean') throw new Error('archived debe ser true o false');
    if (!['legacy', 'active'].includes(options.profile)) throw new Error('profile debe ser legacy o active');
    if (options.profile === 'active') {
        if (!options.since || !Number.isFinite(Date.parse(options.since))) throw new Error('since debe indicar la fecha del cambio');
        if (!Number.isInteger(options.minimumRules) || options.minimumRules < 0) throw new Error('minimum-rules debe indicar el mínimo previo');
        if (!['required', 'not-applicable'].includes(options.sast)) throw new Error('sast debe ser required o not-applicable');
    }
}

function verifyRepo(options, github = createGithubClient()) {
    validateOptions(options);
    const report = { repo: options.repo, checkedAt: new Date().toISOString(), expected: options, checks: [] };
    const check = (name, ok, evidence) => report.checks.push({ name, ok: Boolean(ok), evidence });
    const read = (suffix, paginate = false) => {
        try { return github(`repos/${options.repo}${suffix}`, paginate); }
        catch (error) { check(suffix || 'metadata', false, error.message); return null; }
    };
    const repo = read('');
    if (repo) {
        check('visibility', repo.visibility === options.visibility, repo.visibility);
        check('archived', repo.archived === options.archived, repo.archived);
        report.defaultBranch = repo.default_branch;
    }
    const workflowPages = read('/actions/workflows?per_page=100', true);
    const releasePages = read('/releases?per_page=100', true);
    const workflows = workflowPages?.flatMap(page => page.workflows);
    const releases = releasePages?.flat();
    if (options.profile === 'legacy') {
        if (workflows) check('sin workflows', workflows.length === 0, workflows.map(w => ({ id: w.id, path: w.path, state: w.state })));
        if (releases) check('sin releases', releases.length === 0, releases.map(r => ({ tag: r.tag_name, url: r.html_url })));
        const runs = read('/actions/runs?per_page=1');
        if (runs) check('sin runs', runs.total_count === 0, runs.total_count);
        report.scope = 'Inventario legacy: CI/SAST/distribución no aplican sólo si no hay workflows, runs ni releases. No acredita escaneo ni operación humana.';
    } else {
        if (repo) {
            const rules = read(`/rules/branches/${encodeURIComponent(repo.default_branch)}`);
            if (rules) check('rulesets', Array.isArray(rules) && rules.length >= options.minimumRules, rules);
        }
        if (workflows) {
            check('workflows presentes', workflows.length > 0, workflows.length);
            for (const workflow of workflows) {
                const runs = read(`/actions/workflows/${workflow.id}/runs?per_page=1`);
                const run = runs?.workflow_runs?.[0];
                if (runs) check(`CI ${workflow.path}`, run?.status === 'completed' && run?.conclusion === 'success' && Date.parse(run.created_at) > Date.parse(options.since), run ? { url: run.html_url, createdAt: run.created_at, conclusion: run.conclusion } : 'Sin runs');
            }
        }
        if (options.sast === 'required') {
            const pages = read('/code-scanning/analyses?per_page=100', true);
            if (pages) {
                const analyses = pages.flat().map(a => ({ createdAt: a.created_at, error: a.error, tool: a.tool?.name }));
                check('SARIF posterior al cambio', analyses.some(a => Date.parse(a.createdAt) > Date.parse(options.since) && !a.error), analyses);
            }
        } else check('SAST no aplica declarado', true, 'Requiere justificación y evidencia manual en el runbook; no acredita destino alternativo.');
        const permissions = read('/actions/permissions');
        if (permissions) check('Actions habilitado', permissions.enabled === true, permissions);
        const forks = read('/actions/permissions/fork-pr-workflows-private-repos');
        if (forks) check('fork PRs sin ejecución/secrets/write', forks.run_workflows_from_fork_pull_requests === false && forks.send_write_tokens_to_workflows === false && forks.send_secrets_and_variables === false, forks);
        report.scope = 'Sólo controles API; distribución, clone/push/comentario por identidad, checkout de admission-gate y renderizado requieren evidencia adicional.';
    }
    report.ok = report.checks.length > 0 && report.checks.every(c => c.ok);
    return report;
}

function parseArgs(args) {
    const values = {};
    const allowed = ['repo', 'visibility', 'archived', 'profile', 'since', 'minimum-rules', 'sast'];
    for (let i = 0; i < args.length; i += 2) {
        const key = args[i].replace(/^--/, '');
        if (!args[i].startsWith('--') || !allowed.includes(key) || args[i + 1] === undefined || Object.hasOwn(values, key)) throw new Error('Argumentos inválidos');
        values[key] = args[i + 1];
    }
    if (!['true', 'false'].includes(values.archived)) throw new Error('--archived true|false obligatorio');
    return { repo: values.repo, visibility: values.visibility, archived: values.archived === 'true', profile: values.profile,
        ...(values.since ? { since: values.since } : {}), ...(values.sast ? { sast: values.sast } : {}),
        ...(values['minimum-rules'] !== undefined ? { minimumRules: Number(values['minimum-rules']) } : {}) };
}

if (require.main === module) {
    try {
        const report = verifyRepo(parseArgs(process.argv.slice(2)));
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        process.exitCode = report.ok ? 0 : 1;
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { createGithubClient, verifyRepo, parseArgs };
