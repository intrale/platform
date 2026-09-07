// Extraidas VERBATIM de .pipeline/dashboard.js en esta pasada de QA
function escapeHtml(s) {
  return __escapeHtmlAttrShared(s);
}

function renderCommanderResultBadges(meta) {
  if (!commanderResultBadge) return '';
  try { return commanderResultBadge.buildResultBadges(meta, escapeHtml); }
  catch { return ''; }
}

function renderCommanderRequestLogs(logDir, limit) {
  const MAX = limit || 8;
  let files = [];
  try {
    files = fs.readdirSync(logDir)
      .filter(f => /^commander-.+\.log$/.test(f))
      .map(f => {
        // id = nombre sin prefijo `commander-` ni sufijo `.log`.
        const id = f.replace(/^commander-/, '').replace(/\.log$/, '');
        const parts = id.split('-');
        const epochms = Number(parts[parts.length - 1]);
        const chat = parts.slice(0, -1).join('-') || '?';
        return { f, id, epochms: Number.isFinite(epochms) ? epochms : 0, chat };
      })
      .sort((a, b) => b.epochms - a.epochms)
      .slice(0, MAX);
  } catch { /* dir inexistente → estado vacío */ }

  if (files.length === 0) {
    return `
      <div class="commander-reqlogs">
        <div class="dora-mini-label" style="margin:10px 0 4px">📄 Logs recientes</div>
        <div class="dim" style="font-size:0.8em">sin peticiones registradas</div>
      </div>`;
  }

  const items = files.map(it => {
    const hora = it.epochms ? new Date(it.epochms).toTimeString().slice(0, 8) : '??:??:??';
    const label = `${hora} · chat ${escapeHtml(it.chat)}`;
    // #3951 EP7-H4 — lectura defensiva del sidecar de metadata. Si no existe
    // (peticiones previas al cambio) o está corrupto → sin badge, sin error.
    let badges = '';
    try {
      const metaPath = path.join(logDir, `commander-${it.id}.meta.json`);
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        badges = renderCommanderResultBadges(meta);
      }
    } catch { /* sidecar ausente/corrupto → render sin badge */ }
    return `<a class="log-link" href="/logs/view/${encodeURIComponent(it.f)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="${escapeHtml(it.id)}" style="display:block;font-size:0.8em;padding:1px 0;color:var(--ac)">📄 ${label}${badges}</a>`;
  }).join('');

  return `
      <div class="commander-reqlogs">
        <div class="dora-mini-label" style="margin:10px 0 4px">📄 Logs recientes (${files.length})</div>
        ${items}
      </div>`;
}