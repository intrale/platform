// Test P-30: Heartbeat Telegram - frecuencia adaptativa (#1396)
// Verifica la lógica de intervalo adaptativo en heartbeat-manager.js (migrado desde reporter-bg.js — #1431):
// - Detección de actividad por sesiones (.claude/sessions/*.json) con threshold 15 min
// - Persistencia de estado en heartbeat-state.json
// - Progresión de intervalos: 10 → 20 → 30 → ... → 60 min
// - Indicador de modo en captions (💚 normal / 💤 inactivo)
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const HEARTBEAT_FILE = path.join(__dirname, "..", "heartbeat-manager.js");
const heartbeatSrc = fs.readFileSync(HEARTBEAT_FILE, "utf8");

describe("P-30: Heartbeat - frecuencia adaptativa (#1396)", () => {

    describe("Detección de actividad por sesiones", () => {
        it("define la función hasActiveSessions", () => {
            assert.ok(heartbeatSrc.includes("function hasActiveSessions"), "Debe definir hasActiveSessions");
        });
        it("lee la carpeta .claude/sessions/ para detectar actividad", () => {
            assert.ok(
                heartbeatSrc.includes("DEFAULT_SESSIONS_DIR") || heartbeatSrc.includes("sessionsDir"),
                "Debe usar sessionsDir o DEFAULT_SESSIONS_DIR"
            );
            assert.ok(heartbeatSrc.includes("sessions"), "Debe apuntar al directorio sessions");
        });
        it("verifica el campo status === active en cada sesión", () => {
            assert.ok(
                heartbeatSrc.includes("status === 'active'") || heartbeatSrc.includes('status === "active"'),
                "Debe verificar status === active"
            );
        });
        it("usa last_activity_ts para calcular tiempo de actividad (no started_ts)", () => {
            assert.ok(heartbeatSrc.includes("last_activity_ts"), "Debe usar last_activity_ts");
        });
        it("define ACTIVITY_THRESHOLD_MIN como umbral de actividad", () => {
            assert.ok(heartbeatSrc.includes("ACTIVITY_THRESHOLD_MIN"), "Debe definir ACTIVITY_THRESHOLD_MIN");
        });
        it("el threshold de actividad es 15 minutos", () => {
            assert.ok(heartbeatSrc.includes("ACTIVITY_THRESHOLD_MIN = 15"), "El threshold debe ser 15 minutos");
        });
        it("solo archivos .json se procesan del directorio de sesiones", () => {
            assert.ok(
                heartbeatSrc.includes(".endsWith('.json')") || heartbeatSrc.includes('.endsWith(".json")'),
                "Debe filtrar archivos .json"
            );
        });
        it("retorna false si la carpeta sessions no existe", () => {
            assert.ok(
                heartbeatSrc.includes("existsSync(sessionsDir)") || heartbeatSrc.includes("existsSync(SESSIONS_DIR)"),
                "Debe verificar si el directorio existe"
            );
        });
    });

    describe("Persistencia de estado en heartbeat-state.json", () => {
        it("define la constante HEARTBEAT_STATE_FILE", () => {
            assert.ok(heartbeatSrc.includes("HEARTBEAT_STATE_FILE"), "Debe definir HEARTBEAT_STATE_FILE");
        });
        it("el archivo de estado apunta a heartbeat-state.json", () => {
            assert.ok(heartbeatSrc.includes("heartbeat-state.json"), "El archivo de estado debe ser heartbeat-state.json");
        });
        it("define la función loadHeartbeatState", () => {
            assert.ok(heartbeatSrc.includes("function loadHeartbeatState"), "Debe definir loadHeartbeatState");
        });
        it("define la función saveHeartbeatState", () => {
            assert.ok(heartbeatSrc.includes("function saveHeartbeatState"), "Debe definir saveHeartbeatState");
        });
        it("el estado persistido incluye currentInterval", () => {
            assert.ok(heartbeatSrc.includes("currentInterval"), "El estado debe incluir currentInterval");
        });
        it("el estado persistido incluye consecutiveIdle", () => {
            assert.ok(heartbeatSrc.includes("consecutiveIdle"), "El estado debe incluir consecutiveIdle");
        });
        it("el estado persistido incluye lastHeartbeat", () => {
            assert.ok(heartbeatSrc.includes("lastHeartbeat"), "El estado debe incluir lastHeartbeat");
        });
        it("el estado persistido incluye mode (normal/idle)", () => {
            assert.ok(heartbeatSrc.includes('"mode"') || heartbeatSrc.includes("mode:"), "El estado debe incluir mode");
        });
        it("carga el estado previo al arrancar (sobrevive reinicios)", () => {
            assert.ok(heartbeatSrc.includes("loadHeartbeatState"), "Debe llamar a loadHeartbeatState al arrancar");
        });
        it("guarda el estado tras cada ciclo", () => {
            assert.ok(heartbeatSrc.includes("saveHeartbeatState"), "Debe llamar a saveHeartbeatState tras cada ciclo");
        });
    });

    describe("Progresión de intervalos adaptativos", () => {
        it("define MAX_INTERVAL_MIN como cap máximo", () => {
            assert.ok(heartbeatSrc.includes("MAX_INTERVAL_MIN"), "Debe definir MAX_INTERVAL_MIN");
        });
        it("el cap máximo es 60 minutos", () => {
            assert.ok(heartbeatSrc.includes("MAX_INTERVAL_MIN = 60"), "El cap máximo debe ser 60 minutos");
        });
        it("define INTERVAL_STEP_MIN como incremento por ciclo inactivo", () => {
            assert.ok(heartbeatSrc.includes("INTERVAL_STEP_MIN"), "Debe definir INTERVAL_STEP_MIN");
        });
        it("el incremento por ciclo inactivo es 10 minutos", () => {
            assert.ok(heartbeatSrc.includes("INTERVAL_STEP_MIN = 10"), "El incremento debe ser 10 minutos");
        });
        it("usa Math.min para respetar el cap máximo de 60 min", () => {
            assert.ok(heartbeatSrc.includes("Math.min("), "Debe usar Math.min para el cap máximo");
            assert.ok(heartbeatSrc.includes("MAX_INTERVAL_MIN"), "Debe incluir MAX_INTERVAL_MIN en el Math.min");
        });
        it("usa consecutiveIdle para calcular el siguiente intervalo", () => {
            assert.ok(heartbeatSrc.includes("consecutiveIdle"), "Debe usar consecutiveIdle en el cálculo");
        });
        it("reinicia consecutiveIdle a 0 cuando hay actividad", () => {
            assert.ok(
                heartbeatSrc.includes("consecutiveIdle = 0") || heartbeatSrc.includes("heartbeatConsecutiveIdle = 0"),
                "Debe reiniciar consecutiveIdle a 0 al detectar actividad"
            );
        });
        it("incrementa consecutiveIdle cuando no hay actividad", () => {
            assert.ok(
                heartbeatSrc.includes("consecutiveIdle++") || heartbeatSrc.includes("heartbeatConsecutiveIdle++"),
                "Debe incrementar consecutiveIdle cuando no hay actividad"
            );
        });
        it("con actividad, el intervalo vuelve al base (intervalo base de configuración)", () => {
            assert.ok(
                heartbeatSrc.includes("reportIntervalMin") || heartbeatSrc.includes("intervalMin"),
                "Con actividad debe volver al intervalo base de configuración"
            );
        });
    });

    describe("Variables de estado de módulo", () => {
        it("define heartbeatMode como variable de módulo", () => {
            assert.ok(
                heartbeatSrc.includes("let heartbeatMode") || heartbeatSrc.includes("heartbeatMode ="),
                "Debe definir heartbeatMode"
            );
        });
        it("define variable de intervalo actual como variable de módulo", () => {
            assert.ok(
                heartbeatSrc.includes("heartbeatCurrentInterval") || heartbeatSrc.includes("heartbeatIntervalMin"),
                "Debe definir variable de intervalo actual"
            );
        });
        it("el modo inicial es normal", () => {
            assert.ok(
                heartbeatSrc.includes("'normal'") || heartbeatSrc.includes('"normal"'),
                "El modo inicial debe ser normal"
            );
        });
        it("el intervalo inicial es 10 minutos", () => {
            assert.ok(
                heartbeatSrc.includes("= 10") || heartbeatSrc.includes("= 10;"),
                "El intervalo inicial debe ser 10 minutos"
            );
        });
    });

    describe("Indicadores de modo en captions", () => {
        it("el modo normal usa el emoji 💚 en el caption", () => {
            // 💚 = \uD83D\uDC9A (emoji verde corazón)
            assert.ok(
                heartbeatSrc.includes("\\ud83d\\udc9a") || heartbeatSrc.includes("\uD83D\uDC9A") || heartbeatSrc.includes("💚"),
                "El modo normal debe usar el emoji 💚"
            );
        });
        it("el modo inactivo usa el emoji 💤 en el caption", () => {
            // 💤 = \uD83D\uDCA4
            assert.ok(
                heartbeatSrc.includes("\\ud83d\\udca4") || heartbeatSrc.includes("\uD83D\uDCA4") || heartbeatSrc.includes("💤"),
                "El modo inactivo debe usar el emoji 💤"
            );
        });
        it("el caption incluye el intervalo actual en minutos", () => {
            assert.ok(
                (heartbeatSrc.includes("heartbeatCurrentInterval") || heartbeatSrc.includes("heartbeatIntervalMin")) && heartbeatSrc.includes("min"),
                "El caption debe incluir el intervalo actual"
            );
        });
        it("el caption de inactividad incluye 'sin actividad'", () => {
            assert.ok(heartbeatSrc.includes("sin actividad"), "El caption de inactividad debe decir 'sin actividad'");
        });
        it("el modeLabel se usa en el caption", () => {
            assert.ok(heartbeatSrc.includes("modeLabel"), "El modeLabel debe usarse en los captions");
        });
    });

    describe("Función adaptiveHeartbeatLoop — integración general", () => {
        it("define la función del loop adaptativo", () => {
            assert.ok(
                heartbeatSrc.includes("function adaptiveHeartbeatLoop") || heartbeatSrc.includes("function adaptiveLoop"),
                "Debe definir la función del loop adaptativo"
            );
        });
        it("usa hasActiveSessions para detectar actividad", () => {
            assert.ok(heartbeatSrc.includes("hasActiveSessions()"), "Debe usar hasActiveSessions para detectar actividad");
        });
        it("actualiza heartbeatMode antes de llamar sendHeartbeat", () => {
            const loopIdx = heartbeatSrc.indexOf("async function adaptiveHeartbeatLoop") !== -1
                ? heartbeatSrc.indexOf("async function adaptiveHeartbeatLoop")
                : heartbeatSrc.indexOf("async function adaptiveLoop");
            assert.ok(loopIdx !== -1, "Debe existir la función del loop adaptativo");
            const loopBody = heartbeatSrc.substring(loopIdx, loopIdx + 3000);
            const modeSetIdx = loopBody.indexOf("heartbeatMode =");
            const callIdx = loopBody.indexOf("sendHeartbeat") !== -1
                ? loopBody.indexOf("sendHeartbeat")
                : loopBody.indexOf("sendPeriodicReport");
            assert.ok(modeSetIdx !== -1 && callIdx !== -1, "Ambas referencias deben existir en el loop adaptativo");
            assert.ok(modeSetIdx < callIdx, "heartbeatMode debe asignarse antes de la llamada al heartbeat");
        });
        it("programa el siguiente ciclo con setTimeout usando el intervalo calculado", () => {
            assert.ok(
                heartbeatSrc.includes("setTimeout(adaptiveHeartbeatLoop") || heartbeatSrc.includes("setTimeout(adaptiveLoop"),
                "Debe programar el siguiente ciclo con setTimeout"
            );
        });
        it("el intervalo del setTimeout usa minutos convertidos a milisegundos (* 60 * 1000)", () => {
            assert.ok(heartbeatSrc.includes("* 60 * 1000"), "El intervalo debe convertirse a milisegundos");
        });
    });

});
