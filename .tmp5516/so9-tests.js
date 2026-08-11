
// =============================================================================
// SO-9 — Convergencia ola→allowlist RE-DERIVADA DEL ESTADO
//
// Regresión del rechazo de review del 2026-08-10 (bloqueante). El paso 5 del
// wire-up construía la unión de la allowlist desde `incorporated` ("lo que
// agregué en ESTA corrida"). Si la escritura de la ola salía bien y la de la
// allowlist fallaba, el ciclo siguiente NO podía reintentar: `findSplitOrphans`
// excluye al hijo por `inWave.has(child)`, devolvía `[]`, y el wire-up hacía early
// return por `no_orphans` ANTES del paso 5 → divergencia reductiva PERMANENTE →
// flag + human-block, o sea el bloqueo humano que #5516 existe para eliminar.
//
// `splitChildrenMissingFromAllowlist` re-deriva la brecha del ESTADO, así que el
// ciclo N+1 la cierra solo sin importar por qué se abrió.
// =============================================================================

test('#5516 SO-9 ciclo N+1: la ola tiene el hijo y la allowlist no → la brecha se detecta', () => {
    const corpus = [child(5440, 5340)];
    // Ciclo N: el descubrimiento ya no lo ve (correcto: ya está en la ola).
    const orph = sor.findSplitOrphans(corpus, { activeWaveIssues: [5340, 1111, 5440] });
    assert.deepEqual(orph.orphans, [], 'el descubrimiento no reintenta — por eso hace falta SO-9');

    // Ciclo N+1: la convergencia SÍ lo ve, y por eso la brecha se cierra sola.
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: corpus,
        waveIssues: [5340, 1111, 5440],
        allowlistIssues: [5340, 1111],
    });
    assert.deepEqual(gap.missing, [5440], 'la brecha ola→allowlist se re-deriva del estado');
    assert.equal(gap.truncated, false);
});

test('#5516 SO-9 idempotente: ola y allowlist en sync → brecha vacía, sin escrituras', () => {
    const corpus = [child(5440, 5340)];
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: corpus,
        waveIssues: [5340, 5440],
        allowlistIssues: [5340, 5440],
    });
    assert.deepEqual(gap.missing, [], 'sin brecha no se escribe ni se notifica');
    assert.deepEqual(gap.rejectedByLabel, []);
});

test('#5516 SO-9 sólo mira la ola: un hijo fuera de la ola no entra a la allowlist', () => {
    // #5440 es hijo de #5340 pero NO está en la ola. La convergencia es
    // ola→allowlist: si no está en la ola, no hay nada que converger.
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: [child(5440, 5340)],
        waveIssues: [5340],
        allowlistIssues: [5340],
    });
    assert.deepEqual(gap.missing, []);
});

test('#5516 SO-9 alcance acotado: un issue de la ola SIN título de split no se toca', () => {
    // Importante para no convertir esto en un realign general de la allowlist:
    // sólo convergen HIJOS DE SPLIT (título canónico, SO-4).
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: [plain(7001)],
        waveIssues: [5340, 7001],
        allowlistIssues: [5340],
    });
    assert.deepEqual(gap.missing, []);
});

test('#5516 SO-9 mantiene SO-8: un hijo de la ola con needs-human NO se habilita', () => {
    // Sumarlo a la allowlist lo habilitaría para dispatch, salteando el gate de
    // #2653 — la misma razón por la que SO-8 existe en el descubrimiento.
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: [child(5426, 5339, { labels: [{ name: 'needs-human' }] })],
        waveIssues: [5339, 5426],
        allowlistIssues: [5339],
    });
    assert.deepEqual(gap.missing, [], 'no se auto-habilita un issue frenado a propósito');
    assert.equal(gap.rejectedByLabel.length, 1);
    assert.equal(gap.rejectedByLabel[0].child, 5426);
    assert.equal(gap.rejectedByLabel[0].reason, 'blocking_label');
});

test('#5516 SO-9 mantiene SO-8 fail-closed: payload sin labels → excluido y reportado', () => {
    const sinLabels = child(5440, 5340);
    delete sinLabels.labels;
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: [sinLabels],
        waveIssues: [5340, 5440],
        allowlistIssues: [5340],
    });
    assert.deepEqual(gap.missing, []);
    assert.equal(gap.rejectedByLabel[0].reason, 'labels_unavailable');
});

test('#5516 SO-9 mantiene SO-7: autor no confiable de la ola no entra a la allowlist', () => {
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: [child(6001, 5340, { ...UNTRUSTED_AUTHOR })],
        waveIssues: [5340, 6001],
        allowlistIssues: [5340],
    });
    assert.deepEqual(gap.missing, [], 'default-deny por origen no confiable');
});

test('#5516 SO-9 mantiene SO-3: un hijo CERRADO de la ola no entra a la allowlist', () => {
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: [child(5440, 5340, { state: 'CLOSED' })],
        waveIssues: [5340, 5440],
        allowlistIssues: [5340],
    });
    assert.deepEqual(gap.missing, []);
});

test('#5516 SO-9 cierra la brecha de VARIOS hijos, ordenada y sin duplicados', () => {
    const corpus = [child(5460, 5452), child(5458, 5452), child(5459, 5452), child(5458, 5452)];
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: corpus,
        waveIssues: [5452, 5458, 5459, 5460],
        allowlistIssues: [5452],
    });
    assert.deepEqual(gap.missing, [5458, 5459, 5460], 'orden asc, sin duplicados');
});

test('#5516 SO-9 respeta el cap SO-5 y REPORTA el truncado', () => {
    const corpus = [];
    const wave = [5000];
    for (let i = 1; i <= 8; i++) { corpus.push(child(6000 + i, 5000)); wave.push(6000 + i); }
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: corpus, waveIssues: wave, allowlistIssues: [5000], maxIncorporations: 3,
    });
    assert.equal(gap.missing.length, 3, 'corta en el cap');
    assert.equal(gap.truncated, true);
    assert.equal(gap.reason, 'max_incorporations');
});

test('#5516 SO-9 entradas basura no rompen ni cuelan nada', () => {
    for (const bad of [undefined, null, {}, { issues: null }, { issues: 'x', waveIssues: 3 }]) {
        const gap = sor.splitChildrenMissingFromAllowlist(bad);
        assert.deepEqual(gap.missing, []);
        assert.equal(gap.truncated, false);
    }
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: [null, 42, 'x', {}, { number: 0 }, { number: -1 }],
        waveIssues: [1, 2], allowlistIssues: [],
    });
    assert.deepEqual(gap.missing, []);
});

// --- Estructurales del wire-up: los 3 caminos que review encontró rotos -------

test('#5516 estructural: el paso 5 es ALCANZABLE — no hay early return antes', () => {
    const fs = require('node:fs');
    const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    const fn = PULPO_SRC.slice(PULPO_SRC.indexOf('function reconcileSplitOrphansFromGithub('));
    const body = fn.slice(0, fn.indexOf('\nfunction '));

    const iOrphans = body.indexOf('const orphans =');
    const iPaso5 = body.indexOf('splitChildrenMissingFromAllowlist');
    assert.ok(iOrphans > 0 && iPaso5 > iOrphans, 'el paso 5 usa el helper puro SO-9');

    // Los DOS early returns que hacían inalcanzable al paso 5 ya no pueden estar
    // ANTES de él. Ésta es la regresión exacta del rechazo de review.
    const entre = body.slice(iOrphans, iPaso5);
    assert.doesNotMatch(entre, /return\s*\{[^}]*reason:\s*'no_orphans'/,
        'no_orphans NO debe retornar antes del paso 5 (dejaba la brecha sin reintento)');
    assert.doesNotMatch(entre, /return\s*\{[^}]*reason:\s*'nothing_added'/,
        'nothing_added NO debe retornar antes del paso 5 (segundo camino del doble cinturón)');
});

test('#5516 estructural: los WARN del paso 5 no prometen un reintento inexistente', () => {
    const fs = require('node:fs');
    const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    const fn = PULPO_SRC.slice(PULPO_SRC.indexOf('function reconcileSplitOrphansFromGithub('));
    const body = fn.slice(0, fn.indexOf('\nfunction '));
    // Cada aviso de allowlist NO actualizada debe explicar el mecanismo REAL
    // (re-derivación del estado / SO-9), no un "se reintenta" sin sustento.
    const warns = body.split('\n').filter((l) => /allowlist NO actualizada|modo cambió a|fallo al actualizar allowlist/.test(l));
    assert.ok(warns.length >= 3, `se esperaban los 3 caminos de fallo, hay ${warns.length}`);
    const blob = body.slice(body.indexOf('splitChildrenMissingFromAllowlist'));
    assert.match(blob, /SO-9/, 'los WARN referencian el mecanismo que sí existe');
});

test('#5516 estructural: el Telegram no afirma dependencia declarada si falló', () => {
    const fs = require('node:fs');
    const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    const fn = PULPO_SRC.slice(PULPO_SRC.indexOf('function reconcileSplitOrphansFromGithub('));
    const body = fn.slice(0, fn.indexOf('\nfunction '));
    // El fallo de `addDependency` se registra y la afirmación queda condicionada.
    assert.match(body, /dependencyFailures/, 'los fallos de addDependency se registran');
    assert.match(body, /dependencyFailures\.length === 0[\s\S]{0,120}Dependencia padre→hijos declarada/,
        'la afirmación es condicional al éxito real');
});

test('#5516 estructural: la query de búsqueda sale de repo-target, no hardcodeada', () => {
    const fs = require('node:fs');
    const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    // Convención #4693 CA-0: `lib/repo-target` es la fuente de verdad única.
    assert.match(PULPO_SRC, /function splitOrphanSearchQuery\(\)/);
    const q = PULPO_SRC.slice(PULPO_SRC.indexOf('function splitOrphanSearchQuery()'));
    const qBody = q.slice(0, q.indexOf('\n}'));
    assert.match(qBody, /repoTarget\.getPrimaryRepo\(\)/, 'usa la fuente de verdad única');
    assert.match(qBody, /SPLIT_ORPHAN_REPO_RE\.test/, 'valida el valor antes de interpolarlo');
    // Y la constante vieja con el repo hardcodeado ya no existe.
    assert.doesNotMatch(PULPO_SRC, /const SPLIT_ORPHAN_SEARCH_Q\s*=\s*\n?\s*'repo%3Aintrale/,
        'la query hardcodeada quedó eliminada');
});

test('#5516 estructural: el wire-up pide labels de verdad en la query REST', () => {
    // Refuerzo del test débil que review señaló: antes sólo afirmaba que los
    // strings `rejectedByLabel`/`SO-8` aparecían, así que una regresión a una
    // query con campos limitados (que desactivaría SO-8 en silencio, porque el
    // default-deny excluiría TODO) pasaba desapercibida.
    const fs = require('node:fs');
    const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    const fn = PULPO_SRC.slice(PULPO_SRC.indexOf('function reconcileSplitOrphansFromGithub('));
    const body = fn.slice(0, fn.indexOf('\nfunction '));

    // La fuente debe ser `search/issues`, que devuelve el issue COMPLETO
    // (incluido `labels`), y no una variante con selección de campos.
    assert.match(body, /search\/issues\?q=/, 'usa el índice de búsqueda');
    assert.doesNotMatch(body, /--json\s/, 'no usa `gh issue list --json`, que no trae authorAssociation');
    // Ningún recorte de campos (`--jq`, `&fields=`) sobre el payload de búsqueda:
    // recortar `labels` o `author_association` desactivaría SO-8/SO-7 en silencio.
    const cmd = body.slice(body.indexOf('search/issues?q='), body.indexOf('search/issues?q=') + 400);
    assert.doesNotMatch(cmd, /--jq|--template|&fields=/,
        'sin recorte de campos: labels y author_association deben llegar completos');
    // Y el guard se alimenta de ese payload.
    assert.match(body, /rejectedByLabel/);
    assert.match(body, /SO-8/);
});
