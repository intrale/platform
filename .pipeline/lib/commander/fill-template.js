// =============================================================================
// fill-template.js — Helper para rellenar plantillas Markdown del Commander
// determinístico (issue #3257, CA-3 / CA-12).
//
// Renderiza plantillas en `lib/commander/templates/*.md` con sintaxis
// Handlebars-básica:
//
//   {{var}}                       → reemplazo simple con escape MarkdownV2
//   {{{var}}}                     → reemplazo SIN escape (composición segura)
//   {{#if cond}}...{{/if}}        → condicional binario
//   {{#if cond}}A{{else}}B{{/if}} → if/else
//   {{#each items}}...{{/each}}   → iteración (`{{this}}` para primitivos)
//
// Reglas inquebrantables:
// - Cero `eval`, `new Function`, `vm`. Parser puro por regex + recursión.
// - Toda interpolación de `{{var}}` pasa por escapeMarkdownV2 (CA-12).
// - Inputs con metacaracteres MarkdownV2 (`*_[]<>...`) renderizan como texto
//   literal — no se interpreta su intención.
//
// Diseñado para correr en hot-path del Commander (singleton), sin caché agresiva:
// las plantillas son chicas (< 2 KB) y se leen una vez por dispatch.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, 'templates');

// Caracteres de MarkdownV2 que requieren escape según docs oficiales de Telegram.
// Ref: https://core.telegram.org/bots/api#markdownv2-style
const MD_V2_SPECIALS = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

/**
 * Escapa todos los metacaracteres de MarkdownV2 con backslash.
 * @param {string} value
 * @returns {string}
 */
function escapeMarkdownV2(value) {
    if (value === null || value === undefined) return '';
    const str = typeof value === 'string' ? value : String(value);
    return str.replace(MD_V2_SPECIALS, '\\$1');
}

/**
 * Verdad falsy para condicionales: null/undefined/""/0/false/[] son falsos.
 * @param {*} v
 */
function isTruthy(v) {
    if (v === null || v === undefined) return false;
    if (v === false || v === 0) return false;
    if (typeof v === 'string' && v.length === 0) return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
}

/**
 * Resolver path tipo `a.b.c` o `kebab-case` contra el contexto.
 * Convierte `kebab-case` → `kebabCase` para tolerar ambos estilos en el data.
 * @param {object} ctx
 * @param {string} keyPath
 */
function resolvePath(ctx, keyPath) {
    if (ctx === undefined || ctx === null) return undefined;
    if (keyPath === 'this') {
        // Si el ctx fue extendido con `.this` (caso de items primitivos en `each`),
        // devolvemos ese valor; sino, devolvemos el ctx entero.
        if (typeof ctx === 'object' && Object.prototype.hasOwnProperty.call(ctx, 'this')) {
            return ctx.this;
        }
        return ctx;
    }
    // dotted path
    const parts = keyPath.split('.');
    let current = ctx;
    for (const part of parts) {
        if (current === null || current === undefined) return undefined;
        if (typeof current !== 'object') return undefined;
        // Tolerar kebab-case → camelCase y match exacto.
        const camel = part.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
        if (Object.prototype.hasOwnProperty.call(current, part)) {
            current = current[part];
        } else if (Object.prototype.hasOwnProperty.call(current, camel)) {
            current = current[camel];
        } else {
            return undefined;
        }
    }
    return current;
}

/**
 * Renderiza un bloque de template aplicando contexto.
 * Procesa en orden: each → if → triple-brace → simple-brace.
 * @param {string} template
 * @param {object} ctx
 */
function render(template, ctx) {
    // 1. {{#each items}}...{{/each}}
    template = renderEach(template, ctx);
    // 2. {{#if cond}}...{{else}}...{{/if}}  /  {{#if cond}}...{{/if}}
    template = renderIf(template, ctx);
    // 3. {{{triple-brace}}} sin escape — composición segura
    template = template.replace(/\{\{\{\s*([\w.-]+)\s*\}\}\}/g, (_, name) => {
        const v = resolvePath(ctx, name);
        return v === null || v === undefined ? '' : String(v);
    });
    // 4. {{simple-brace}} con escape MarkdownV2
    template = template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, name) => {
        const v = resolvePath(ctx, name);
        return escapeMarkdownV2(v);
    });
    return template;
}

function renderEach(template, ctx) {
    // No-greedy across multiline. Soporta anidación simple (un nivel de profundidad).
    const re = /\{\{#each\s+([\w.-]+)\s*\}\}([\s\S]*?)\{\{\/each\}\}/;
    while (re.test(template)) {
        template = template.replace(re, (_, name, body) => {
            const arr = resolvePath(ctx, name);
            if (!Array.isArray(arr) || arr.length === 0) return '';
            return arr.map((item) => {
                // Para items primitivos, `{{this}}` resuelve al primitivo;
                // para objetos, los campos se resuelven directos.
                const itemCtx = typeof item === 'object' && item !== null
                    ? { ...ctx, ...item, this: item }
                    : { ...ctx, this: item };
                return render(body, itemCtx);
            }).join('');
        });
    }
    return template;
}

function renderIf(template, ctx) {
    // {{#if x}}A{{else}}B{{/if}} primero (greedy del else), después {{#if x}}A{{/if}}.
    const reIfElse = /\{\{#if\s+([\w.-]+)\s*\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/;
    while (reIfElse.test(template)) {
        template = template.replace(reIfElse, (_, name, ifBranch, elseBranch) => {
            const v = resolvePath(ctx, name);
            return isTruthy(v) ? ifBranch : elseBranch;
        });
    }
    const reIf = /\{\{#if\s+([\w.-]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/;
    while (reIf.test(template)) {
        template = template.replace(reIf, (_, name, body) => {
            const v = resolvePath(ctx, name);
            return isTruthy(v) ? body : '';
        });
    }
    return template;
}

/**
 * Cache de plantillas en memoria (singleton — el commander corre 1 proceso).
 */
const cache = new Map();

function loadTemplate(name) {
    if (cache.has(name)) return cache.get(name);
    const fn = `${name}.md`;
    // Allowlist defensiva: nombres en kebab-case sin barras (CA-13, sin path traversal).
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        throw new Error(`Nombre de plantilla inválido: "${name}"`);
    }
    const full = path.join(TEMPLATES_DIR, fn);
    if (!full.startsWith(TEMPLATES_DIR + path.sep) && full !== TEMPLATES_DIR) {
        throw new Error(`Plantilla fuera del directorio permitido: "${name}"`);
    }
    if (!fs.existsSync(full)) {
        throw new Error(`Plantilla no encontrada: "${name}" (${full})`);
    }
    const content = fs.readFileSync(full, 'utf8');
    cache.set(name, content);
    return content;
}

/**
 * Renderiza la plantilla `name` con `data` y devuelve el string final
 * listo para enviar a Telegram con `parse_mode=MarkdownV2`.
 *
 * @param {string} name   - Nombre kebab-case sin extensión (ej. 'status')
 * @param {object} data   - Datos para rellenar placeholders
 * @returns {string}
 */
function fillTemplate(name, data) {
    const tpl = loadTemplate(name);
    return render(tpl, data || {});
}

/**
 * Invalida el cache — útil para tests o cuando se recargan plantillas.
 */
function clearCache() {
    cache.clear();
}

module.exports = {
    fillTemplate,
    escapeMarkdownV2,
    clearCache,
    // Exports internos para tests
    _internal: { render, resolvePath, isTruthy, loadTemplate },
};
