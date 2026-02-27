// pending-questions.js — Persistencia de preguntas pendientes para Telegram
// Usado por: permission-approver.js, ask-next-sprint.js, telegram-commander.js
//
// Formato del archivo pending-questions.json:
// {
//   "questions": [
//     {
//       "id": "abc123",
//       "type": "permission" | "sprint" | "proposal",
//       "timestamp": "2026-02-26T10:00:00.000Z",
//       "message": "Texto del mensaje enviado",
//       "telegram_message_id": 12345,
//       "options": [{ "label": "Si", "action": "yes" }, ...],
//       "action_data": { ... },  // datos para ejecutar la acción al responder
//       "status": "pending" | "answered" | "expired" | "retried",
//       "answered_at": null
//     }
//   ]
// }

const fs = require("fs");
const path = require("path");

const PENDING_FILE = path.join(__dirname, "pending-questions.json");
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — limpiar automáticamente

function loadQuestions() {
    try {
        return JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
    } catch (e) {
        return { questions: [] };
    }
}

function saveQuestions(data) {
    try {
        fs.writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {}
}

/**
 * Registrar una nueva pregunta pendiente.
 * @param {object} question - { id, type, message, telegram_message_id, options, action_data }
 */
function addPendingQuestion(question) {
    const data = loadQuestions();
    // Limpiar preguntas viejas (>24h)
    const cutoff = Date.now() - MAX_AGE_MS;
    data.questions = data.questions.filter(q => new Date(q.timestamp).getTime() > cutoff);

    data.questions.push({
        id: question.id,
        type: question.type,
        timestamp: new Date().toISOString(),
        message: question.message,
        telegram_message_id: question.telegram_message_id || null,
        options: question.options || [],
        action_data: question.action_data || {},
        status: "pending",
        answered_at: null
    });
    saveQuestions(data);
}

/**
 * Marcar una pregunta como respondida.
 * @param {string} id - ID de la pregunta
 * @param {string} status - "answered" | "expired"
 * @param {string|null} via - "console" | "telegram" | null (origen de la respuesta)
 */
function resolveQuestion(id, status, via) {
    const data = loadQuestions();
    const q = data.questions.find(q => q.id === id);
    if (q) {
        q.status = status || "answered";
        q.answered_at = new Date().toISOString();
        if (via) q.answered_via = via;
        saveQuestions(data);
    }
}

/**
 * Obtener preguntas pendientes (no respondidas ni expiradas).
 * @returns {Array} preguntas pendientes
 */
function getPendingQuestions() {
    const data = loadQuestions();
    const cutoff = Date.now() - MAX_AGE_MS;
    return data.questions.filter(q =>
        q.status === "pending" &&
        new Date(q.timestamp).getTime() > cutoff
    );
}

/**
 * Obtener preguntas expiradas de las últimas 24h.
 * @returns {Array} preguntas expiradas
 */
function getExpiredQuestions() {
    const data = loadQuestions();
    const cutoff = Date.now() - MAX_AGE_MS;
    return data.questions.filter(q =>
        q.status === "expired" &&
        new Date(q.timestamp).getTime() > cutoff
    );
}

/**
 * Reintentar una pregunta expirada: cambia status a "retried" y retorna action_data.
 * @param {string} id - ID de la pregunta
 * @returns {object|null} action_data de la pregunta, o null si no se encontró/no era expired
 */
function retryQuestion(id) {
    const data = loadQuestions();
    const q = data.questions.find(q => q.id === id);
    if (!q || q.status !== "expired") return null;
    q.status = "retried";
    q.retried_at = new Date().toISOString();
    saveQuestions(data);
    return q.action_data || null;
}

/**
 * Obtener una pregunta por ID.
 * @param {string} id
 * @returns {object|null}
 */
function getQuestionById(id) {
    const data = loadQuestions();
    return data.questions.find(q => q.id === id) || null;
}

module.exports = {
    addPendingQuestion,
    resolveQuestion,
    getPendingQuestions,
    getExpiredQuestions,
    retryQuestion,
    getQuestionById,
    loadQuestions,
    saveQuestions
};
