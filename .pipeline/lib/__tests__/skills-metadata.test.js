// =============================================================================
// skills-metadata.test.js — Parser de frontmatter y validación de capabilities.
// Issue #3082 — CA-6, CA-7.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const skillsMetadata = require('../skills-metadata');

function makeSkillsTmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'skills-meta-'));
}

function writeSkill(root, name, content) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
}

test('parseFrontmatter extrae key/value de un bloque simple', () => {
    const md = '---\ndescription: foo\nuser-invocable: true\n---\n\n# Body\n';
    const r = skillsMetadata.parseFrontmatter(md);
    assert.equal(r.meta.description, 'foo');
    assert.equal(r.meta['user-invocable'], true);
});

test('parseFrontmatter detecta arrays inline', () => {
    const md = '---\nrequired_permissions: [file_read, bash, tool_use_gated]\n---\n';
    const r = skillsMetadata.parseFrontmatter(md);
    assert.deepEqual(r.meta.required_permissions, ['file_read', 'bash', 'tool_use_gated']);
});

test('parseFrontmatter respeta strings entre comillas dobles', () => {
    const md = '---\nargument-hint: "[a|b] <c>"\n---\n';
    const r = skillsMetadata.parseFrontmatter(md);
    assert.equal(r.meta['argument-hint'], '[a|b] <c>');
});

test('parseFrontmatter devuelve null si no hay frontmatter', () => {
    assert.equal(skillsMetadata.parseFrontmatter('# Sin frontmatter\n'), null);
    assert.equal(skillsMetadata.parseFrontmatter(''), null);
});

test('loadSkillMetadata carga un SKILL.md con required_permissions válidas', () => {
    const root = makeSkillsTmpRoot();
    writeSkill(root, 'qa', '---\ndescription: QA test\nrequired_permissions: [file_read, bash]\n---\n# QA\n');
    const r = skillsMetadata.loadSkillMetadata('qa', { skillsRoot: root });
    assert.deepEqual(r.meta.required_permissions, ['file_read', 'bash']);
});

test('loadSkillMetadata rechaza required_permissions con capability fuera del catálogo (CA-9)', () => {
    const root = makeSkillsTmpRoot();
    writeSkill(root, 'badskill', '---\ndescription: bad\nrequired_permissions: [file_read, fake_capability]\n---\n');
    assert.throws(() => {
        skillsMetadata.loadSkillMetadata('badskill', { skillsRoot: root });
    }, /catálogo/);
});

test('loadAllSkillsMetadata recorre directorios y reporta failures sin tirar', () => {
    const root = makeSkillsTmpRoot();
    writeSkill(root, 'skillA', '---\ndescription: A\nrequired_permissions: [file_read]\n---\n');
    writeSkill(root, 'skillB', '---\ndescription: B\nrequired_permissions: [bad_cap]\n---\n');
    writeSkill(root, 'skillC', '---\ndescription: C\n---\n'); // sin required_permissions
    const r = skillsMetadata.loadAllSkillsMetadata({ skillsRoot: root });
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].skill, 'skillB');
    assert.ok(r.registry.skillA);
    assert.equal(r.registry.skillC.__missing_permissions, true);
});

test('loadAllSkillsMetadata salta directorios que empiezan con _ (frozen/shared)', () => {
    const root = makeSkillsTmpRoot();
    writeSkill(root, '_frozen', '---\ndescription: frozen\n---\n');
    writeSkill(root, 'real-skill', '---\ndescription: real\nrequired_permissions: [file_read]\n---\n');
    const r = skillsMetadata.loadAllSkillsMetadata({ skillsRoot: root });
    assert.equal(Object.keys(r.registry).length, 1);
    assert.ok(r.registry['real-skill']);
});

test('lintAllSkillsForPreCommit reporta missing y unknown_capability', () => {
    const root = makeSkillsTmpRoot();
    writeSkill(root, 'good', '---\ndescription: good\nrequired_permissions: [file_read]\n---\n');
    writeSkill(root, 'missing', '---\ndescription: missing\n---\n');
    writeSkill(root, 'unknown', '---\ndescription: unknown\nrequired_permissions: [crazy]\n---\n');
    const r = skillsMetadata.lintAllSkillsForPreCommit({ skillsRoot: root });
    assert.equal(r.ok, false);
    const kinds = r.errors.map(e => e.kind).sort();
    assert.deepEqual(kinds, ['missing', 'unknown_capability']);
});

test('lintAllSkillsForPreCommit ok=true cuando todos los skills declaran capabilities válidas', () => {
    const root = makeSkillsTmpRoot();
    writeSkill(root, 'a', '---\ndescription: a\nrequired_permissions: [file_read]\n---\n');
    writeSkill(root, 'b', '---\ndescription: b\nrequired_permissions: [bash, file_write_repo]\n---\n');
    const r = skillsMetadata.lintAllSkillsForPreCommit({ skillsRoot: root });
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
});
