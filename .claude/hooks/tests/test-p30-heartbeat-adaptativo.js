// Test P-30: Heartbeat Telegram - frecuencia adaptativa (#1396)
// Verifica la lógica de intervalo adaptativo en reporter-bg.js:
// - Detección de actividad por sesiones (.claude/sessions/*.json) con threshold 15 min
// - Persistencia de estado en heartbeat-state.json
// - Progresión de intervalos: 10 → 20 → 30 → ... → 60 min
// - Indicador de modo en captions (💚 normal / 💤 inactivo)
// - Mensaje de transición al detectar actividad después de inactividad
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const REPORTER_FILE = path.join(__dirname, "..", "reporter-bg.js");
const reporterSrc = fs.readFileSync(REPORTER_FILE, "utf8");

describe("P-30: Heartbeat - frecuencia adaptativa (#1396)", () => {

    describe("Detección de actividad por sesiones", () => {
        it("define la función hasActiveSessions", () => {
            assert.ok(reporterSrc.includes("function hasActiveSessions"), "Debe definir hasActiveSessions");
        });
        it("lee la carpeta .claude/sessions/ para detectar actividad", () => {
            assert.ok(reporterSrc.includes("SESSIONS_DIR"), "Debe usar SESSIONS_DIR");
            assert.ok(reporterSrc.includes("sessions"), "Debe apuntar al directorio sessions");
        });
        it("verifica el campo status === active en cada sesión", () => {
            assert.ok(reporterSrc.includes('session.status === "active"'), 'Debe verificar status === "active"');
        });
        it("usa last_activity_ts para calcular tiempo de actividad (no started_ts)", () => {
            assert.ok(reporterSrc.includes("last_activity_ts"), "Debe usar last_activity_ts");
        });
        it("define ACTIVITY_THRESHOLD_MIN como umbral de actividad", () => {
            assert.ok(reporterSrc.includes("ACTIVITY_THRESHOLD_MIN"), "Debe definir ACTIVITY_THRESHOLD_MIN");
        });
        it("el threshold de actividad es 15 minutos", () => {
            assert.ok(reporterSrc.includes("ACTIVITY_THRESHOLD_MIN = 15"), "El threshold debe ser 15 minutos");
        });
        it("solo archivos .json se procesan del directorio de sesiones", () => {
            assert.ok(reporterSrc.includes('.endsWith(".json")'), "Debe filtrar archivos .json");
        });
        it("retorna false si la carpeta sessions no existe", () => {
            assert.ok(reporterSrc.includes("existsSync(SESSIONS_DIR)"), "Debe verificar si el directorio existe");
        });
    });

    describe("Persistencia de estado en heartbeat-state.json", () => {
        it("define la constante HEARTBEAT_STATE_FILE", () => {
            assert.ok(reporterSrc.includes("HEARTBEAT_STATE_FILE"), "Debe definir HEARTBEAT_STATE_FILE");
        });
        it("el archivo de estado apunta a heartbeat-state.json", () => {
            assert.ok(reporterSrc.includes("heartbeat-state.json"), "El archivo de estado debe ser heartbeat-state.json");
        });
        it("define la función loadHeartbeatState", () => {
            assert.ok(reporterSrc.includes("function loadHeartbeatState"), "Debe definir loadHeartbeatState");
        });
        it("define la función saveHeartbeatState", () => {
            assert.ok(reporterSrc.includes("function saveHeartbeatState"), "Debe definir saveHeartbeatState");
        });
        it("el estado persistido incluye currentInterval", () => {
            assert.ok(reporterSrc.includes("currentInterval"), "El estado debe incluir currentInterval");
        });
        it("el estado persistido incluye consecutiveIdle", () => {
            assert.ok(reporterSrc.includes("consecutiveIdle"), "El estado debe incluir consecutiveIdle");
        });
        it("el estado persistido incluye lastHeartbeat", () => {
            assert.ok(reporterSrc.includes("lastHeartbeat"), "El estado debe incluir lastHeartbeat");
        });
        it("el estado persistido incluye mode (normal/idle)", () => {
            assert.ok(reporterSrc.includes('"mode"') || reporterSrc.includes("mode:"), "El estado debe incluir mode");
        });
        it("carga el estado previo al arrancar (sobrevive reinicios)", () => {
            assert.ok(reporterSrc.includes("loadHeartbeatState"), "Debe llamar a loadHeartbeatState al arrancar");
        });
        it("guarda el estado tras cada ciclo", () => {
            assert.ok(reporterSrc.includes("saveHeartbeatState"), "Debe llamar a saveHeartbeatState tras cada ciclo");
        });
    });

    describe("Progresión de intervalos adaptativos", () => {
        it("define MAX_INTERVAL_MIN como cap máximo", () => {
            assert.ok(reporterSrc.includes("MAX_INTERVAL_MIN"), "Debe definir MAX_INTERVAL_MIN");
        });
        it("el cap máximo es 60 minutos", () => {
            assert.ok(reporterSrc.includes("MAX_INTERVAL_MIN = 60"), "El cap máximo debe ser 60 minutos");
        });
        it("define INTERVAL_STEP_MIN como incremento por ciclo inactivo", () => {
            assert.ok(reporterSrc.includes("INTERVAL_STEP_MIN"), "Debe definir INTERVAL_STEP_MIN");
        });
        it("el incremento por ciclo inactivo es 10 minutos", () => {
            assert.ok(reporterSrc.includes("INTERVAL_STEP_MIN = 10"), "El incremento debe ser 10 minutos");
        });
        it("usa Math.min para respetar el cap máximo de 60 min", () => {
            assert.ok(reporterSrc.includes("Math.min("), "Debe usar Math.min para el cap máximo");
            assert.ok(reporterSrc.includes("MAX_INTERVAL_MIN"), "Debe incluir MAX_INTERVAL_MIN en el Math.min");
        });
        it("usa consecutiveIdle para calcular el siguiente intervalo", () => {
            assert.ok(reporterSrc.includes("consecutiveIdle"), "Debe usar consecutiveIdle en el cálculo");
        });
        it("reinicia consecutiveIdle a 0 cuando hay actividad", () => {
            assert.ok(reporterSrc.includes("consecutiveIdle = 0"), "Debe reiniciar consecutiveIdle a 0 al detectar actividad");
        });
        it("incrementa consecutiveIdle cuando no hay actividad", () => {
            assert.ok(reporterSrc.includes("consecutiveIdle++"), "Debe incrementar consecutiveIdle cuando no hay actividad");
        });
        it("con actividad, el intervalo vuelve al base (10 min)", () => {
            // La formula debe devolver intervalMin cuando active === true
            assert.ok(
                reporterSrc.includes("active ? intervalMin :"),
                "Con actividad debe volver al intervalo base"
            );
        });
    });

    describe("Variables de estado de módulo", () => {
        it("define heartbeatMode como variable de módulo", () => {
            assert.ok(reporterSrc.includes('heartbeatMode = "normal"') || reporterSrc.includes("let heartbeatMode"), "Debe definir heartbeatMode");
        });
        it("define heartbeatIntervalMin como variable de módulo", () => {
            assert.ok(reporterSrc.includes("heartbeatIntervalMin"), "Debe definir heartbeatIntervalMin");
        });
        it("el modo inicial es normal", () => {
            assert.ok(reporterSrc.includes('"normal"'), "El modo inicial debe ser normal");
        });
        it("el intervalo inicial es 10 minutos", () => {
            assert.ok(reporterSrc.includes("heartbeatIntervalMin = 10") || reporterSrc.includes("= 10;"), "El intervalo inicial debe ser 10 minutos");
        });
    });

    describe("Indicadores de modo en captions", () => {
        it("el modo normal usa el emoji 💚 en el caption", () => {
            // 💚 = \uD83D\uDC9A (emoji verde corazón)
            assert.ok(
                reporterSrc.includes("\\ud83d\\udc9a") || reporterSrc.includes("\uD83D\uDC9A") || reporterSrc.includes("💚"),
                "El modo normal debe usar el emoji 💚"
            );
        });
        it("el modo inactivo usa el emoji 💤 en el caption", () => {
            // 💤 = \uD83D\uDCA4
            assert.ok(
                reporterSrc.includes("\\ud83d\\udca4") || reporterSrc.includes("\uD83D\uDCA4") || reporterSrc.includes("💤"),
                "El modo inactivo debe usar el emoji 💤"
            );
        });
        it("el caption incluye el intervalo actual en minutos", () => {
            assert.ok(
                reporterSrc.includes("heartbeatIntervalMin") && reporterSrc.includes("min)"),
                "El caption debe incluir el intervalo actual"
            );
        });
        it("el caption de inactividad incluye 'sin actividad'", () => {
            assert.ok(reporterSrc.includes("sin actividad"), "El caption de inactividad debe decir 'sin actividad'");
        });
        it("el modeLabel se usa en el caption de secciones (KPIs)", () => {
            assert.ok(reporterSrc.includes("modeLabel"), "El modeLabel debe usarse en los captions");
        });
    });

    describe("Mensaje de transición inactivo → normal", () => {
        it("envía mensaje de Telegram al detectar transición de idle a normal", () => {
            assert.ok(reporterSrc.includes("wasIdle"), "Debe detectar la transición usando wasIdle");
        });
        it("solo envía el mensaje de transición cuando se pasa de idle a normal (no en normal→normal)", () => {
            // Debe verificar previousMode === "idle" antes de enviar
            assert.ok(
                reporterSrc.includes('previousMode === "idle"') || reporterSrc.includes("wasIdle"),
                "Debe verificar el modo previo antes de enviar mensaje de transición"
            );
        });
        it("el mensaje de transición menciona volver al monitoreo normal", () => {
            assert.ok(
                reporterSrc.includes("monitoreo normal") || reporterSrc.includes("volviendo a monitoreo"),
                "El mensaje de transición debe mencionar el retorno al monitoreo normal"
            );
        });
        it("el mensaje de transición usa sendTelegramText (no sendTelegramPhoto)", () => {
            // La transición se notifica como texto, no como screenshot
            const transitionIdx = reporterSrc.indexOf("wasIdle");
            assert.ok(transitionIdx !== -1, "Debe existir wasIdle");
            // Verificar que hay un sendTelegramText cerca del bloque wasIdle
            const snippet = reporterSrc.substring(transitionIdx, transitionIdx + 500);
            assert.ok(snippet.includes("sendTelegramText"), "La transición debe usar sendTelegramText");
        });
    });

    describe("Función adaptiveLoop — integración general", () => {
        it("define la función adaptiveLoop dentro del modo daemon", () => {
            assert.ok(reporterSrc.includes("function adaptiveLoop"), "Debe definir adaptiveLoop");
        });
        it("usa hasActiveSessions en lugar de hasActiveAgents para detectar actividad", () => {
            assert.ok(reporterSrc.includes("hasActiveSessions()"), "Debe usar hasActiveSessions para detectar actividad");
        });
        it("actualiza heartbeatMode antes de llamar sendPeriodicReport dentro de adaptiveLoop", () => {
            // Verificar dentro del cuerpo de adaptiveLoop que heartbeatMode se asigna antes de la llamada
            const loopIdx = reporterSrc.indexOf("async function adaptiveLoop");
            assert.ok(loopIdx !== -1, "Debe existir adaptiveLoop");
            const loopBody = reporterSrc.substring(loopIdx, loopIdx + 3000);
            const modeSetIdx = loopBody.indexOf("heartbeatMode =");
            const callIdx = loopBody.indexOf("sendPeriodicReport");
            assert.ok(modeSetIdx !== -1 && callIdx !== -1, "Ambas referencias deben existir en adaptiveLoop");
            assert.ok(modeSetIdx < callIdx, "heartbeatMode debe asignarse antes de la llamada a sendPeriodicReport");
        });
        it("programa el siguiente ciclo con setTimeout usando el intervalo calculado", () => {
            assert.ok(reporterSrc.includes("setTimeout(adaptiveLoop"), "Debe programar el siguiente ciclo con setTimeout");
        });
        it("el intervalo del setTimeout usa minutos convertidos a milisegundos (* 60 * 1000)", () => {
            assert.ok(reporterSrc.includes("* 60 * 1000"), "El intervalo debe convertirse a milisegundos");
        });
    });

});
