// =============================================================================
// credential-resolution-pattern.test.js — CA-8 de #5217
//
// Anti-regresión ESTÁTICA del patrón que causó el defecto, no enumeración de
// credenciales una por una (una lista se desactualiza y el test empieza a pasar
// siempre; el patrón no).
//
// El patrón prohibido es la cadena que colapsa en silencio:
//
//     process.env.GOOGLE_OAUTH_CLIENT_ID || cfg.google_oauth_client_id || ""
//
// Falla así: el valor real está en el store canónico, el archivo del repo se
// restaura vacío en cada `reset --hard`, los dos primeros términos dan
// undefined, el `|| ""` los colapsa a string vacío y el consumidor sigue como si
// nada. Sin excepción, sin log, sin error — la evidencia de QA se pierde y nadie
// se entera hasta que alguien abre el issue y no encuentra el video.
//
// SEC-6: las assertions son por FORMA (nombre de archivo, número de línea,
// término sintáctico). Nunca se imprime un valor de credencial ni se lee el
// store real: este test sólo parsea código fuente.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Consumidores relevados por el inventario de #5216 que resuelven credenciales.
const AUDITED_FILES = [
    'qa/scripts/qa-video-share.js',
    'scripts/google-drive-oauth-setup.js',
];

// Saca comentarios de línea y de bloque para no marcar el patrón cuando aparece
// documentado en prosa (este archivo lo explica arriba, sin ir más lejos).
// Los saltos de línea se preservan para que el número de línea reportado sea el
// del archivo real — un anchor corrido manda a leer código que no es el que falla.
function stripComments(source) {
    return String(source)
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Divide el término derecho de un `process.env.X || ...` en sus operandos,
// respetando paréntesis y strings para no cortar dentro de una expresión.
function splitOrTerms(text) {
    const terms = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            current += c;
            if (c === quote && text[i - 1] !== '\\') quote = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; current += c; continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        if (c === ')' || c === ']' || c === '}') depth--;
        if (depth < 0) break; // salimos de la expresión que nos interesa
        if (depth === 0 && c === '|' && text[i + 1] === '|') {
            terms.push(current.trim());
            current = '';
            i++;
            continue;
        }
        if (depth === 0 && (c === ';' || c === '\n')) {
            // Fin del statement (o de la línea sin continuación de cadena).
            const rest = text.slice(i + 1).trimStart();
            if (!rest.startsWith('||')) break;
        }
        current += c;
    }
    terms.push(current.trim());
    return terms.filter(Boolean);
}

const REPO_CONFIG_MEMBER_RE = /^([A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]*$/;
const EMPTY_STRING_RE = /^(""|'')$/;

/**
 * Detecta cadenas `process.env.X || <objeto>.<prop> || ""`.
 *
 * Exportado y testeado con snippets sintéticos para que el detector no pueda
 * degradarse a un no-op sin que se note: un test que sólo afirma "no hay
 * violaciones" pasaría igual si el detector dejara de detectar.
 *
 * @returns {Array<{line:number, snippet:string}>}
 */
function findCollapsingChains(source) {
    const clean = stripComments(source);
    const hits = [];
    const envRe = /process\.env\.[A-Za-z_$][\w$]*\s*\|\|/g;
    let m;
    while ((m = envRe.exec(clean)) !== null) {
        const terms = splitOrTerms(clean.slice(m.index));
        if (terms.length < 3) continue;
        const last = terms[terms.length - 1];
        if (!EMPTY_STRING_RE.test(last)) continue;
        // Algún término intermedio tiene que ser un acceso a propiedad de un
        // objeto de configuración (no otro `process.env`).
        const middle = terms.slice(1, -1);
        const configLike = middle.some((t) => {
            const mm = REPO_CONFIG_MEMBER_RE.exec(t);
            return !!mm && mm[1] !== 'process';
        });
        if (!configLike) continue;
        hits.push({
            line: clean.slice(0, m.index).split('\n').length,
            snippet: terms.join(' || ').slice(0, 160),
        });
    }
    return hits;
}

// --- El detector detecta (si esto se rompe, el test de abajo vale cero) ---

test('CA-8: el detector reconoce el patrón exacto que tenía HEAD', () => {
    // Reproducción sintética de qa-video-share.js:370-372 antes del fix.
    // No hay ningún valor de credencial acá: son nombres de clave.
    const snippet = [
        'const a = process.env.GOOGLE_OAUTH_CLIENT_ID || cfg2.google_oauth_client_id || "";',
        'const b = process.env.GOOGLE_DRIVE_FOLDER_ID || LEGACY_CONFIG.google_drive_folder_id || "";',
    ].join('\n');

    const hits = findCollapsingChains(snippet);
    assert.equal(hits.length, 2, 'el detector debe marcar las dos cadenas');
    assert.equal(hits[0].line, 1);
    assert.equal(hits[1].line, 2);
});

test('CA-8: el detector NO marca resoluciones legítimas', () => {
    const ok = [
        // Default de configuración no sensible, sin nivel de config del repo.
        'const port = process.env.PORT || 8080;',
        // Cadena de dos niveles sin colapso a "".
        'const x = process.env.FOO || fallbackValue;',
        // Resolución explícita por forma (el patrón que introduce #5217).
        'const v = env.GOOGLE_CREDENTIALS_PATH; if (!isPlaceholderOrEmpty(v)) return v;',
        // Dos env vars: no es el patrón "config del repo" que causó el defecto.
        'const t = process.env.A || process.env.B || "";',
    ].join('\n');

    assert.deepEqual(findCollapsingChains(ok), []);
});

test('CA-8: el detector ignora el patrón cuando aparece en un comentario', () => {
    const commented = '// process.env.X || cfg.y || "" <- patrón prohibido\nconst z = 1;';
    assert.deepEqual(findCollapsingChains(commented), []);
});

// --- Los consumidores relevados están limpios ---

for (const rel of AUDITED_FILES) {
    test(`CA-8: ${rel} no resuelve credenciales con cadenas que colapsan a ""`, () => {
        const full = path.join(REPO_ROOT, rel);
        assert.ok(fs.existsSync(full), `no existe el archivo auditado: ${rel}`);

        const hits = findCollapsingChains(fs.readFileSync(full, 'utf8'));
        const detail = hits.map((h) => `  ${rel}:${h.line}  ${h.snippet}`).join('\n');
        assert.equal(
            hits.length, 0,
            `Cadena de resolución que colapsa a "" en ${rel}.\n` +
            `El valor real vive en ~/.claude/secrets/credentials.json; un nivel vacío\n` +
            `no debe colapsar en silencio. Usar el resolvedor genérico\n` +
            `(resolveCredential + resolveScopedRefs) en vez del encadenamiento:\n${detail}`,
        );
    });
}

// CA-9: ningún mensaje al operador manda a ESCRIBIR credenciales de Drive en el
// archivo trackeado del repo. Nombrarlo como fuente legacy consultada sí es
// válido — lo que se prohíbe es enseñarlo como destino.
test('CA-9: ningún mensaje instruye a escribir google_oauth_* en el config del repo', () => {
    const offending = [];
    for (const rel of AUDITED_FILES) {
        const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        source.split('\n').forEach((line, i) => {
            if (!/console\.(log|error|warn)|sendTelegramMessage/.test(line)) return;
            const teaches =
                /definir\s+google_oauth_/i.test(line) ||
                (/telegram-config\.json/.test(line) && /(guardar|escrib|definir|configurar)/i.test(line)) ||
                // El método inseguro de invocación (secreto en argv) tampoco se enseña.
                /google-drive-oauth-setup\.js\s*<?CLIENT_ID>?\s+<?CLIENT_SECRET>?/i.test(line);
            if (teaches) offending.push(`${rel}:${i + 1}  ${line.trim().slice(0, 140)}`);
        });
    }
    assert.deepEqual(
        offending, [],
        'Un mensaje sigue enseñando el procedimiento que #5217 elimina:\n' + offending.join('\n'),
    );
});

// CA-9 (cont.) - la documentacion operativa cuenta como "mensaje al operador".
// Un doc que ensena el metodo viejo hace exactamente el dano que CA-9 evita: el
// operador repone credenciales a mano en el archivo trackeado y deshace el fix.
// Fue el caso de `docs/google-drive-qa-setup.html`, que quedo stale y este test
// no podia ver porque solo auditaba archivos .js.
const AUDITED_DOCS = [
    'docs/google-drive-qa-setup.html',
];

test('CA-9: la documentacion no ensena a guardar credenciales de Drive en el config del repo', () => {
    const offending = [];
    for (const rel of AUDITED_DOCS) {
        const full = path.join(REPO_ROOT, rel);
        if (!fs.existsSync(full)) continue;
        fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
            // Prohibido: presentar el archivo del repo como DESTINO de las
            // credenciales de Drive. Nombrarlo como fuente legacy, o advertir
            // que NO se escriba ahi, es legitimo.
            const mentionsRepoConfig = /telegram-config\.json/.test(line);
            const teachesWrite = /(agregar|guarda|guardar|escrib|definir|configurar)/i.test(line)
                && !/\bNO\b|nunca|solo lectura/.test(line);
            // Prohibido: el metodo inseguro de invocacion (secreto en argv).
            const teachesArgvSecret = /google-drive-oauth-setup\.js[^<]*CLIENT_SECRET/i.test(line);
            if ((mentionsRepoConfig && teachesWrite) || teachesArgvSecret) {
                offending.push(rel + ':' + (i + 1) + '  ' + line.trim().slice(0, 140));
            }
        });
    }
    assert.deepEqual(
        offending, [],
        'Documentacion desincronizada con el flujo de #5217:\n' + offending.join('\n'),
    );
});

module.exports = { findCollapsingChains };
