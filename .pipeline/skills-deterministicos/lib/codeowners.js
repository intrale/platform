'use strict';

const fs = require('fs');
const path = require('path');

const HUMAN_OWNERS = new Set(['@leitolarreta']);

function parseCodeowners(content) {
    const rules = [];
    if (!content) return rules;
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, '').trim();
        if (!line) continue;
        const tokens = line.split(/\s+/);
        if (tokens.length < 2) continue;
        const pattern = tokens[0];
        const owners = tokens.slice(1).filter((t) => t.startsWith('@') || t.includes('/'));
        if (!owners.length) continue;
        rules.push({ pattern, owners });
    }
    return rules;
}

function loadCodeowners(repoRoot) {
    const candidates = [
        path.join(repoRoot, '.github', 'CODEOWNERS'),
        path.join(repoRoot, 'CODEOWNERS'),
        path.join(repoRoot, 'docs', 'CODEOWNERS'),
    ];
    for (const file of candidates) {
        try {
            if (fs.existsSync(file)) {
                return parseCodeowners(fs.readFileSync(file, 'utf8'));
            }
        } catch {}
    }
    return [];
}

function patternToRegex(pattern) {
    let p = pattern;
    const anchorAtRoot = p.startsWith('/');
    if (anchorAtRoot) p = p.slice(1);
    const dirOnly = p.endsWith('/');
    if (dirOnly) p = p.slice(0, -1);

    const SD = '';
    const SS = '';
    const SQ = '';

    const tokenized = p
        .replace(/\*\*/g, SD)
        .replace(/\*/g, SS)
        .replace(/\?/g, SQ);

    const escaped = tokenized.replace(/[.+^$|()[\]{}\\]/g, '\\$&');

    let reBody = escaped
        .replace(new RegExp(SD + '/', 'g'), '(?:.*/)?')
        .replace(new RegExp('/' + SD, 'g'), '(?:/.*)?')
        .replace(new RegExp(SD, 'g'), '.*')
        .replace(new RegExp(SS, 'g'), '[^/]*')
        .replace(new RegExp(SQ, 'g'), '[^/]');

    const prefix = anchorAtRoot ? '^' : '^(?:.*/)?';
    const suffix = '(?:/.*)?$';
    return new RegExp(prefix + reBody + suffix);
}

function matchPath(rules, filePath) {
    const norm = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
    let lastMatch = null;
    for (const rule of rules) {
        const re = patternToRegex(rule.pattern);
        if (re.test(norm)) lastMatch = rule;
    }
    return lastMatch ? lastMatch.owners.slice() : [];
}

function resolveOwners(rules, paths) {
    const all = new Set();
    for (const p of paths) {
        for (const o of matchPath(rules, p)) all.add(o);
    }
    return Array.from(all);
}

function isHumanOwner(owner) {
    return HUMAN_OWNERS.has(owner);
}

function getHumanOwners(rules, paths) {
    return resolveOwners(rules, paths).filter(isHumanOwner);
}

module.exports = {
    HUMAN_OWNERS,
    parseCodeowners,
    loadCodeowners,
    patternToRegex,
    matchPath,
    resolveOwners,
    isHumanOwner,
    getHumanOwners,
};
