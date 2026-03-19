// telegram-last-full-response.js — Almacén temporal de la última respuesta completa
// TTL: 10 minutos. Se usa para servir el detalle bajo demanda (/detalle o botón).
"use strict";

const fs = require("fs");
const path = require("path");

const HOOKS_DIR = __dirname;
const STORE_FILE = path.join(HOOKS_DIR, "telegram-last-full-response.json");
const TTL_MS = 10 * 60 * 1000; // 10 minutos

/**
 * Guarda la última respuesta completa junto con una etiqueta descriptiva.
 * Sobrescribe cualquier respuesta anterior.
 */
function save(text, label) {
    try {
        const data = {
            text: text,
            label: label || "",
            saved_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + TTL_MS).toISOString()
        };
        fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
        // Fallo silencioso — no debe romper el flujo principal
    }
}

/**
 * Carga la última respuesta guardada si aún está vigente.
 * Retorna null si no existe o si expiró.
 */
function load() {
    try {
        if (!fs.existsSync(STORE_FILE)) return null;
        const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
        if (Date.now() > new Date(data.expires_at).getTime()) {
            try { fs.unlinkSync(STORE_FILE); } catch (e) {}
            return null;
        }
        return data;
    } catch (e) {
        return null;
    }
}

/**
 * Elimina la respuesta almacenada.
 */
function clear() {
    try {
        if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
    } catch (e) {}
}

module.exports = { save, load, clear, TTL_MS, STORE_FILE };
