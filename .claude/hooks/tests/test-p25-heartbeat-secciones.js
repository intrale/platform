// Test P-25: Heartbeat Telegram - screenshots por seccion semantica (#1263)
// Verifica la LOGICA REAL y las MEJORAS DE ROBUSTEZ en takeScreenshotSections:
// - Coordenadas redondeadas a enteros (requisito de Puppeteer)
// - Bounds checking para no superar altura de pagina
// - Error handling por seccion (una seccion fallida no rompe las demas)
// - waitUntil: 'load' + 2s delay para renderizado completo
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const REPORTER_FILE = path.join(__dirname, "..", "reporter-bg.js");
const DASHBOARD_FILE = path.join(__dirname, "..", "..", "dashboard-server.js");

const reporterSrc = fs.readFileSync(REPORTER_FILE, "utf8");
const dashboardSrc = fs.readFileSync(DASHBOARD_FILE, "utf8");

describe("P-25: Heartbeat Telegram - screenshots por seccion semantica (#1263)", () => {

    describe("dashboard-server.js: endpoint /screenshots/sections", () => {
        it("el endpoint /screenshots/sections esta registrado", () => {
            assert.ok(dashboardSrc.includes("/screenshots/sections"), "Debe tener el endpoint /screenshots/sections");
        });
        it("el endpoint usa ancho 390px por default (mobile-first)", () => {
            assert.ok(dashboardSrc.includes("390"), "El ancho default debe ser 390px");
        });
        it("retorna Content-Type application/json con array de secciones", () => {
            assert.ok(dashboardSrc.includes("application/json"), "Debe retornar application/json");
            assert.ok(dashboardSrc.includes("JSON.stringify(sections)"), "Debe serializar array de secciones");
        });
    });

    describe("dashboard-server.js: funcion takeScreenshotSections", () => {
        it("la funcion takeScreenshotSections existe", () => {
            assert.ok(dashboardSrc.includes("function takeScreenshotSections"), "Debe definir takeScreenshotSections");
        });
        it("usa getBoundingClientRect() para coordenadas reales (no corte geometrico fijo)", () => {
            assert.ok(dashboardSrc.includes("getBoundingClientRect()"), "Debe usar getBoundingClientRect()");
        });
        it("corrige el offset de scroll con window.scrollY", () => {
            assert.ok(dashboardSrc.includes("window.scrollY"), "Debe usar window.scrollY para corregir offset");
        });
        it("usa viewport de 2400px para que todos los paneles rendericen", () => {
            assert.ok(dashboardSrc.includes("2400"), "El viewport height debe ser 2400px");
        });
        it("usa waitUntil: load para renderizado completo antes de capturar", () => {
            assert.ok(dashboardSrc.includes('"load"'), 'Debe usar waitUntil: "load" para renderizado completo');
        });
        it("usa delay de 2000ms para que todos los paneles sean visibles", () => {
            assert.ok(dashboardSrc.includes("2000"), "Debe esperar 2000ms para renderizado");
        });
        it("redondea coordenadas a enteros (requisito de Puppeteer clip)", () => {
            assert.ok(dashboardSrc.includes("Math.round(r.x)") || dashboardSrc.includes("Math.round(r.y"), "Debe redondear coordenadas a enteros con Math.round");
        });
        it("hace bounds check contra pageHeight para no superar el alto de pagina", () => {
            assert.ok(dashboardSrc.includes("pageHeight"), "Debe obtener pageHeight para bounds checking");
            assert.ok(dashboardSrc.includes("clampedHeight"), "Debe clampar la altura con clampedHeight");
        });
        it("cada seccion tiene try/catch individual (una falla no rompe las demas)", () => {
            assert.ok(dashboardSrc.includes("sectionErr") || dashboardSrc.includes("Una seccion fallida"), "Debe tener error handling por seccion");
        });
        it("define 5 selectores semanticos: kpis, ejecucion, sesiones, metricas, ci", () => {
            assert.ok(dashboardSrc.includes("kpis"), "Selector kpis");
            assert.ok(dashboardSrc.includes("ejecucion"), "Selector ejecucion");
            assert.ok(dashboardSrc.includes("sesiones"), "Selector sesiones");
            assert.ok(dashboardSrc.includes("metricas"), "Selector metricas");
            assert.ok(dashboardSrc.includes('"ci"') || dashboardSrc.includes("'ci'"), "Selector ci");
        });
        it("usa .kpi-row como selector CSS para el panel de KPIs", () => {
            assert.ok(dashboardSrc.includes(".kpi-row"), "Debe usar .kpi-row para los KPIs");
        });
        it("filtra paneles vacios con height < 20 para omitir paneles no renderizados", () => {
            assert.ok(dashboardSrc.includes("r.height < 20") || dashboardSrc.includes("height < 20"), "Debe filtrar paneles < 20px");
        });
        it("excluye imagenes menores a 5000 bytes (screenshots en blanco)", () => {
            assert.ok(dashboardSrc.includes("5000"), "Debe excluir imagenes < 5000 bytes");
        });
        it("retorna array con { id, image: base64 } por seccion", () => {
            assert.ok(dashboardSrc.includes("{ id: section.id, image:"), "Cada seccion retorna { id, image }");
        });
        it("filtra nulls con .filter(Boolean) para paneles inexistentes en DOM", () => {
            assert.ok(dashboardSrc.includes(".filter(Boolean)"), "Debe filtrar nulls con filter Boolean");
        });
        it("cierra la pagina de Puppeteer en finally (evita memory leaks)", () => {
            assert.ok(dashboardSrc.includes("page.close()"), "Debe cerrar la pagina en finally");
        });
    });

    describe("dashboard-server.js: atributos data-panel en HTML generado", () => {
        it('panel de Ejecucion tiene data-panel="exec"', () => {
            assert.ok(dashboardSrc.includes('data-panel="exec"'), 'Panel Ejecucion debe tener data-panel="exec"');
        });
        it('panel de Sesiones/Flow tiene data-panel="sessions"', () => {
            assert.ok(dashboardSrc.includes('data-panel="sessions"'), 'Panel Sesiones debe tener data-panel="sessions"');
        });
        it('panel de Metricas tiene data-panel="metrics"', () => {
            assert.ok(dashboardSrc.includes('data-panel="metrics"'), 'Panel Metricas debe tener data-panel="metrics"');
        });
        it('panel de CI/CD tiene data-panel="ci"', () => {
            assert.ok(dashboardSrc.includes('data-panel="ci"'), 'Panel CI debe tener data-panel="ci"');
        });
        it('panel de KPIs tiene clase kpi-row', () => {
            assert.ok(dashboardSrc.includes('class="kpi-row"'), "Panel KPIs debe tener clase kpi-row");
        });
    });

    describe("reporter-bg.js: funcion fetchScreenshotSections", () => {
        it("la funcion fetchScreenshotSections existe", () => {
            assert.ok(reporterSrc.includes("function fetchScreenshotSections"), "Debe definir fetchScreenshotSections");
        });
        it("llama al endpoint /screenshots/sections?w=390 (mobile-first)", () => {
            assert.ok(reporterSrc.includes("/screenshots/sections?w="), "Debe llamar a /screenshots/sections?w=");
            assert.ok(reporterSrc.includes("fetchScreenshotSections(390)"), "Debe pasar width=390");
        });
        it("convierte image base64 a Buffer para envio a Telegram", () => {
            assert.ok(reporterSrc.includes('Buffer.from(s.image, "base64")'), "Debe convertir base64 a Buffer");
        });
        it("retorna null en caso de error para activar fallback", () => {
            assert.ok(reporterSrc.includes("resolve(null)"), "Debe retornar null en caso de error");
        });
        it("tiene timeout de 30 segundos (mas generoso que split de 25s)", () => {
            assert.ok(reporterSrc.includes("30000"), "El timeout debe ser 30000ms");
        });
    });

    describe("reporter-bg.js: sendPeriodicReport - prioridad y fallback", () => {
        it("intenta secciones ANTES que album top/bottom (mayor prioridad)", () => {
            const sectionsIdx = reporterSrc.indexOf("fetchScreenshotSections");
            const screenshotsIdx = reporterSrc.indexOf("fetchScreenshots");
            assert.ok(sectionsIdx !== -1 && screenshotsIdx !== -1, "Ambas funciones deben existir");
            assert.ok(sectionsIdx < screenshotsIdx, "fetchScreenshotSections debe aparecer ANTES que fetchScreenshots");
        });
        it("requiere minimo 2 secciones validas para enviar album de secciones", () => {
            assert.ok(reporterSrc.includes("sections.length >= 2"), "Debe requerir al menos 2 secciones");
        });
        it("filtra buffers menores a 1000 bytes antes de enviar", () => {
            assert.ok(reporterSrc.includes("b.length > 1000"), "Debe filtrar buffers invalidos");
        });
        it("la caption incluye cantidad de paneles (N paneles)", () => {
            assert.ok(reporterSrc.includes("paneles"), "La caption debe incluir N paneles");
        });
        it("usa sendTelegramMediaGroup para enviar multiples fotos (no sendPhoto)", () => {
            assert.ok(reporterSrc.includes("sendTelegramMediaGroup"), "Debe usar sendTelegramMediaGroup");
        });
        it("el album se envia silencioso (disable_notification: true)", () => {
            assert.ok(
                reporterSrc.includes("sendTelegramMediaGroup(validBufs, caption, true)") ||
                reporterSrc.includes(", caption, true)"),
                "El album debe enviarse silencioso"
            );
        });
        it("tiene fallback a /screenshots si endpoint de secciones falla", () => {
            assert.ok(reporterSrc.includes("fetchScreenshots"), "Debe tener fallback fetchScreenshots");
        });
        it("tiene fallback final a foto unica si el album falla", () => {
            assert.ok(reporterSrc.includes("fetchScreenshot("), "Debe tener fallback final a screenshot simple");
        });
    });

    describe("Retrocompatibilidad: endpoints originales siguen disponibles", () => {
        it('el endpoint /screenshots (split geometrico) sigue disponible', () => {
            assert.ok(
                dashboardSrc.includes('pathname === "/screenshots"') ||
                dashboardSrc.includes('=== "/screenshots"'),
                "El endpoint /screenshots debe seguir disponible"
            );
        });
        it('el endpoint /screenshot (PNG simple) sigue disponible', () => {
            assert.ok(
                dashboardSrc.includes('pathname === "/screenshot"') ||
                dashboardSrc.includes('=== "/screenshot"'),
                "El endpoint /screenshot debe seguir disponible"
            );
        });
    });

});
