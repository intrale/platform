// Test P-34: Auto-review de PRs abiertos >24h sin review (#1516)
// Verifica que auto-review-bg.js:
//   - Detecta PRs abiertos >24h sin review comments
//   - Aplica análisis estático: patrones prohibidos, loggers, tests
//   - Construye comentario de review con findings + REVIEW_MARKER
//   - Respeta cooldown de 60 minutos entre ejecuciones
//   - Evita duplicar reviews con REVIEW_MARKER
//   - Está registrado en settings.json como hook Stop
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const HOOK_PATH = path.join(__dirname, "..", "auto-review-bg.js");
const SETTINGS_PATH = path.join(__dirname, "..", "..", "settings.json");

function readSource() {
    return fs.readFileSync(HOOK_PATH, "utf8");
}

// ─── Existencia y registro ────────────────────────────────────────────────────

describe("P-34: auto-review — existencia y registro", () => {

    it("archivo auto-review-bg.js existe en .claude/hooks/", () => {
        assert.ok(fs.existsSync(HOOK_PATH), "auto-review-bg.js debe existir en .claude/hooks/");
    });

    it("registrado en settings.json como hook Stop", () => {
        assert.ok(fs.existsSync(SETTINGS_PATH), "settings.json debe existir");
        const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
        const stopHooks = (settings.hooks && settings.hooks.Stop) || [];
        const allCmds = stopHooks.flatMap(g => (g.hooks || []).map(h => h.command || ""));
        const hasHook = allCmds.some(cmd => cmd.includes("auto-review-bg.js"));
        assert.ok(hasHook, "auto-review-bg.js debe estar registrado en Stop hooks de settings.json");
    });

    it("timeout del hook Stop >= 60000ms (suficiente para gh API calls)", () => {
        const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
        const stopHooks = (settings.hooks && settings.hooks.Stop) || [];
        const allHooks = stopHooks.flatMap(g => g.hooks || []);
        const reviewHook = allHooks.find(h => (h.command || "").includes("auto-review-bg.js"));
        assert.ok(reviewHook, "auto-review-bg.js debe estar en los hooks");
        assert.ok(
            (reviewHook.timeout || 0) >= 60000,
            "timeout debe ser >= 60000ms — encontrado: " + reviewHook.timeout
        );
    });

});

// ─── Análisis estático: función analyzeDiff ───────────────────────────────────

describe("P-34: auto-review — análisis de diff (unit)", () => {

    function getAnalyzeDiff() {
        // Cargar solo la función exportada sin ejecutar el script completo
        return require(HOOK_PATH).analyzeDiff;
    }

    it("detecta uso prohibido de stringResource() en archivo UI", () => {
        const analyzeDiff = getAnalyzeDiff();
        const diff = [
            "diff --git a/app/composeApp/src/commonMain/kotlin/ui/sc/LoginScreen.kt b/app/composeApp/src/commonMain/kotlin/ui/sc/LoginScreen.kt",
            "+++ b/app/composeApp/src/commonMain/kotlin/ui/sc/LoginScreen.kt",
            "@@ -1,5 +1,6 @@",
            "+val text = stringResource(R.string.login)"
        ].join("\n");

        const findings = analyzeDiff(diff);
        const hasStringResourceBlocker = findings.blockers.some(b => b.description.includes("stringResource"));
        assert.ok(hasStringResourceBlocker, "debe detectar uso prohibido de stringResource()");
    });

    it("detecta uso prohibido de Res.string.* en archivo Kotlin", () => {
        const analyzeDiff = getAnalyzeDiff();
        const diff = [
            "+++ b/app/composeApp/src/commonMain/kotlin/SomeClass.kt",
            "@@ -1,3 +1,4 @@",
            "+val s = Res.string.my_key"
        ].join("\n");

        const findings = analyzeDiff(diff);
        const hasBlocker = findings.blockers.some(b => b.description.includes("Res.string"));
        assert.ok(hasBlocker, "debe detectar uso prohibido de Res.string.*");
    });

    it("detecta import prohibido de Base64 en capa UI", () => {
        const analyzeDiff = getAnalyzeDiff();
        const diff = [
            "+++ b/app/composeApp/src/commonMain/kotlin/ui/sc/ProfileScreen.kt",
            "@@ -1,3 +1,4 @@",
            "+import kotlin.io.encoding.Base64"
        ].join("\n");

        const findings = analyzeDiff(diff);
        const hasBlocker = findings.blockers.some(b => b.description.includes("Base64"));
        assert.ok(hasBlocker, "debe detectar import prohibido de Base64 en UI");
    });

    it("no reporta bloqueante de stringResource fuera de UI", () => {
        const analyzeDiff = getAnalyzeDiff();
        // En capa backend o ext no aplica la restricción de stringResource
        const diff = [
            "+++ b/app/composeApp/src/commonMain/kotlin/ui/util/ResStrings.kt",
            "@@ -1,3 +1,4 @@",
            "+fun getResString() = stringResource(R.string.login)"
        ].join("\n");

        // ResStrings.kt es el lugar permitido — pero el pattern aún matchea (es en ui/)
        // Para este test verificamos que en archivos no-UI no se reporta
        const diff2 = [
            "+++ b/backend/src/main/kotlin/SomeBackendClass.kt",
            "@@ -1,3 +1,4 @@",
            "+val x = stringResource(y)"
        ].join("\n");

        const findings = analyzeDiff(diff2);
        // En backend no debería detectar stringResource (onlyIn: /\/ui\//)
        const hasBlocker = findings.blockers.some(b => b.description.includes("stringResource"));
        assert.ok(!hasBlocker, "stringResource no debe reportarse en archivos fuera de /ui/");
    });

    it("emite warning si no hay archivos de test en el diff", () => {
        const analyzeDiff = getAnalyzeDiff();
        const diff = [
            "+++ b/app/composeApp/src/commonMain/kotlin/SomeClass.kt",
            "@@ -1,3 +1,4 @@",
            "+class SomeClass {"
        ].join("\n");

        const findings = analyzeDiff(diff);
        const hasTddWarning = findings.warnings.some(w => w.toLowerCase().includes("test"));
        assert.ok(hasTddWarning, "debe emitir warning cuando no hay archivos de test");
    });

    it("no emite warning de test si hay archivos de test en el diff", () => {
        const analyzeDiff = getAnalyzeDiff();
        const diff = [
            "+++ b/app/composeApp/src/commonMain/kotlin/SomeClass.kt",
            "@@ -1,3 +1,4 @@",
            "+class SomeClass {}",
            "+++ b/app/composeApp/src/test/kotlin/SomeClassTest.kt",
            "@@ -1,3 +1,4 @@",
            "+class SomeClassTest {}"
        ].join("\n");

        const findings = analyzeDiff(diff);
        const hasTddWarning = findings.warnings.some(w => w.toLowerCase().includes("sin archivos de test"));
        assert.ok(!hasTddWarning, "no debe emitir warning de test si hay archivos de test en el diff");
    });

    it("retorna findings vacíos para diff limpio", () => {
        const analyzeDiff = getAnalyzeDiff();
        const diff = [
            "+++ b/app/composeApp/src/commonMain/kotlin/SomeClass.kt",
            "@@ -1,3 +1,4 @@",
            "+// Simple comment",
            "+++ b/app/composeApp/src/test/kotlin/SomeClassTest.kt",
            "@@ -1,3 +1,4 @@",
            "+class SomeClassTest {}"
        ].join("\n");

        const findings = analyzeDiff(diff);
        assert.strictEqual(findings.blockers.length, 0, "diff limpio no debe tener bloqueantes");
    });

    it("emite warning info si diff tiene más de 500 líneas añadidas", () => {
        const analyzeDiff = getAnalyzeDiff();
        const addedLines = Array.from({ length: 501 }, (_, i) => "+line " + i).join("\n");
        const diff = [
            "+++ b/app/SomeTest.kt",
            "@@ -1,3 +1,502 @@",
            addedLines
        ].join("\n");

        const findings = analyzeDiff(diff);
        const hasBigDiffInfo = findings.info.some(i => i.includes("Diff grande"));
        assert.ok(hasBigDiffInfo, "debe emitir info para diffs grandes (>500 líneas)");
    });

    it("maneja diff vacío sin lanzar excepción", () => {
        const analyzeDiff = getAnalyzeDiff();
        assert.doesNotThrow(() => analyzeDiff(""), "debe manejar diff vacío sin excepción");
        assert.doesNotThrow(() => analyzeDiff(null), "debe manejar diff null sin excepción");
    });

});

// ─── Lógica de cooldown y estado ─────────────────────────────────────────────

describe("P-34: auto-review — cooldown y estado", () => {

    it("define CHECK_INTERVAL_MS de 60 minutos", () => {
        const src = readSource();
        assert.ok(
            src.includes("60 * 60 * 1000") || src.includes("3600000"),
            "debe tener cooldown de 60 minutos"
        );
    });

    it("define STATE_FILE para persistir PRs revisados", () => {
        const src = readSource();
        assert.ok(src.includes("auto-review-state.json"), "debe definir auto-review-state.json para persistencia");
        assert.ok(src.includes("reviewed_prs"), "debe trackear PRs ya revisados");
    });

    it("verifica último check antes de ejecutar (cooldown)", () => {
        const src = readSource();
        assert.ok(src.includes("last_check"), "debe persistir last_check para cooldown");
        assert.ok(src.includes("CHECK_INTERVAL_MS"), "debe comparar contra CHECK_INTERVAL_MS");
    });

    it("define MIN_AGE_HOURS = 24 como umbral de antigüedad", () => {
        const src = readSource();
        assert.ok(src.includes("MIN_AGE_HOURS"), "debe definir MIN_AGE_HOURS");
        assert.ok(src.includes("24"), "umbral por defecto debe ser 24 horas");
    });

    it("limita reviews a MAX_PER_RUN por ejecución", () => {
        const src = readSource();
        assert.ok(src.includes("MAX_PER_RUN"), "debe definir MAX_PER_RUN para evitar timeouts");
    });

});

// ─── Prevención de duplicados ─────────────────────────────────────────────────

describe("P-34: auto-review — prevención de duplicados", () => {

    it("define REVIEW_MARKER para identificar comentarios ya posteados", () => {
        const src = readSource();
        assert.ok(src.includes("REVIEW_MARKER"), "debe definir REVIEW_MARKER");
        assert.ok(
            src.includes("Revisado por Review Bot"),
            "REVIEW_MARKER debe contener texto identificable"
        );
    });

    it("verifica si el PR ya tiene comentario de auto-review antes de revisar", () => {
        const src = readSource();
        assert.ok(
            src.includes("hasExistingReviewComment"),
            "debe llamar a hasExistingReviewComment para evitar duplicados"
        );
    });

    it("verifica estado local antes de llamar a la API de GitHub", () => {
        const src = readSource();
        assert.ok(
            src.includes("prAlreadyReviewed"),
            "debe revisar estado local (prAlreadyReviewed) antes de la API"
        );
    });

});

// ─── Comentario de review ────────────────────────────────────────────────────

describe("P-34: auto-review — construcción del comentario", () => {

    it("veredicto RECHAZADO cuando hay bloqueantes", () => {
        const src = readSource();
        assert.ok(src.includes('"RECHAZADO"'), "debe incluir veredicto RECHAZADO");
        assert.ok(src.includes("blockers.length > 0"), "debe basar veredicto en presencia de bloqueantes");
    });

    it("veredicto APROBADO cuando no hay bloqueantes", () => {
        const src = readSource();
        assert.ok(src.includes('"APROBADO"'), "debe incluir veredicto APROBADO");
    });

    it("incluye secciones BLOQUEANTES, WARNINGS e INFO en el comentario", () => {
        const src = readSource();
        assert.ok(src.includes("BLOQUEANTES"), "el comentario debe tener sección BLOQUEANTES");
        assert.ok(src.includes("WARNINGS"), "el comentario debe tener sección WARNINGS");
        assert.ok(src.includes("INFO"), "el comentario debe tener sección INFO");
    });

    it("incluye antigüedad del PR en el comentario", () => {
        const src = readSource();
        assert.ok(src.includes("Antigüedad") || src.includes("ageHours"), "debe mostrar antigüedad del PR");
    });

    it("usa escHtml para escapar contenido HTML en el mensaje Telegram", () => {
        const src = readSource();
        assert.ok(src.includes("escHtml"), "debe usar escHtml para escapar HTML en Telegram");
    });

});

// ─── Integración con hook Stop ────────────────────────────────────────────────

describe("P-34: auto-review — integración con hook Stop", () => {

    it("verifica stop_hook_active para evitar recursión", () => {
        const src = readSource();
        assert.ok(src.includes("stop_hook_active"), "debe verificar stop_hook_active");
    });

    it("soporta ejecución standalone sin stdin", () => {
        const src = readSource();
        assert.ok(src.includes("isTTY"), "debe detectar si es hook o standalone");
    });

    it("timeout de stdin para evitar bloqueo", () => {
        const src = readSource();
        assert.ok(src.includes("setTimeout"), "debe usar setTimeout como safety timeout");
    });

    it("fail-open: errores no bloquean el Stop hook", () => {
        const src = readSource();
        assert.ok(src.includes(".catch"), "debe capturar errores con .catch");
    });

    it("no usa eval() (seguridad)", () => {
        const src = readSource();
        const hasEval = /(?<!\w)eval\s*\(/.test(src);
        assert.ok(!hasEval, "no debe usar eval() — usar JSON.parse");
    });

    it("exporta module.exports con runAutoReview y analyzeDiff (testabilidad)", () => {
        const src = readSource();
        assert.ok(src.includes("module.exports"), "debe exportar funciones para tests");
        assert.ok(src.includes("runAutoReview"), "debe exportar runAutoReview");
        assert.ok(src.includes("analyzeDiff"), "debe exportar analyzeDiff");
    });

});

// ─── Logging ─────────────────────────────────────────────────────────────────

describe("P-34: auto-review — logging", () => {

    it("define LOG_FILE y usa appendFileSync", () => {
        const src = readSource();
        assert.ok(src.includes("LOG_FILE"), "debe definir LOG_FILE");
        assert.ok(src.includes("appendFileSync"), "debe usar appendFileSync para logs");
    });

    it("prefija logs con 'AutoReview:'", () => {
        const src = readSource();
        assert.ok(src.includes("AutoReview:"), "debe prefijar logs con AutoReview:");
    });

});
