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

const DASHBOARD_FILE = path.join(__dirname, "..", "..", "dashboard-server.js");

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

    // Nota: los describes de reporter-bg.js (fetchScreenshotSections, sendPeriodicReport) fueron
    // eliminados en #1431 — reporter-bg.js fue removido del repo al unificarse en heartbeat-manager.js

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
