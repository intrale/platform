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

    it("getConfig() retorna objeto con bot_token y chat_id", () => {
        const tgClient = require("../telegram-client");
        const config = tgClient.getConfig();
        assert.ok(config.bot_token, "Config debería tener bot_token");
        assert.ok(config.chat_id, "Config debería tener chat_id");
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
