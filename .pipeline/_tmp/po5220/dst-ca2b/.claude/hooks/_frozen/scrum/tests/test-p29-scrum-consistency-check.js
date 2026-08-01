// Test P-29: Auditoría de consistencia del backlog (#1373)
// Verifica que scrum-consistency-check.js:
//   - Detecta duplicaciones por fuzzy matching de títulos y objetivos
//   - Detecta historias parcialmente contenidas (70%+ criterios de AC)
//   - Calcula scores ponderados correctamente (40% título + 60% objetivo)
//   - Extrae criterios de aceptación de markdown
//   - Genera recomendaciones correctas según severidad
//   - Exporta módulo correctamente
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SCRIPT_PATH = path.join(__dirname, "..", "scrum-consistency-check.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeIssue(overrides = {}) {
    return Object.assign({
        number: 999,
        title: "Test issue",
        state: "OPEN",
        body: "",
        url: "https://github.com/intrale/platform/issues/999",
        labels: [],
        currentStatus: "Todo",
        updatedAt: new Date().toISOString()
    }, overrides);
}

// ─── Tests de estructura del módulo ──────────────────────────────────────────

describe("P-29: scrum-consistency-check — estructura del módulo", () => {

    it("archivo existe", () => {
        assert.ok(fs.existsSync(SCRIPT_PATH), "scrum-consistency-check.js debe existir");
    });

    it("módulo exporta funciones requeridas", () => {
        const mod = require(SCRIPT_PATH);
        assert.ok(typeof mod.runConsistencyCheck === "function", "debe exportar runConsistencyCheck");
        assert.ok(typeof mod.detectDuplicates === "function", "debe exportar detectDuplicates");
        assert.ok(typeof mod.detectContainedStories === "function", "debe exportar detectContainedStories");
        assert.ok(typeof mod.computeSimilarity === "function", "debe exportar computeSimilarity");
        assert.ok(typeof mod.extractAcceptanceCriteria === "function", "debe exportar extractAcceptanceCriteria");
        assert.ok(typeof mod.jaccardSimilarity === "function", "debe exportar jaccardSimilarity");
        assert.ok(typeof mod.tokenize === "function", "debe exportar tokenize");
        assert.ok(typeof mod.generateRecommendations === "function", "debe exportar generateRecommendations");
    });

    it("exporta umbrales correctos", () => {
        const mod = require(SCRIPT_PATH);
        assert.ok(typeof mod.DUPLICATE_THRESHOLD === "number", "debe exportar DUPLICATE_THRESHOLD como número");
        assert.ok(typeof mod.CONTAINED_THRESHOLD === "number", "debe exportar CONTAINED_THRESHOLD como número");
        assert.ok(mod.DUPLICATE_THRESHOLD >= 0 && mod.DUPLICATE_THRESHOLD <= 1,
            "DUPLICATE_THRESHOLD debe estar entre 0 y 1");
        assert.ok(mod.CONTAINED_THRESHOLD >= 0.5 && mod.CONTAINED_THRESHOLD <= 1,
            "CONTAINED_THRESHOLD debe ser al menos 0.5");
    });

});

// ─── Tests de tokenización ────────────────────────────────────────────────────

describe("P-29: tokenize — eliminación de stopwords y normalización", () => {

    it("tokeniza texto básico correctamente", () => {
        const { tokenize } = require(SCRIPT_PATH);
        const tokens = tokenize("implementar sistema de login para usuarios");
        assert.ok(tokens instanceof Set, "debe retornar un Set");
        assert.ok(tokens.has("implementar"), "debe incluir 'implementar'");
        assert.ok(tokens.has("sistema"), "debe incluir 'sistema'");
        assert.ok(tokens.has("login"), "debe incluir 'login'");
        assert.ok(tokens.has("usuarios"), "debe incluir 'usuarios'");
        // Stopwords eliminadas
        assert.ok(!tokens.has("de"), "debe eliminar 'de' (stopword)");
        assert.ok(!tokens.has("para"), "debe eliminar 'para' (stopword)");
    });

    it("convierte a minúsculas", () => {
        const { tokenize } = require(SCRIPT_PATH);
        const tokens = tokenize("Login SISTEMA Backend");
        assert.ok(tokens.has("login"), "debe convertir a minúsculas");
        assert.ok(tokens.has("sistema"), "debe convertir a minúsculas");
        assert.ok(tokens.has("backend"), "debe convertir a minúsculas");
    });

    it("retorna Set vacío para texto vacío", () => {
        const { tokenize } = require(SCRIPT_PATH);
        const tokens = tokenize("");
        assert.ok(tokens instanceof Set, "debe retornar Set");
        assert.strictEqual(tokens.size, 0, "debe estar vacío para texto vacío");
    });

    it("retorna Set vacío para null/undefined", () => {
        const { tokenize } = require(SCRIPT_PATH);
        const tokens = tokenize(null);
        assert.ok(tokens instanceof Set);
        assert.strictEqual(tokens.size, 0);
    });

    it("filtra tokens muy cortos (≤ 2 chars)", () => {
        const { tokenize } = require(SCRIPT_PATH);
        const tokens = tokenize("ui ux app login sistema");
        assert.ok(!tokens.has("ui"), "debe filtrar tokens de 2 chars o menos");
        assert.ok(!tokens.has("ux"), "debe filtrar tokens de 2 chars o menos");
        assert.ok(tokens.has("app"), "debe incluir tokens de 3 chars");
        assert.ok(tokens.has("login"), "debe incluir tokens normales");
    });
});

// ─── Tests de similaridad Jaccard ────────────────────────────────────────────

describe("P-29: jaccardSimilarity — cálculo correcto", () => {

    it("similaridad de sets idénticos es 1.0", () => {
        const { jaccardSimilarity } = require(SCRIPT_PATH);
        const a = new Set(["login", "usuario", "sistema"]);
        const b = new Set(["login", "usuario", "sistema"]);
        assert.strictEqual(jaccardSimilarity(a, b), 1.0);
    });

    it("similaridad de sets sin intersección es 0.0", () => {
        const { jaccardSimilarity } = require(SCRIPT_PATH);
        const a = new Set(["login", "usuario"]);
        const b = new Set(["delivery", "repartidor"]);
        assert.strictEqual(jaccardSimilarity(a, b), 0.0);
    });

    it("similaridad de sets vacíos es 0", () => {
        const { jaccardSimilarity } = require(SCRIPT_PATH);
        assert.strictEqual(jaccardSimilarity(new Set(), new Set()), 0);
    });

    it("calcula similaridad parcial correctamente", () => {
        const { jaccardSimilarity } = require(SCRIPT_PATH);
        // Intersección: {b, c}, Unión: {a, b, c, d}  → 2/4 = 0.5
        const a = new Set(["alpha", "beta", "gamma"]);
        const b = new Set(["beta", "gamma", "delta"]);
        const sim = jaccardSimilarity(a, b);
        // intersección = {beta, gamma} = 2, unión = {alpha, beta, gamma, delta} = 4 → 0.5
        assert.strictEqual(sim, 0.5);
    });

});

// ─── Tests de detección de duplicaciones ─────────────────────────────────────

describe("P-29: detectDuplicates — detección correcta", () => {

    it("detecta duplicación con títulos muy similares", () => {
        const { detectDuplicates } = require(SCRIPT_PATH);
        const issues = [
            makeIssue({
                number: 100,
                title: "feat(auth): implementar login con JWT para usuarios del sistema",
                body: "Implementar sistema de autenticación con JWT. Permitir login de usuarios registrados."
            }),
            makeIssue({
                number: 101,
                title: "feat(auth): sistema de login JWT para autenticación de usuarios",
                body: "Crear sistema de autenticación JWT. Implementar login para usuarios del sistema."
            })
        ];

        const duplicates = detectDuplicates(issues);
        assert.ok(duplicates.length > 0, "debe detectar al menos una duplicación");
        const dup = duplicates[0];
        assert.ok(dup.scores.composite >= 0.50, `score compuesto debe ser ≥ 0.50, fue ${dup.scores.composite}`);
        assert.ok(dup.issueA && dup.issueB, "debe tener issueA e issueB");
        assert.ok(dup.severity, "debe tener campo severity");
        assert.ok(dup.recommendation, "debe tener recomendación");
    });

    it("no detecta duplicación en issues claramente distintos", () => {
        const { detectDuplicates } = require(SCRIPT_PATH);
        const issues = [
            makeIssue({
                number: 200,
                title: "feat(delivery): tracking de repartos en tiempo real",
                body: "Implementar sistema de tracking GPS para repartidores. Mostrar ubicación en mapa."
            }),
            makeIssue({
                number: 201,
                title: "fix(auth): corregir validación de token expirado",
                body: "El token JWT no valida correctamente la expiración. Agregar verificación de exp claim."
            })
        ];

        const duplicates = detectDuplicates(issues);
        assert.strictEqual(duplicates.length, 0, "no debe detectar duplicación en issues distintos");
    });

    it("ordena duplicaciones por score descendente", () => {
        const { detectDuplicates } = require(SCRIPT_PATH);
        const issues = [
            makeIssue({ number: 1, title: "feat: implementar login de usuarios con JWT", body: "Sistema de login JWT para usuarios autenticados del sistema web." }),
            makeIssue({ number: 2, title: "feat: sistema de login JWT para usuarios web", body: "Implementar login usuarios JWT sistema autenticación." }),
            makeIssue({ number: 3, title: "feat: recuperación de contraseña vía email", body: "Enviar código de recuperación al email del usuario registrado." }),
            makeIssue({ number: 4, title: "feat: recuperar contraseña por correo electrónico usuario", body: "Código de recuperación enviado al email del usuario." })
        ];

        const duplicates = detectDuplicates(issues);
        assert.ok(duplicates.length >= 1, "debe detectar al menos una duplicación");
        // Verificar orden descendente
        for (let i = 1; i < duplicates.length; i++) {
            assert.ok(
                duplicates[i - 1].scores.composite >= duplicates[i].scores.composite,
                "duplicaciones deben estar ordenadas por score descendente"
            );
        }
    });

    it("retorna array vacío con lista de 0 issues", () => {
        const { detectDuplicates } = require(SCRIPT_PATH);
        assert.deepStrictEqual(detectDuplicates([]), []);
    });

    it("retorna array vacío con lista de 1 issue", () => {
        const { detectDuplicates } = require(SCRIPT_PATH);
        assert.deepStrictEqual(detectDuplicates([makeIssue()]), []);
    });

    it("score compuesto es 40% título + 60% objetivo", () => {
        const { computeSimilarity } = require(SCRIPT_PATH);
        const a = makeIssue({ title: "login sistema", body: "implementar autenticación usuarios registro backend" });
        const b = makeIssue({ title: "registro usuarios", body: "implementar autenticación usuarios registro backend" });
        const scores = computeSimilarity(a, b);
        // Objetivo idéntico → objScore ≈ 1.0
        // Score compuesto = 0.4 * titleScore + 0.6 * 1.0
        assert.ok(scores.objectiveScore >= 0.7, `objectiveScore debería ser alto para objetivos similares: ${scores.objectiveScore}`);
        assert.ok(scores.composite >= 0.6, `composite debería reflejar objective alto: ${scores.composite}`);
    });

});

// ─── Tests de extracción de criterios de aceptación ──────────────────────────

describe("P-29: extractAcceptanceCriteria — extracción de checkboxes", () => {

    it("extrae criterios en formato - [ ] criterio", () => {
        const { extractAcceptanceCriteria } = require(SCRIPT_PATH);
        const body = `
## Criterios de aceptación
- [ ] Script de auditoría implementado y testeable
- [ ] Detección de duplicaciones funcionando
- [ ] Reporte JSON generado correctamente
`;
        const criteria = extractAcceptanceCriteria(body);
        assert.ok(criteria.length >= 3, `debe extraer al menos 3 criterios, encontró: ${criteria.length}`);
        assert.ok(criteria.some(c => c.includes("auditor")), "debe incluir criterio de auditoría");
        assert.ok(criteria.some(c => c.includes("duplicaci")), "debe incluir criterio de duplicaciones");
    });

    it("extrae criterios marcados como completados - [x]", () => {
        const { extractAcceptanceCriteria } = require(SCRIPT_PATH);
        const body = `
## Criterios de aceptación
- [x] Login implementado
- [ ] Logout implementado
- [X] Token JWT validado
`;
        const criteria = extractAcceptanceCriteria(body);
        assert.ok(criteria.length >= 3, "debe extraer criterios marcados y no marcados");
    });

    it("extrae criterios fuera de sección de criterios también", () => {
        const { extractAcceptanceCriteria } = require(SCRIPT_PATH);
        const body = `
## Descripción
Implementar funcionalidad.

- [ ] Criterio importante aquí
- [ ] Otro criterio relevante
`;
        const criteria = extractAcceptanceCriteria(body);
        assert.ok(criteria.length >= 2, "debe extraer criterios aunque no estén en sección nombrada");
    });

    it("retorna array vacío para body sin checkboxes", () => {
        const { extractAcceptanceCriteria } = require(SCRIPT_PATH);
        const body = `## Descripción\nImplementar login.\n## Notas\nUsar JWT.`;
        const criteria = extractAcceptanceCriteria(body);
        assert.ok(Array.isArray(criteria), "debe retornar array");
        assert.strictEqual(criteria.length, 0, "debe estar vacío si no hay checkboxes");
    });

    it("retorna array vacío para body nulo o vacío", () => {
        const { extractAcceptanceCriteria } = require(SCRIPT_PATH);
        assert.deepStrictEqual(extractAcceptanceCriteria(null), []);
        assert.deepStrictEqual(extractAcceptanceCriteria(""), []);
    });

});

// ─── Tests de detección de historias contenidas ───────────────────────────────

describe("P-29: detectContainedStories — análisis de criterios de aceptación", () => {

    it("detecta historia A contenida en B cuando 70%+ criterios de A están en B", () => {
        const { detectContainedStories } = require(SCRIPT_PATH);
        const bodyA = `
## Criterios de aceptación
- [ ] Script ejecutable desde CLI
- [ ] Genera reporte JSON con resultados
- [ ] Detecta duplicaciones por fuzzy match
`;
        const bodyB = `
## Criterios de aceptación
- [ ] Script de auditoría ejecutable desde CLI con flags
- [ ] Genera reporte JSON con resultados y recomendaciones
- [ ] Detecta duplicaciones por fuzzy match en títulos
- [ ] Notificación Telegram al detectar duplicados
- [ ] Tests unitarios cubren casos de prueba
`;
        const issues = [
            makeIssue({ number: 300, title: "Script auditoría básico", body: bodyA }),
            makeIssue({ number: 301, title: "Script auditoría avanzado con todas las features", body: bodyB })
        ];

        const contained = detectContainedStories(issues);
        assert.ok(contained.length > 0, "debe detectar contención cuando A está en B");
        const cont = contained[0];
        assert.strictEqual(cont.contained.number, 300, "issue A (con menos criterios) debe ser el contenido");
        assert.strictEqual(cont.container.number, 301, "issue B (con más criterios) debe ser el contenedor");
        assert.ok(cont.containmentRatio >= 70, `ratio debe ser ≥ 70%, fue ${cont.containmentRatio}%`);
    });

    it("no detecta contención cuando menos del 70% de criterios coinciden", () => {
        const { detectContainedStories } = require(SCRIPT_PATH);
        const bodyA = `
## Criterios de aceptación
- [ ] Criterio único de A número uno
- [ ] Criterio completamente diferente dos
- [ ] Criterio muy distinto tres
`;
        const bodyB = `
## Criterios de aceptación
- [ ] Solo un criterio de A coincide aquí
- [ ] Resto son criterios distintos de B
- [ ] Funcionalidad separada de B
- [ ] Otro aspecto diferente
`;
        const issues = [
            makeIssue({ number: 400, title: "Historia A distinta", body: bodyA }),
            makeIssue({ number: 401, title: "Historia B diferente", body: bodyB })
        ];

        // Forzar que se detecte poca coincidencia
        const contained = detectContainedStories(issues);
        // No debería detectar contención alta
        const highContainment = contained.filter(c => c.containmentRatio >= 70);
        assert.strictEqual(highContainment.length, 0, "no debe detectar contención alta cuando los criterios son distintos");
    });

    it("retorna array vacío si ningún issue tiene criterios", () => {
        const { detectContainedStories } = require(SCRIPT_PATH);
        const issues = [
            makeIssue({ number: 500, title: "Sin criterios", body: "Solo descripción sin checkboxes." }),
            makeIssue({ number: 501, title: "Tampoco tiene criterios", body: "También sin checkboxes." })
        ];
        const contained = detectContainedStories(issues);
        assert.strictEqual(contained.length, 0, "debe retornar vacío si no hay criterios de AC");
    });

    it("ordena resultados por containmentRatio descendente", () => {
        const { detectContainedStories } = require(SCRIPT_PATH);
        const issues = [
            makeIssue({
                number: 600,
                title: "Historia pequeña con pocos criterios",
                body: "## Criterios de aceptación\n- [ ] login funciona\n- [ ] logout funciona"
            }),
            makeIssue({
                number: 601,
                title: "Historia grande con todos los criterios",
                body: "## Criterios de aceptación\n- [ ] login funciona correctamente\n- [ ] logout funciona bien\n- [ ] token jwt validado\n- [ ] refresh token implementado"
            })
        ];
        const contained = detectContainedStories(issues);
        for (let i = 1; i < contained.length; i++) {
            assert.ok(
                contained[i - 1].containmentRatio >= contained[i].containmentRatio,
                "debe estar ordenado por containmentRatio descendente"
            );
        }
    });

});

// ─── Tests de generación de recomendaciones ───────────────────────────────────

describe("P-29: generateRecommendations — tipos correctos de acción", () => {

    it("genera recomendación tipo 'merge' para duplicaciones de alta severidad", () => {
        const { generateRecommendations } = require(SCRIPT_PATH);
        const duplicates = [{
            issueA: { number: 100, title: "feat: login JWT", url: "#100", status: "Todo" },
            issueB: { number: 101, title: "feat: autenticación JWT", url: "#101", status: "Todo" },
            scores: { composite: 0.80, titleScore: 0.75, objectiveScore: 0.83 },
            severity: "high",
            recommendation: "Duplicación probable"
        }];
        const recs = generateRecommendations(duplicates, []);
        assert.ok(recs.length > 0, "debe generar recomendación");
        assert.strictEqual(recs[0].type, "merge", "alta severidad debe generar tipo 'merge'");
        assert.strictEqual(recs[0].priority, "high", "debe ser prioridad high");
    });

    it("genera recomendación tipo 'review' para duplicaciones de media severidad", () => {
        const { generateRecommendations } = require(SCRIPT_PATH);
        const duplicates = [{
            issueA: { number: 200, title: "feat: gestión de usuarios", url: "#200", status: "Todo" },
            issueB: { number: 201, title: "feat: administración de usuarios", url: "#201", status: "Todo" },
            scores: { composite: 0.63, titleScore: 0.55, objectiveScore: 0.68 },
            severity: "medium",
            recommendation: "Historias similares"
        }];
        const recs = generateRecommendations(duplicates, []);
        assert.ok(recs.length > 0, "debe generar recomendación");
        assert.strictEqual(recs[0].type, "review", "media severidad debe generar tipo 'review'");
        assert.strictEqual(recs[0].priority, "medium", "debe ser prioridad medium");
    });

    it("genera recomendación tipo 'absorb' para historias contenidas", () => {
        const { generateRecommendations } = require(SCRIPT_PATH);
        const contained = [{
            contained: { number: 300, title: "Historia A pequeña", url: "#300", status: "Todo", criteriaCount: 3 },
            container: { number: 301, title: "Historia B completa", url: "#301", status: "Todo", criteriaCount: 6 },
            containmentRatio: 85,
            matchedCriteria: 3,
            recommendation: "Historia casi completamente contenida"
        }];
        const recs = generateRecommendations([], contained);
        assert.ok(recs.length > 0, "debe generar recomendación");
        assert.strictEqual(recs[0].type, "absorb", "contención alta debe generar tipo 'absorb'");
    });

    it("no genera duplicados para el mismo par de issues", () => {
        const { generateRecommendations } = require(SCRIPT_PATH);
        const duplicates = [{
            issueA: { number: 400, title: "Historia A", url: "#400", status: "Todo" },
            issueB: { number: 401, title: "Historia B", url: "#401", status: "Todo" },
            scores: { composite: 0.70, titleScore: 0.65, objectiveScore: 0.73 },
            severity: "medium",
            recommendation: "Similares"
        }];
        const contained = [{
            contained: { number: 400, title: "Historia A", url: "#400", status: "Todo", criteriaCount: 3 },
            container: { number: 401, title: "Historia B", url: "#401", status: "Todo", criteriaCount: 5 },
            containmentRatio: 80,
            matchedCriteria: 3,
            recommendation: "Contenida"
        }];
        const recs = generateRecommendations(duplicates, contained);
        // No debe tener el par 400-401 duplicado
        const pairs = recs.map(r => r.issues.slice().sort().join("-"));
        const uniquePairs = new Set(pairs);
        assert.strictEqual(pairs.length, uniquePairs.size, "no debe haber recomendaciones duplicadas para el mismo par");
    });

    it("retorna array vacío si no hay duplicaciones ni contenciones", () => {
        const { generateRecommendations } = require(SCRIPT_PATH);
        const recs = generateRecommendations([], []);
        assert.deepStrictEqual(recs, []);
    });

});
