// =============================================================================
// render.js — NOTICE, reporte Markdown e inventario JSON (#7592)
//
// Todo es DETERMINISTA: orden (ecosistema, coordenada, versión) con comparación
// por código de carácter, sin timestamps, sin paths absolutos y sin datos que
// dependan de la fecha (la vigencia de las excepciones se evalúa en `check`,
// no acá). Dos corridas sobre el mismo inventario dan bytes idénticos.
//
// Todo string de terceros pasa por sanitize.js (SR-5 / SR-7).
// =============================================================================
'use strict';

const sanitize = require('./sanitize');
const { buildIndex, licenseLabel, staticCategory } = require('./policy');

const GENERATED_BY = 'npm run licenses:generate (scripts/licenses/cli.js)';

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => cmp(a.ecosystem, b.ecosystem)
    || cmp(a.coordinate, b.coordinate)
    || cmp(a.version, b.version));
}

/** Inventario versionado (entrada del diff "cambios respecto de la base"). */
function renderInventoryJson(entries) {
  const rows = sortEntries(entries).map((e) => ({
    ecosistema: e.ecosystem,
    coordenada: sanitize.text(e.coordinate),
    version: sanitize.text(e.version, 80),
    licencia_spdx: e.expression ? sanitize.text(e.expression) : null,
    licencia_declarada: sanitize.text(e.declared),
    alcance: e.scope,
    origenes: e.origins.map((o) => sanitize.text(o)),
  }));
  return JSON.stringify(rows, null, 2) + '\n';
}

const CATEGORY_LABEL = Object.freeze({
  allowed: 'permitida',
  obligation: 'permitida con obligación',
  exception: 'excepción',
  denied: 'PROHIBIDA',
  unknown: 'DESCONOCIDA',
});

function obligationText(cat) {
  switch (cat.category) {
    case 'allowed':
    case 'obligation':
      return cat.obligaciones.length ? cat.obligaciones.join('; ') : 'sin obligación adicional';
    case 'exception':
      return 'cubierta por excepción (ver "Excepciones declaradas")';
    case 'denied':
      return 'PROHIBIDA por la política';
    default:
      return 'DESCONOCIDA: no mapea a una licencia de la política';
  }
}

function copyrightFor(entry, copyrights) {
  const c = copyrights && copyrights[`${entry.coordinate}@${entry.version}`];
  return c ? sanitize.text(c, 400) : 'no declarado en los metadatos del paquete';
}

function licenseIds(entries) {
  const ids = new Set();
  for (const e of entries) {
    if (!e.expression) continue;
    for (const tok of e.expression.split(/[\s()]+/)) {
      if (tok && !['AND', 'OR', 'WITH'].includes(tok)) ids.add(tok);
    }
  }
  return [...ids].sort(cmp);
}

/** NOTICE: atribuciones de lo que se DISTRIBUYE con el producto (D3). */
function renderNotice(entries, policy, copyrights) {
  const sorted = sortEntries(entries);
  const dist = sorted.filter((e) => e.scope === 'distribuido');
  const tools = sorted.filter((e) => e.scope !== 'distribuido');
  const out = [];
  out.push('NOTICE — Intrale Platform');
  out.push('');
  out.push('Este producto incluye software de terceros. Abajo se listan sus atribuciones:');
  out.push('nombre, versión, licencia (SPDX), copyright y URL pública del proyecto.');
  out.push(`Archivo generado por ${GENERATED_BY}. No editar a mano.`);
  out.push('');
  for (const eco of ['gradle', 'npm']) {
    const list = dist.filter((e) => e.ecosystem === eco);
    out.push('='.repeat(78));
    out.push(`Software distribuido — ${eco === 'gradle' ? 'Gradle (Kotlin/JVM/Android/Wasm/iOS)' : 'npm'} (${list.length})`);
    out.push('='.repeat(78));
    out.push('');
    for (const e of list) {
      out.push(`${sanitize.text(e.coordinate)} ${sanitize.text(e.version, 80)}`);
      out.push(`  Licencia: ${sanitize.text(licenseLabel(e)) || '(sin licencia declarada)'}`);
      out.push(`  Copyright: ${copyrightFor(e, copyrights)}`);
      out.push(`  Proyecto: ${e.url ? sanitize.text(e.url, 300) : 'no declarada'}`);
      out.push('');
    }
  }
  out.push('='.repeat(78));
  out.push('Textos de licencia');
  out.push('='.repeat(78));
  out.push('');
  for (const id of licenseIds(dist)) {
    out.push(`${sanitize.text(id)}: https://spdx.org/licenses/${encodeURIComponent(id)}.html`);
  }
  out.push('');
  out.push('='.repeat(78));
  out.push('Herramientas de build/test (no distribuidas)');
  out.push('='.repeat(78));
  out.push('');
  out.push(`${tools.length} dependencia(s) se usan sólo para compilar, probar u operar el`);
  out.push('repositorio y no se distribuyen con el producto. Se listan en');
  out.push('docs/legal/third-party-licenses.md.');
  out.push('');
  return out.join('\n');
}

function mdRow(cells) {
  return `| ${cells.join(' | ')} |`;
}

/** Reporte legible versionado (CA-6). */
function renderReport(entries, policy) {
  const idx = buildIndex(policy);
  const sorted = sortEntries(entries);
  const cats = new Map(sorted.map((e) => [e, staticCategory(e, policy, idx)]));
  const md = sanitize.forMarkdown;
  const out = [];

  out.push('# Licencias de dependencias de terceros');
  out.push('');
  out.push(`> Generado por \`${GENERATED_BY}\`. No editar a mano.`);
  out.push('> Política: `config/licenses/policy.json`. Cómo pedir una excepción: [docs/legal/licencias-terceros.md](licencias-terceros.md#excepciones).');
  out.push('');

  // ── Resumen ────────────────────────────────────────────────────────────
  out.push('## Resumen');
  out.push('');
  out.push(mdRow(['Ecosistema', 'Distribuido', 'Build/test', 'Total']));
  out.push(mdRow(['---', '---:', '---:', '---:']));
  for (const eco of ['gradle', 'npm']) {
    const list = sorted.filter((e) => e.ecosystem === eco);
    const d = list.filter((e) => e.scope === 'distribuido').length;
    out.push(mdRow([eco, String(d), String(list.length - d), String(list.length)]));
  }
  out.push('');
  out.push(mdRow(['Categoría', 'Dependencias']));
  out.push(mdRow(['---', '---:']));
  for (const key of ['allowed', 'obligation', 'exception', 'denied', 'unknown']) {
    const n = sorted.filter((e) => cats.get(e).category === key).length;
    out.push(mdRow([CATEGORY_LABEL[key], String(n)]));
  }
  out.push('');

  // ── Tablas por alcance ─────────────────────────────────────────────────
  const section = (title, scopeFilter) => {
    out.push(`## ${title}`);
    out.push('');
    for (const eco of ['gradle', 'npm']) {
      const list = sorted.filter((e) => e.ecosystem === eco && scopeFilter(e));
      out.push(`### ${eco === 'gradle' ? 'Gradle' : 'npm'} (${list.length})`);
      out.push('');
      if (list.length === 0) {
        out.push('_Sin dependencias._');
        out.push('');
        continue;
      }
      out.push(mdRow(['Dependencia', 'Versión', 'Licencia (SPDX)', 'Obligación']));
      out.push(mdRow(['---', '---', '---', '---']));
      for (const e of list) {
        out.push(mdRow([
          md(e.coordinate),
          md(e.version, 80),
          md(licenseLabel(e) || '(sin licencia declarada)'),
          md(obligationText(cats.get(e))),
        ]));
      }
      out.push('');
    }
  };
  section('Distribuido con el producto', (e) => e.scope === 'distribuido');
  section('Herramientas de build/test (no distribuidas)', (e) => e.scope !== 'distribuido');

  // ── Totales por licencia ───────────────────────────────────────────────
  out.push('## Totales por licencia');
  out.push('');
  out.push(mdRow(['Licencia', 'Dependencias']));
  out.push(mdRow(['---', '---:']));
  const totals = new Map();
  for (const e of sorted) {
    const k = licenseLabel(e) || '(sin licencia declarada)';
    totals.set(k, (totals.get(k) || 0) + 1);
  }
  for (const [k, n] of [...totals.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))) {
    out.push(mdRow([md(k), String(n)]));
  }
  out.push('');

  // ── Excepciones ────────────────────────────────────────────────────────
  out.push('## Excepciones declaradas');
  out.push('');
  const excs = [...policy.exceptions].sort((a, b) => cmp(String(a && a.revisar_antes), String(b && b.revisar_antes)));
  if (excs.length === 0) {
    out.push('_No hay excepciones declaradas._');
  } else {
    out.push(mdRow(['Paquete', 'Licencia', 'Revisar antes', 'Aprobado por', 'Justificación']));
    out.push(mdRow(['---', '---', '---', '---', '---']));
    for (const x of excs) {
      out.push(mdRow([md(x.paquete), md(x.licencia), md(x.revisar_antes, 20), md(x.aprobado_por, 80), md(x.justificacion, 300)]));
    }
  }
  out.push('');

  // ── Fuera de alcance ───────────────────────────────────────────────────
  out.push('## Fuera de alcance');
  out.push('');
  out.push(mdRow(['Ítem', 'Motivo']));
  out.push(mdRow(['---', '---']));
  const oos = [
    ...((policy.npm && Array.isArray(policy.npm.excluidos)) ? policy.npm.excluidos.map((x) => ({ item: x.path, motivo: x.motivo })) : []),
    ...(Array.isArray(policy.out_of_scope) ? policy.out_of_scope : []),
  ];
  for (const x of oos) out.push(mdRow([md(x.item), md(x.motivo, 400)]));
  out.push('');
  return out.join('\n');
}

module.exports = {
  CATEGORY_LABEL,
  renderInventoryJson,
  renderNotice,
  renderReport,
  sortEntries,
};
