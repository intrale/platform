// Test P-31: dashboard-server.js — frecuencia adaptativa del heartbeat (#1414)
// Verifica que dashboard-server.js integra la lógica adaptativa:
// - Constantes de configuración (HEARTBEAT_STATE_FILE, INTERVAL_STEP_MIN, MAX_INTERVAL_MIN, ACTIVITY_THRESHOLD_MIN)
// - Variables de estado del módulo (heartbeatCurrentInterval, heartbeatConsecutiveIdle, heartbeatMode)
// - Funciones helper (loadHeartbeatState, saveHeartbeatState, hasActiveSessions)
// - Loop adaptativo con setTimeout dinámico (en lugar de setInterval fijo)
// - Indicador de modo en caption (💚 normal / 💤 inactivo)
// - Carga de estado persistido al arrancar
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const DASHBOARD_FILE = path.join(__dirname, "..", "..", "dashboard-server.js");
const dashboardSrc = fs.readFileSync(DASHBOARD_FILE, "utf8");

describe("P-31: dashboard-server.js — frecuencia adaptativa del heartbeat (#1414)", () => {

    describe("Constantes de configuración adaptativa", () => {
        it("define HEARTBEAT_STATE_FILE apuntando a heartbeat-state.json", () => {
            assert.ok(dashboardSrc.includes("HEARTBEAT_STATE_FILE"), "Debe definir HEARTBEAT_STATE_FILE");
            assert.ok(dashboardSrc.includes("heartbeat-state.json"), "El archivo de estado debe ser heartbeat-state.json");
        });
        it("define INTERVAL_STEP_MIN = 10 como incremento por ciclo inactivo", () => {
            assert.ok(dashboardSrc.includes("INTERVAL_STEP_MIN = 10"), "INTERVAL_STEP_MIN debe ser 10 minutos");
        });
        it("define MAX_INTERVAL_MIN = 60 como cap máximo del intervalo", () => {
            assert.ok(dashboardSrc.includes("MAX_INTERVAL_MIN = 60"), "MAX_INTERVAL_MIN debe ser 60 minutos");
        });
        it("define ACTIVITY_THRESHOLD_MIN = 15 como umbral de actividad", () => {
            assert.ok(dashboardSrc.includes("ACTIVITY_THRESHOLD_MIN = 15"), "ACTIVITY_THRESHOLD_MIN debe ser 15 minutos");
        });
    });

    describe("Variables de estado del módulo", () => {
        it("define heartbeatCurrentInterval como variable de módulo", () => {
            assert.ok(dashboardSrc.includes("heartbeatCurrentInterval"), "Debe definir heartbeatCurrentInterval");
        });
        it("define heartbeatConsecutiveIdle como variable de módulo", () => {
            assert.ok(dashboardSrc.includes("heartbeatConsecutiveIdle"), "Debe definir heartbeatConsecutiveIdle");
        });
        it("define heartbeatMode inicializado en 'normal'", () => {
            assert.ok(
                dashboardSrc.includes('heartbeatMode = "normal"') || dashboardSrc.includes("let heartbeatMode"),
                "Debe definir heartbeatMode"
            );
        });
    });

    describe("Función loadHeartbeatState", () => {
        it("define la función loadHeartbeatState", () => {
            assert.ok(dashboardSrc.includes("function loadHeartbeatState"), "Debe definir loadHeartbeatState");
        });
        it("retorna null si el archivo no existe", () => {
            assert.ok(dashboardSrc.includes("existsSync(HEARTBEAT_STATE_FILE)"), "Debe verificar si el archivo existe antes de leer");
        });
        it("parsea el JSON del archivo de estado", () => {
            assert.ok(dashboardSrc.includes("JSON.parse"), "Debe parsear el JSON del archivo de estado");
        });
    });

    describe("Función saveHeartbeatState", () => {
        it("define la función saveHeartbeatState", () => {
            assert.ok(dashboardSrc.includes("function saveHeartbeatState"), "Debe definir saveHeartbeatState");
        });
        it("persiste currentInterval en el estado", () => {
            assert.ok(dashboardSrc.includes("currentInterval"), "El estado debe incluir currentInterval");
        });
        it("persiste consecutiveIdle en el estado", () => {
            assert.ok(dashboardSrc.includes("consecutiveIdle"), "El estado debe incluir consecutiveIdle");
        });
        it("persiste lastHeartbeat como ISO timestamp", () => {
            assert.ok(dashboardSrc.includes("lastHeartbeat"), "El estado debe incluir lastHeartbeat");
        });
        it("persiste mode (normal/idle) en el estado", () => {
            assert.ok(
                dashboardSrc.includes('"mode"') || dashboardSrc.includes("mode:"),
                "El estado debe incluir mode"
            );
        });
    });

    describe("Función hasActiveSessions", () => {
        it("define la función hasActiveSessions en dashboard-server.js", () => {
            assert.ok(dashboardSrc.includes("function hasActiveSessions"), "Debe definir hasActiveSessions");
        });
        it("lee el directorio SESSIONS_DIR para detectar actividad", () => {
            assert.ok(dashboardSrc.includes("SESSIONS_DIR"), "Debe usar SESSIONS_DIR para detectar sesiones activas");
        });
        it("verifica status === 'active' en cada sesión", () => {
            assert.ok(dashboardSrc.includes('session.status === "active"'), 'Debe verificar status === "active"');
        });
        it("usa last_activity_ts para calcular tiempo de actividad", () => {
            assert.ok(dashboardSrc.includes("last_activity_ts"), "Debe usar last_activity_ts");
        });
        it("usa ACTIVITY_THRESHOLD_MIN como umbral de actividad", () => {
            assert.ok(dashboardSrc.includes("ACTIVITY_THRESHOLD_MIN"), "Debe usar ACTIVITY_THRESHOLD_MIN");
        });
        it("solo procesa archivos .json del directorio de sesiones", () => {
            assert.ok(dashboardSrc.includes('.endsWith(".json")'), "Debe filtrar archivos .json");
        });
        it("retorna false si la carpeta sessions no existe", () => {
            assert.ok(dashboardSrc.includes("existsSync(SESSIONS_DIR)"), "Debe verificar si el directorio existe");
        });
    });

    describe("Loop adaptativo con setTimeout dinámico", () => {
        it("define la función adaptiveHeartbeatLoop dentro del bloque de heartbeat", () => {
            assert.ok(dashboardSrc.includes("function adaptiveHeartbeatLoop"), "Debe definir adaptiveHeartbeatLoop");
        });
        it("usa hasActiveSessions para detectar actividad en cada ciclo", () => {
            assert.ok(dashboardSrc.includes("hasActiveSessions()"), "Debe llamar a hasActiveSessions() en cada ciclo");
        });
        it("reinicia consecutiveIdle a 0 cuando hay actividad", () => {
            assert.ok(dashboardSrc.includes("heartbeatConsecutiveIdle = 0"), "Debe reiniciar consecutiveIdle a 0 al detectar actividad");
        });
        it("incrementa consecutiveIdle cuando no hay actividad", () => {
            assert.ok(dashboardSrc.includes("heartbeatConsecutiveIdle++"), "Debe incrementar consecutiveIdle cuando no hay actividad");
        });
        it("usa Math.min para respetar el cap máximo de 60 min", () => {
            assert.ok(dashboardSrc.includes("Math.min("), "Debe usar Math.min para el cap máximo");
            assert.ok(dashboardSrc.includes("MAX_INTERVAL_MIN"), "Debe incluir MAX_INTERVAL_MIN en el Math.min");
        });
        it("programa el próximo ciclo con setTimeout (no setInterval)", () => {
            assert.ok(dashboardSrc.includes("setTimeout(adaptiveHeartbeatLoop"), "Debe usar setTimeout para el loop adaptativo");
        });
        it("el setTimeout usa el intervalo calculado en minutos × 60000", () => {
            assert.ok(dashboardSrc.includes("heartbeatCurrentInterval * 60 * 1000"), "El intervalo debe convertirse a milisegundos");
        });
        it("no usa setInterval para el heartbeat (eliminado en favor de adaptiveHeartbeatLoop)", () => {
            // El setInterval del heartbeat fue reemplazado por setTimeout adaptativo
            // Solo deben quedar los setInterval de broadcastSSE y checkAutoStop
            const heartbeatIntervalIdx = dashboardSrc.indexOf("setInterval(sendHeartbeat");
            assert.ok(heartbeatIntervalIdx === -1, "NO debe usar setInterval(sendHeartbeat,...) — debe usar adaptiveHeartbeatLoop con setTimeout");
        });
        it("llama a saveHeartbeatState tras cada ciclo para persistir el estado", () => {
            assert.ok(dashboardSrc.includes("saveHeartbeatState()"), "Debe llamar a saveHeartbeatState() tras cada ciclo");
        });
    });

    describe("Carga de estado al arrancar (resiliencia a reinicios)", () => {
        it("llama a loadHeartbeatState al arrancar el server", () => {
            assert.ok(dashboardSrc.includes("loadHeartbeatState()"), "Debe llamar a loadHeartbeatState() al arrancar");
        });
        it("restaura consecutiveIdle del estado persistido", () => {
            assert.ok(
                dashboardSrc.includes("persistedState.consecutiveIdle"),
                "Debe restaurar consecutiveIdle del estado persistido"
            );
        });
        it("restaura currentInterval del estado persistido", () => {
            assert.ok(
                dashboardSrc.includes("persistedState.currentInterval"),
                "Debe restaurar currentInterval del estado persistido"
            );
        });
        it("restaura mode del estado persistido", () => {
            assert.ok(
                dashboardSrc.includes("persistedState.mode"),
                "Debe restaurar mode del estado persistido"
            );
        });
    });

    describe("Indicador de modo en caption del heartbeat", () => {
        it("el modo normal usa el emoji 💚 en el caption", () => {
            // 💚 = \uD83D\uDC9A
            assert.ok(
                dashboardSrc.includes("\\ud83d\\udc9a") || dashboardSrc.includes("\uD83D\uDC9A") || dashboardSrc.includes("💚"),
                "El modo normal debe usar el emoji 💚"
            );
        });
        it("el modo inactivo usa el emoji 💤 en el caption", () => {
            // 💤 = \uD83D\uDCA4
            assert.ok(
                dashboardSrc.includes("\\ud83d\\udca4") || dashboardSrc.includes("\uD83D\uDCA4") || dashboardSrc.includes("💤"),
                "El modo inactivo debe usar el emoji 💤"
            );
        });
        it("el caption incluye el intervalo actual (heartbeatCurrentInterval)", () => {
            assert.ok(
                dashboardSrc.includes("heartbeatCurrentInterval"),
                "El caption debe usar heartbeatCurrentInterval"
            );
        });
        it("el caption de inactividad incluye 'sin actividad'", () => {
            assert.ok(dashboardSrc.includes("sin actividad"), "El caption de inactividad debe decir 'sin actividad'");
        });
        it("el caption usa modeIcon para el icono de modo", () => {
            assert.ok(dashboardSrc.includes("modeIcon"), "Debe definir modeIcon para el caption");
        });
        it("el caption usa modeLabel para la descripción del intervalo", () => {
            assert.ok(dashboardSrc.includes("modeLabel"), "Debe definir modeLabel para el caption");
        });
    });

});
