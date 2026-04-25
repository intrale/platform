'use strict';

const { spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function runCmd(cmd, args, opts = {}) {
    const started = Date.now();
    const res = spawnSync(cmd, args, {
        cwd: opts.cwd,
        env: opts.env || process.env,
        encoding: 'utf8',
        timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        shell: opts.shell ?? (process.platform === 'win32'),
    });
    return {
        cmd: `${cmd} ${args.join(' ')}`,
        exit_code: res.status == null ? 1 : res.status,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        wall_ms: Date.now() - started,
        signal: res.signal || null,
        error: res.error ? res.error.message : null,
    };
}

function runGit(args, opts = {}) {
    return runCmd('git', args, opts);
}

function runGh(args, opts = {}) {
    return runCmd('gh', args, opts);
}

function getCurrentBranch(cwd) {
    const r = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    return r.stdout.trim();
}

function getCurrentSha(cwd) {
    const r = runGit(['rev-parse', 'HEAD'], { cwd });
    return r.stdout.trim();
}

function getChangedFiles(cwd) {
    // Status porcelain: tres categorías
    //   ' M' / ' A' modificado pero no staged
    //   'M ' / 'A ' staged
    //   '??' untracked
    const r = runGit(['status', '--porcelain=v1'], { cwd });
    const files = [];
    for (const ln of r.stdout.split(/\r?\n/)) {
        if (!ln.trim()) continue;
        const code = ln.slice(0, 2);
        const path = ln.slice(3);
        files.push({ code, path, staged: code[0] !== ' ' && code[0] !== '?' });
    }
    return files;
}

function getDiffStats(cwd, base = 'origin/main') {
    const r = runGit(['diff', '--shortstat', `${base}...HEAD`], { cwd });
    // Output ej: " 5 files changed, 123 insertions(+), 4 deletions(-)"
    const out = r.stdout.trim();
    const parsed = { files_changed: 0, additions: 0, deletions: 0 };
    if (!out) return parsed;
    const mFiles = out.match(/(\d+)\s+files?\s+changed/);
    const mAdd = out.match(/(\d+)\s+insertions?/);
    const mDel = out.match(/(\d+)\s+deletions?/);
    if (mFiles) parsed.files_changed = parseInt(mFiles[1], 10);
    if (mAdd) parsed.additions = parseInt(mAdd[1], 10);
    if (mDel) parsed.deletions = parseInt(mDel[1], 10);
    return parsed;
}

function fetchOrigin(cwd) {
    return runGit(['fetch', 'origin', 'main'], { cwd, timeoutMs: 60 * 1000 });
}

function rebaseOnto(cwd, base = 'origin/main') {
    // #2519 (rev-2): --autostash es defensa en profundidad para el caso en que
    // el árbol de trabajo tenga archivos tracked modificados que SAFE_IGNORE
    // (delivery.js) decidió no commitear (heartbeats, agent-registry, activity-
    // logger, metrics-history). Sin --autostash, git rebase falla con
    // "cannot rebase: You have unstaged changes" aunque esos archivos sean
    // estado transitorio del pipeline en marcha. --autostash los stashea antes
    // del rebase y los reaplica después; como main nunca toca esos paths, el
    // pop es conflict-free.
    return runGit(['rebase', '--autostash', base], { cwd, timeoutMs: 60 * 1000 });
}

function rebaseAbort(cwd) {
    return runGit(['rebase', '--abort'], { cwd });
}

function pushBranch(cwd, branch) {
    // --force-with-lease es seguro tras rebase (no pisa cambios ajenos al upstream conocido)
    return runGit(['push', '--force-with-lease', '-u', 'origin', branch], { cwd, timeoutMs: 2 * 60 * 1000 });
}

// ── Builders de mensajes ──────────────────────────────────────────────
const TYPE_BY_PREFIX = [
    { rx: /^agent\/\d+-/i, type: 'feat' },
    { rx: /^feature\//i, type: 'feat' },
    { rx: /^bugfix\//i, type: 'fix' },
    { rx: /^fix\//i, type: 'fix' },
    { rx: /^docs?\//i, type: 'docs' },
    { rx: /^refactor\//i, type: 'refactor' },
    { rx: /^test\//i, type: 'test' },
    { rx: /^chore\//i, type: 'chore' },
];

function inferCommitType(branch) {
    for (const { rx, type } of TYPE_BY_PREFIX) {
        if (rx.test(branch)) return type;
    }
    return 'chore';
}

function inferScope(files, fallback = 'general') {
    if (!files || !files.length) return fallback;
    const top = new Map();
    for (const f of files) {
        const seg = (f.path || f).split('/')[0];
        if (!seg) continue;
        top.set(seg, (top.get(seg) || 0) + 1);
    }
    if (!top.size) return fallback;
    const sorted = [...top.entries()].sort((a, b) => b[1] - a[1]);
    const winner = sorted[0][0];
    // Mapeo a scopes Intrale conocidos
    const scopeMap = {
        '.pipeline': 'pipeline',
        '.claude': 'pipeline',
        backend: 'backend',
        users: 'users',
        app: 'app',
        docs: 'docs',
        tools: 'tools',
        buildSrc: 'build',
        scripts: 'scripts',
    };
    return scopeMap[winner] || winner;
}

function buildCommitMessage({ issue, title, body, branch, files }) {
    const type = inferCommitType(branch);
    const scope = inferScope(files);
    const safeTitle = (title || `entrega #${issue}`).replace(/^\s*\[\w+\]\s*/, '').trim();
    const subject = `${type}(${scope}): ${safeTitle}`;
    const lines = [subject];
    if (body && body.trim()) {
        lines.push('', body.trim());
    }
    lines.push('', `Closes #${issue}`);
    return lines.join('\n');
}

function buildPRBody({ issue, title, summaryBullets, testPlan, qaLabel }) {
    const bullets = (summaryBullets && summaryBullets.length)
        ? summaryBullets.map((b) => `- ${b}`).join('\n')
        : `- Cambios automatizados del pipeline V3 para issue #${issue}`;

    const tests = (testPlan && testPlan.length)
        ? testPlan.map((t) => `- [x] ${t}`).join('\n')
        : `- [x] Pipeline V3 ejecutó builder + tester (gates verdes)\n- [x] QA: \`${qaLabel || 'qa:skipped'}\` aplicado`;

    return `## Resumen\n\n${bullets}\n\n## Plan de pruebas\n\n${tests}\n\n## Closes\n\nCloses #${issue}\n`;
}

module.exports = {
    runCmd,
    runGit,
    runGh,
    getCurrentBranch,
    getCurrentSha,
    getChangedFiles,
    getDiffStats,
    fetchOrigin,
    rebaseOnto,
    rebaseAbort,
    pushBranch,
    inferCommitType,
    inferScope,
    buildCommitMessage,
    buildPRBody,
};
