// =============================================================================
// sanitize.js — Saneamiento de strings de terceros (#7592, SR-5 / SR-7)
//
// TODO string que viene de un tercero (campo `license`, nombre, URL, texto de
// LICENSE, metadatos del POM) pasa por acá antes de ir a stdout, al NOTICE, al
// reporte Markdown o al Step Summary de Actions.
//
//   text(s)      → una sola línea, sin control/ANSI/bidi, credenciales
//                  redactadas y truncado.
//   forLog(s)    → text(s) + `::` neutralizado (workflow commands de Actions).
//   forMarkdown  → forLog(s) + Markdown/HTML escapados.
// =============================================================================
'use strict';

const DEFAULT_MAX = 200;
const ELLIPSIS = '…';

// Secuencias ANSI/VT (CSI, OSC y ESC sueltos).
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]?/g;
// Controles C0/C1 (incluye \n, \r, \t: todo campo es de una sola línea).
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
// Overrides bidireccionales (Trojan Source) y separadores de línea Unicode.
const BIDI_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff]/g;

function redactCredentials(s) {
  return s
    // https://user:pass@host → https://***@host (secret-scan:ignore, ejemplo)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    // _authToken=xxx / _auth=xxx / _password=xxx (npmrc)
    .replace(/(_authToken|_auth|_password)(\s*[=:]\s*)[^\s"',;]+/gi, '$1$2***');
}

function truncate(s, max) {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - 1)).join('') + ELLIPSIS;
}

function text(value, max = DEFAULT_MAX) {
  if (value === undefined || value === null) return '';
  let s = String(value);
  s = s.replace(ANSI_RE, '');
  s = s.replace(CONTROL_RE, ' ');
  s = s.replace(BIDI_RE, '');
  s = redactCredentials(s);
  s = s.replace(/\s+/g, ' ').trim();
  return truncate(s, max);
}

function forLog(value, max = DEFAULT_MAX) {
  // Un workflow command es `::cmd::` al inicio de línea. Como todo campo ya es
  // de una sola línea, alcanza con que nunca aparezca `::` literal.
  return text(value, max).replace(/::/g, ': :');
}

const MD_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\\': '\\\\',
  '`': '\\`',
  '*': '\\*',
  '_': '\\_',
  '[': '\\[',
  ']': '\\]',
  '|': '\\|',
  '#': '\\#',
  '~': '\\~',
  '!': '\\!',
};

function forMarkdown(value, max = DEFAULT_MAX) {
  return forLog(value, max).replace(/[&<>"\\`*_[\]|#~!]/g, (c) => MD_ESCAPES[c]);
}

module.exports = { DEFAULT_MAX, text, forLog, forMarkdown, redactCredentials };
