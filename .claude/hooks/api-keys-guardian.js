#!/usr/bin/env node
// api-keys-guardian.js — Protección contra pérdida de API keys en telegram-config.json
//
// Funciones:
//   backup()  — Guarda las keys actuales en un archivo de backup seguro
//   restore() — Restaura las keys desde el backup al config
//   verify()  — Verifica que las keys estén presentes y alerta si faltan
//
// Uso CLI:
//   node api-keys-guardian.js backup
//   node api-keys-guardian.js restore
//   node api-keys-guardian.js verify
//
// El backup se guarda en ~/.intrale-api-keys.json (fuera del repo, no se pierde con stash/checkout)

const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_FILE = path.join(__dirname, "telegram-config.json");
const BACKUP_FILE = path.join(os.homedir(), ".intrale-api-keys.json");

const KEY_FIELDS = ["openai_api_key", "anthropic_api_key", "elevenlabs_api_key"];

function loadJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function backup() {
  const config = loadJSON(CONFIG_FILE);
  if (!config) {
    console.error("❌ No se pudo leer telegram-config.json");
    return false;
  }

  const keys = {};
  let count = 0;
  for (const field of KEY_FIELDS) {
    if (config[field] && config[field].trim() !== "") {
      keys[field] = config[field];
      count++;
    }
  }

  if (count === 0) {
    console.warn("⚠️ No hay API keys configuradas para respaldar");
    return false;
  }

  // Merge con backup existente (no sobreescribir keys que ya estén y las nuevas estén vacías)
  const existing = loadJSON(BACKUP_FILE) || {};
  const merged = { ...existing };
  for (const field of KEY_FIELDS) {
    if (keys[field]) {
      merged[field] = keys[field];
    }
  }
  merged._last_backup = new Date().toISOString();
  merged._source = "api-keys-guardian.js";

  saveJSON(BACKUP_FILE, merged);
  console.log(`✅ Backup de ${count} API key(s) guardado en ${BACKUP_FILE}`);
  return true;
}

function restore() {
  const backup = loadJSON(BACKUP_FILE);
  if (!backup) {
    console.error(`❌ No existe backup en ${BACKUP_FILE}`);
    return false;
  }

  const config = loadJSON(CONFIG_FILE);
  if (!config) {
    console.error("❌ No se pudo leer telegram-config.json");
    return false;
  }

  let restored = 0;
  for (const field of KEY_FIELDS) {
    if (backup[field] && backup[field].trim() !== "") {
      if (!config[field] || config[field].trim() === "") {
        config[field] = backup[field];
        restored++;
        console.log(`  🔑 Restaurada: ${field}`);
      } else {
        console.log(`  ✓ ${field} ya presente (no sobreescrita)`);
      }
    }
  }

  if (restored > 0) {
    saveJSON(CONFIG_FILE, config);
    console.log(`✅ ${restored} key(s) restaurada(s) en telegram-config.json`);
  } else {
    console.log("ℹ️ No fue necesario restaurar ninguna key");
  }
  return true;
}

function verify() {
  const config = loadJSON(CONFIG_FILE);
  if (!config) {
    console.error("❌ No se pudo leer telegram-config.json");
    return { ok: false, missing: KEY_FIELDS };
  }

  const missing = [];
  const present = [];
  for (const field of KEY_FIELDS) {
    if (!config[field] || config[field].trim() === "") {
      missing.push(field);
    } else {
      present.push(field);
    }
  }

  // Si faltan keys, intentar auto-restore desde backup
  if (missing.length > 0) {
    const backup = loadJSON(BACKUP_FILE);
    if (backup) {
      const autoRestored = [];
      for (const field of missing) {
        if (backup[field] && backup[field].trim() !== "") {
          config[field] = backup[field];
          autoRestored.push(field);
        }
      }
      if (autoRestored.length > 0) {
        saveJSON(CONFIG_FILE, config);
        console.log(`🔄 Auto-restauradas ${autoRestored.length} key(s) desde backup: ${autoRestored.join(", ")}`);
        // Recalcular missing
        const stillMissing = missing.filter(f => !autoRestored.includes(f));
        return { ok: stillMissing.length === 0, missing: stillMissing, restored: autoRestored, present };
      }
    }
  }

  if (missing.length === 0) {
    console.log("✅ Todas las API keys están presentes");
  } else {
    console.warn(`⚠️ Keys faltantes: ${missing.join(", ")}`);
    console.warn(`   Backup: ${fs.existsSync(BACKUP_FILE) ? BACKUP_FILE : "NO EXISTE"}`);
  }

  return { ok: missing.length === 0, missing, present };
}

// Exportar para uso programático
module.exports = { backup, restore, verify, BACKUP_FILE, CONFIG_FILE };

// CLI
if (require.main === module) {
  const cmd = process.argv[2];
  switch (cmd) {
    case "backup":
      backup();
      break;
    case "restore":
      restore();
      break;
    case "verify":
      verify();
      break;
    default:
      console.log("Uso: node api-keys-guardian.js [backup|restore|verify]");
      process.exit(1);
  }
}
