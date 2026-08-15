// Test P-09: telegram-client.js compartido
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

describe("P-09: telegram-client.js compartido", () => {
    it("módulo carga sin error", () => {
        const tgClient = require("../telegram-client");
        assert.ok(tgClient, "telegram-client debería cargar");
    });

    it("exporta sendMessage", () => {
        const tgClient = require("../telegram-client");
        assert.equal(typeof tgClient.sendMessage, "function");
    });

    it("exporta editMessage", () => {
        const tgClient = require("../telegram-client");
        assert.equal(typeof tgClient.editMessage, "function");
    });

    it("exporta telegramPost", () => {
        const tgClient = require("../telegram-client");
        assert.equal(typeof tgClient.telegramPost, "function");
    });

    it("exporta getConfig", () => {
        const tgClient = require("../telegram-client");
        assert.equal(typeof tgClient.getConfig, "function");
    });

    // #5245 (D-3) — CAMBIO DE CONTRATO, no un test aflojado para que pase.
    // Antes esto aseveraba `assert.ok(config.bot_token)` y pasaba PORQUE leía el
    // placeholder trackeado en `.claude/hooks/telegram-config.json` (len=32).
    // Ahora los secretos salen del chokepoint `telegram-secrets.js`, que degrada
    // a "" cuando la máquina no tiene credenciales: el módulo ya NO garantiza un
    // token no vacío. El aserto valida FORMA, no verdad.
    it("getConfig() retorna bot_token y chat_id con forma de string", () => {
        const tgClient = require("../telegram-client");
        const config = tgClient.getConfig();
        assert.equal(typeof config.bot_token, "string");
        assert.equal(typeof config.chat_id, "string");
    });

    it("getConfig() conserva las claves operativas del archivo in-repo", () => {
        // CA-10a: la config operativa versionada sigue disponible; lo que se
        // migró son los secretos, no el archivo entero.
        const tgClient = require("../telegram-client");
        const config = tgClient.getConfig();
        const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "telegram-config.json"), "utf8"));
        if (raw.quiet_hours !== undefined) {
            assert.deepEqual(config.quiet_hours, raw.quiet_hours);
        }
        if (raw.permission_timeout_min !== undefined) {
            assert.equal(config.permission_timeout_min, raw.permission_timeout_min);
        }
    });

    it("#5245 CA-12: el bot_token NO proviene del archivo in-repo cuando hay chokepoint", () => {
        // Se corre en un proceso hijo: `getConfig()` cachea, así que la única
        // forma honesta de probar la precedencia es arrancar limpio.
        const { spawnSync } = require("child_process");
        const clientPath = path.join(__dirname, "..", "telegram-client.js").replace(/\\/g, "\\\\");
        const configPath = path.join(__dirname, "..", "telegram-config.json");
        const inRepo = JSON.parse(fs.readFileSync(configPath, "utf8"));

        const res = spawnSync(process.execPath, [
            "-e",
            `const c = require("${clientPath}").getConfig();`
            + ` process.stdout.write(JSON.stringify({ b: c.bot_token, ch: c.chat_id }));`,
        ], {
            encoding: "utf8",
            env: {
                ...process.env,
                TELEGRAM_BOT_TOKEN: "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                TELEGRAM_CHAT_ID: "987654321",
            },
        });

        assert.equal(res.status, 0, "el hook debe arrancar sin error: " + (res.stderr || ""));
        const out = JSON.parse(res.stdout);
        assert.equal(out.b, "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "el chokepoint pisa siempre");
        assert.equal(out.ch, "987654321");
        assert.notEqual(out.b, inRepo.bot_token, "el archivo in-repo ya no es fuente de bot_token");
    });

    it("#5245 CA-12a: el require cruzado a .pipeline/lib resuelve con cwd ajeno (worktree)", () => {
        // `.claude/` se copia a los worktrees. Si `../../.pipeline/lib/...` no
        // resolviera ahí, tiene que caerse en test, no en producción. El require
        // es FATAL a propósito (sin try/catch ni fallback silencioso).
        const os = require("os");
        const { spawnSync } = require("child_process");
        const clientPath = path.join(__dirname, "..", "telegram-client.js").replace(/\\/g, "\\\\");

        for (const mod of ["telegram-secrets.js", "secrets-guard.js"]) {
            assert.ok(
                fs.existsSync(path.join(__dirname, "..", "..", "..", ".pipeline", "lib", mod)),
                `${mod} debe existir en la raíz del checkout`,
            );
        }

        const res = spawnSync(process.execPath, [
            "-e",
            `require("${clientPath}"); process.stdout.write("ok");`,
        ], { encoding: "utf8", cwd: os.tmpdir() });

        assert.equal(res.status, 0, "require cruzado roto: " + (res.stderr || ""));
        assert.equal(res.stdout, "ok");
    });

    it("TG_MSG_MAX es 4096", () => {
        const tgClient = require("../telegram-client");
        assert.equal(tgClient.TG_MSG_MAX, 4096);
    });

    it("ci-monitor-bg.js usa telegram-client (migración P-09)", () => {
        const ciSource = fs.readFileSync(path.join(__dirname, "..", "ci-monitor-bg.js"), "utf8");
        assert.ok(ciSource.includes('require("./telegram-client")'), "ci-monitor debería usar telegram-client");
    });

    it("exporta sendPhoto y sendDocument", () => {
        const tgClient = require("../telegram-client");
        assert.equal(typeof tgClient.sendPhoto, "function");
        assert.equal(typeof tgClient.sendDocument, "function");
    });
});
