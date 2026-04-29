// Resumen funcional + actividad reciente de issues bloqueados (#2862-followup).
//
// Pensado para alimentar las cards del panel "Necesitan intervención humana"
// del dashboard. Para cada issue, expone:
//   - summary:        primer parrafo significativo del body, sin markdown
//   - recent_events:  ultimos N comentarios filtrados (sin bots, sin duplicados)
//
// Cache en disco con TTL configurable. Fetch async via gh GraphQL en batches,
// pensado para correr en background sin bloquear el render del dashboard.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PIPELINE = path.resolve(__dirname, '..');
const CACHE_FILE = path.join(PIPELINE, '.issue-summary-cache.json');
const CACHE_TTL_MS = 6 * 3600 * 1000; // 6 horas
const BATCH_SIZE = 20; // issues por query GraphQL (body+comments es pesado)
const FETCH_TIMEOUT_MS = 30000;
const GH_BIN_DEFAULT = 'C:/Workspaces/gh-cli/bin/gh';
const GH_BIN = process.env.GH_BIN || process.env.GH_PATH || GH_BIN_DEFAULT;

// Bots / autores cuyos comentarios son ruido funcional y no aportan a la
// decisión "desestimar / reactivar". Lista mantenible aparte.
const NOISE_AUTHORS = new Set([
    'github-actions',
    'github-actions[bot]',
    'dependabot',
    'dependabot[bot]',
    'codecov',
    'codecov[bot]',
]);

// Patrones de comentarios automatizados (los emite el propio pipeline en nombre
// de leitolarreta). No tiene sentido mostrarlos como "actividad relevante".
const NOISE_COMMENT_PATTERNS = [
    /^🚫\s*Bloqueado por infra\b/i,
    /^🔄\s*Reintentado tras restablecer conectividad\b/i,
    /^## 🔒 Security SAST/i,
    /^## 📊 Coverage report/i,
    /^\*\*Skill `[\w-]+`\*\* despachado/i,
];

let _inflight = false;

function loadCache() {
    try {
        return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function saveCache(cache) {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch {}
}

/**
 * Strip markdown a texto plano, manteniendo legibilidad.
 * No es un parser perfecto — apunta a remover el ruido visual mas comun.
 */
function stripMarkdown(text) {
    if (!text) return '';
    let s = String(text);
    // Bloques de codigo completos
    s = s.replace(/```[\s\S]*?```/g, ' ');
    // Code inline
    s = s.replace(/`([^`]+)`/g, '$1');
    // Imagenes ![alt](url)
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    // Links [text](url) -> text
    s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    // Bold/italic
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
    s = s.replace(/\*([^*]+)\*/g, '$1');
    s = s.replace(/__([^_]+)__/g, '$1');
    s = s.replace(/_([^_]+)_/g, '$1');
    // Headers
    s = s.replace(/^#{1,6}\s+/gm, '');
    // Blockquotes
    s = s.replace(/^>\s?/gm, '');
    // Bullets / numeradas
    s = s.replace(/^[-*+]\s+/gm, '');
    s = s.replace(/^\d+\.\s+/gm, '');
    // Tablas (filas con | )
    s = s.replace(/^\|.*\|$/gm, '');
    s = s.replace(/^[-:|\s]+$/gm, '');
    // HTML basico
    s = s.replace(/<\/?[^>]+>/g, '');
    // Espacios multiples
    s = s.replace(/\r/g, '');
    s = s.replace(/[ \t]+/g, ' ');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
}

/**
 * Extrae un resumen funcional del body. Estrategia:
 * 1. Si hay seccion "## Contexto" / "## Objetivo" / "## Sintoma" / "## Como usuario",
 *    usar el primer parrafo de esa seccion (ese suele ser el "qué" funcional).
 * 2. Si no, usar el primer parrafo no vacio del body.
 * 3. Limitar a ~280 chars y agregar elipsis si se cortó.
 */
function extractFunctionalSummary(rawBody) {
    if (!rawBody) return '';
    const body = String(rawBody);

    // OJO: sin flag `m`. Con multiline, $ matchea fin de cada linea y un lazy
    // captura vacio inmediato. Sin `m`, $ matchea solo end-of-string y captura
    // funciona como esperamos (todo entre el header y el siguiente "## " o EOF).
    const PREFERRED_HEADERS = [
        /##+\s*(?:Como\s+\w+|Objetivo|Contexto|S[ií]ntoma|Descripci[oó]n|Problema|Resumen)\b[^\n]*\n+([\s\S]*?)(?:\n##\s|$)/i,
    ];

    let chunk = '';
    for (const re of PREFERRED_HEADERS) {
        const m = body.match(re);
        if (m && m[1] && m[1].trim()) {
            chunk = m[1].trim();
            break;
        }
    }

    if (!chunk) {
        // Tomar todo lo previo al primer ## o todo el body si no hay headers.
        const cut = body.split(/\n##\s/)[0] || body;
        chunk = cut.trim();
    }

    const plain = stripMarkdown(chunk);
    // Primer parrafo (separado por linea en blanco) o primer corte por punto-newline
    const firstPara = plain.split(/\n\s*\n/)[0] || plain;
    const collapsed = firstPara.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= 280) return collapsed;
    // Cortar en el ultimo espacio antes de 280 para no romper palabras
    const cut = collapsed.slice(0, 280);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > 200 ? cut.slice(0, lastSpace) : cut) + '…';
}

function isNoiseComment(comment) {
    const author = (comment.author || '').toLowerCase();
    if (NOISE_AUTHORS.has(author)) return true;
    const body = String(comment.body || '').trim();
    if (!body) return true;
    for (const re of NOISE_COMMENT_PATTERNS) {
        if (re.test(body)) return true;
    }
    return false;
}

/**
 * Filtra comentarios para quedarse con los "relevantes":
 * - Sin bots (NOISE_AUTHORS)
 * - Sin patrones automatizados (NOISE_COMMENT_PATTERNS)
 * - Sin duplicados consecutivos del mismo autor con cuerpo casi identico
 * - Devuelve los ULTIMOS N (mas recientes primero)
 */
function extractRecentEvents(comments, max = 4) {
    if (!Array.isArray(comments) || comments.length === 0) return [];
    const filtered = comments.filter(c => !isNoiseComment(c));

    // Dedup consecutivos por autor + primeras 80 chars (evita "🚫 Bloqueado x40")
    const dedup = [];
    for (const c of filtered) {
        const key = `${c.author}|${String(c.body || '').slice(0, 80)}`;
        const last = dedup[dedup.length - 1];
        if (last && last.__key === key) continue;
        dedup.push({ ...c, __key: key });
    }

    // Mas recientes primero
    const sorted = dedup.sort((a, b) => {
        const ta = Date.parse(a.when || a.createdAt || 0);
        const tb = Date.parse(b.when || b.createdAt || 0);
        return tb - ta;
    });

    return sorted.slice(0, max).map(c => ({
        author: c.author,
        when: c.when || c.createdAt,
        preview: stripMarkdown(c.body).replace(/\s+/g, ' ').trim().slice(0, 180),
    }));
}

/**
 * Devuelve resumenes para los issueIds dados, leyendo el cache. Si faltan o
 * estan stale (TTL > 6h), dispara un fetch en background y devuelve lo que
 * haya hoy. Render no se bloquea: la siguiente render-tick recibe lo nuevo.
 */
function getSummaries(issueIds, opts = {}) {
    const cache = loadCache();
    const now = Date.now();
    const result = {};
    const stale = [];
    for (const id of issueIds) {
        const key = String(id);
        const entry = cache[key];
        if (!entry || (now - (entry.fetchedAt || 0)) > CACHE_TTL_MS) {
            stale.push(Number(id));
        }
        if (entry) {
            result[key] = {
                summary: entry.summary || '',
                recent_events: entry.recent_events || [],
                fetchedAt: entry.fetchedAt || 0,
                stale: !entry.fetchedAt || (now - entry.fetchedAt) > CACHE_TTL_MS,
            };
        } else {
            result[key] = { summary: '', recent_events: [], fetchedAt: 0, stale: true };
        }
    }

    if (stale.length > 0 && !_inflight) {
        // Fetch en background — no awaiteamos, no bloqueamos al caller.
        scheduleBackgroundFetch(stale, cache).catch(() => {});
    }

    return result;
}

/**
 * Fetch en background usando gh GraphQL. Procesa stale ids en batches y va
 * persistiendo el cache para que cada render-tick recoja lo nuevo.
 */
async function scheduleBackgroundFetch(issueIds, cache) {
    if (_inflight) return;
    _inflight = true;
    try {
        for (let i = 0; i < issueIds.length; i += BATCH_SIZE) {
            const batch = issueIds.slice(i, i + BATCH_SIZE);
            try {
                const data = await runGraphQLBatch(batch);
                const now = Date.now();
                for (const id of batch) {
                    const node = data[`i${batch.indexOf(id)}`];
                    if (node && node.number) {
                        cache[String(node.number)] = {
                            summary: extractFunctionalSummary(node.body || ''),
                            recent_events: extractRecentEvents(
                                (node.comments?.nodes || []).map(c => ({
                                    author: c.author?.login || '',
                                    body: c.body || '',
                                    when: c.createdAt || '',
                                }))
                            ),
                            fetchedAt: now,
                        };
                    } else {
                        // Negative cache para no reintentar
                        cache[String(id)] = {
                            summary: '',
                            recent_events: [],
                            notFound: true,
                            fetchedAt: now,
                        };
                    }
                }
                saveCache(cache);
            } catch (e) {
                // Marcar batch como fallido para que reintente en siguiente render
                // (no escribir negative cache ante fallos transitorios)
            }
        }
    } finally {
        _inflight = false;
    }
}

function runGraphQLBatch(issueIds) {
    return new Promise((resolve, reject) => {
        const fields = issueIds.map((id, i) =>
            `i${i}: issue(number:${id}) { number body comments(last:20) { nodes { author { login } body createdAt } } }`
        ).join(' ');
        const query = `{ repository(owner:"intrale",name:"platform") { ${fields} } }`;
        const tmpFile = path.join(PIPELINE, '.gh-summary-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.graphql');
        try {
            fs.writeFileSync(tmpFile, query);
        } catch (e) {
            return reject(e);
        }
        const child = spawn(GH_BIN, ['api', 'graphql', '-F', `query=@${tmpFile}`], {
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            try { child.kill(); } catch {}
            try { fs.unlinkSync(tmpFile); } catch {}
            reject(new Error('gh GraphQL timeout'));
        }, FETCH_TIMEOUT_MS);
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', code => {
            clearTimeout(timer);
            try { fs.unlinkSync(tmpFile); } catch {}
            if (code !== 0) return reject(new Error(`gh exit ${code}: ${stderr.slice(0, 200)}`));
            try {
                const json = JSON.parse(stdout);
                resolve(json?.data?.repository || {});
            } catch (e) {
                reject(e);
            }
        });
        child.on('error', e => {
            clearTimeout(timer);
            try { fs.unlinkSync(tmpFile); } catch {}
            reject(e);
        });
    });
}

module.exports = {
    getSummaries,
    extractFunctionalSummary,
    extractRecentEvents,
    stripMarkdown,
    isNoiseComment,
    CACHE_FILE,
    CACHE_TTL_MS,
};
