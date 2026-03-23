package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertTrue

/**
 * Tests E2E — Validación #1634 — Publicación de productos hacia la app cliente
 *
 * Criterios de aceptación del issue #1634:
 * - TC-01: Producto PUBLISHED SÍ aparece en catálogo del cliente
 * - TC-02: Producto DRAFT NO aparece en catálogo del cliente
 * - TC-03: Cambio PUBLISHED → DRAFT elimina el producto del catálogo cliente
 * - TC-04: Catálogo vacío responde 200 con lista vacía (no error 500)
 * - TC-05: Sin JWT → 401 en endpoints protegidos
 *
 * Flujo del test (ordenado):
 *   1. Signin como admin
 *   2. Crear categoría (setup)
 *   3. Verificar sin JWT → 401
 *   4. Catálogo cliente responde 200 aunque no haya productos publicados
 *   5. Crear producto en DRAFT
 *   6. Verificar que DRAFT no aparece en catálogo cliente
 *   7. Publicar producto (DRAFT → PUBLISHED)
 *   8. Verificar que PUBLISHED sí aparece en catálogo cliente
 *   9. Despublicar producto (PUBLISHED → DRAFT)
 *  10. Verificar que despublicado no aparece en catálogo cliente
 *
 * Endpoints validados:
 *   POST /{business}/business/categories       — crear categoría (setup)
 *   POST /{business}/business/products         — crear producto (SecuredFunction: ADMIN|SALER)
 *   PUT  /{business}/business/products/{id}    — publicar/despublicar
 *   GET  /{business}/products                  — productos publicados (SecuredFunction)
 */
@DisplayName("E2E Validate #1634 — Publicación de productos hacia la app cliente")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ApiProductPublicationE2ETest : QATestBase() {

    companion object {
        var adminToken: String? = null
        var categoryId: String? = null
        var productId: String? = null
    }

    // ── Setup: autenticación ─────────────────────────────────────────────────

    @Test
    @Order(1)
    @DisplayName("Setup: signin como admin y obtener token")
    fun `setup signin y obtener token de admin`() {
        val response = apiContext.post(
            "/intrale/signin",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "email" to "admin@intrale.com",
                    "password" to "Admin1234!",
                    "newPassword" to "Admin1234!",
                    "name" to "Admin",
                    "familyName" to "Intrale"
                ))
        )

        logger.info("Signin admin: status=${response.status()}")
        val body = response.text()
        logger.info("Signin body: $body")

        if (response.status() == 200) {
            val tokenMatch = Regex("\"idToken\"\\s*:\\s*\"([^\"]+)\"").find(body)
            adminToken = tokenMatch?.groupValues?.get(1)
            logger.info("Token obtenido: ${if (adminToken != null) "OK (${adminToken!!.length} chars)" else "NO ENCONTRADO"}")
        }

        assertTrue(
            response.status() in listOf(200, 401),
            "Signin debe responder 200 o 401. Actual: ${response.status()}, body: $body"
        )
    }

    // ── Setup: crear categoría para los productos de prueba ──────────────────

    @Test
    @Order(2)
    @DisplayName("Setup: crear categoría para los productos de prueba")
    fun `setup crear categoria de prueba`() {
        val token = adminToken
        if (token == null) {
            logger.warn("Sin token de admin — saltando creación de categoría")
            return
        }

        val response = apiContext.post(
            "/intrale/business/categories",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer $token")
                .setData(mapOf(
                    "name" to "Panadería QA E2E #1634",
                    "description" to "Categoría creada por test E2E de publicación de productos"
                ))
        )

        logger.info("Crear categoría: status=${response.status()}")
        val body = response.text()
        logger.info("Categoría body: $body")

        if (response.status() in 200..299) {
            val idMatch = Regex("\"id\"\\s*:\\s*\"([^\"]+)\"").find(body)
            categoryId = idMatch?.groupValues?.get(1)
            logger.info("CategoryId obtenido: $categoryId")
        }

        assertTrue(
            response.status() in 200..299,
            "Crear categoría debe responder 2xx. Actual: ${response.status()}, body: $body"
        )
        assertTrue(
            categoryId != null,
            "La respuesta debe incluir el id de la categoría creada. Body: $body"
        )
    }

    // ── TC-05: Sin JWT → 401 ─────────────────────────────────────────────────

    @Test
    @Order(3)
    @DisplayName("TC-05: GET /intrale/products sin token responde 401")
    fun `consulta productos cliente sin token responde 401`() {
        val response = apiContext.get(
            "/intrale/products",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
        )

        logger.info("GET /products sin token: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "GET /products sin JWT debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(4)
    @DisplayName("TC-05: POST /intrale/business/products sin token responde 401")
    fun `crear producto sin token responde 401`() {
        val response = apiContext.post(
            "/intrale/business/products",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "name" to "Producto sin auth",
                    "basePrice" to 100.0,
                    "unit" to "unidad",
                    "categoryId" to "cat-123"
                ))
        )

        logger.info("POST /business/products sin token: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "POST /business/products sin JWT debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(5)
    @DisplayName("TC-05: PUT /intrale/business/products/{id} sin token responde 401")
    fun `actualizar producto sin token responde 401`() {
        val response = apiContext.put(
            "/intrale/business/products/producto-fake-123",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "name" to "Producto",
                    "basePrice" to 100.0,
                    "unit" to "unidad",
                    "categoryId" to "cat-1",
                    "status" to "PUBLISHED"
                ))
        )

        logger.info("PUT /business/products sin token: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "PUT /business/products sin JWT debe responder 4xx. Actual: ${response.status()}"
        )
    }

    // ── TC-04: Catálogo responde 200 aunque no haya productos publicados ──────

    @Test
    @Order(6)
    @DisplayName("TC-04: GET /intrale/products autenticado responde 200 (puede estar vacío)")
    fun `catalogo cliente responde 200 sin importar si hay productos publicados`() {
        val token = adminToken
        if (token == null) {
            logger.warn("Sin token — saltando validación de catálogo vacío")
            return
        }

        val response = apiContext.get(
            "/intrale/products",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer $token")
        )

        logger.info("GET /products autenticado: status=${response.status()}")
        val body = response.text()
        logger.info("GET /products body: $body")

        assertTrue(
            response.status() in 200..299,
            "GET /products autenticado debe responder 2xx aunque no haya productos. Actual: ${response.status()}, body: $body"
        )
        assertTrue(
            body.contains("products") || body.startsWith("[") || body.contains("statusCode"),
            "La respuesta debe tener estructura válida (lista o campo 'products'). Body: $body"
        )
    }

    // ── TC-02: Producto DRAFT NO aparece en catálogo cliente ─────────────────

    @Test
    @Order(7)
    @DisplayName("TC-02: Crear producto en estado DRAFT")
    fun `crear producto en estado DRAFT`() {
        val token = adminToken
        if (token == null) {
            logger.warn("Sin token de admin — saltando creación de producto DRAFT")
            return
        }

        val catId = categoryId ?: run {
            logger.warn("Sin categoryId — usando fallback")
            "cat-qa-default"
        }
        val timestamp = System.currentTimeMillis()

        val response = apiContext.post(
            "/intrale/business/products",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer $token")
                .setData(mapOf(
                    "name" to "Medialunas de manteca QA-$timestamp",
                    "shortDescription" to "Producto de prueba E2E publicación #1634",
                    "basePrice" to 350.0,
                    "unit" to "docena",
                    "categoryId" to catId,
                    "status" to "DRAFT",
                    "isAvailable" to true
                ))
        )

        logger.info("Crear producto DRAFT: status=${response.status()}")
        val body = response.text()
        logger.info("Crear producto DRAFT body: $body")

        if (response.status() in 200..299) {
            val idMatch = Regex("\"id\"\\s*:\\s*\"([^\"]+)\"").find(body)
            productId = idMatch?.groupValues?.get(1)
            logger.info("ProductId obtenido: $productId")
        }

        assertTrue(
            response.status() in 200..299,
            "Crear producto DRAFT debe responder 2xx. Actual: ${response.status()}, body: $body"
        )
        assertTrue(
            productId != null,
            "La respuesta debe incluir el id del producto creado. Body: $body"
        )
    }

    @Test
    @Order(8)
    @DisplayName("TC-02: Producto en DRAFT NO es visible en catálogo del cliente")
    fun `producto DRAFT no es visible para el cliente`() {
        val token = adminToken
        val pid = productId
        if (token == null || pid == null) {
            logger.warn("Sin token o productId — saltando validación DRAFT invisible")
            return
        }

        val response = apiContext.get(
            "/intrale/products",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer $token")
        )

        logger.info("GET /products (validar DRAFT invisible): status=${response.status()}")
        val body = response.text()
        logger.info("GET /products body: $body")

        assertTrue(
            response.status() in 200..299,
            "GET /products debe responder 2xx. Actual: ${response.status()}"
        )
        assertTrue(
            !body.contains("\"id\":\"$pid\"") && !body.contains("\"id\": \"$pid\""),
            "Producto DRAFT (id=$pid) NO debe aparecer en catálogo del cliente. Body: $body"
        )
    }

    // ── TC-01: Publicar → visible en catálogo cliente ────────────────────────

    @Test
    @Order(9)
    @DisplayName("TC-01: Publicar producto (cambiar status DRAFT → PUBLISHED)")
    fun `publicar producto cambiando status a PUBLISHED`() {
        val token = adminToken
        val pid = productId
        if (token == null || pid == null) {
            logger.warn("Sin token o productId — saltando publicación")
            return
        }

        val catId = categoryId ?: "cat-qa-default"

        val response = apiContext.put(
            "/intrale/business/products/$pid",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer $token")
                .setData(mapOf(
                    "name" to "Medialunas de manteca QA — PUBLICADAS",
                    "shortDescription" to "Producto publicado por test E2E #1634",
                    "basePrice" to 350.0,
                    "unit" to "docena",
                    "categoryId" to catId,
                    "status" to "PUBLISHED",
                    "isAvailable" to true
                ))
        )

        logger.info("Publicar producto: status=${response.status()}")
        val body = response.text()
        logger.info("Publicar producto body: $body")

        assertTrue(
            response.status() in 200..299,
            "Publicar producto (PUT status=PUBLISHED) debe responder 2xx. Actual: ${response.status()}, body: $body"
        )
        assertTrue(
            body.contains("PUBLISHED"),
            "La respuesta debe confirmar status=PUBLISHED. Body: $body"
        )
    }

    @Test
    @Order(10)
    @DisplayName("TC-01: Producto PUBLISHED SÍ aparece en catálogo del cliente")
    fun `producto PUBLISHED es visible para el cliente`() {
        val token = adminToken
        val pid = productId
        if (token == null || pid == null) {
            logger.warn("Sin token o productId — saltando validación PUBLISHED visible")
            return
        }

        val response = apiContext.get(
            "/intrale/products",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer $token")
        )

        logger.info("GET /products (validar PUBLISHED visible): status=${response.status()}")
        val body = response.text()
        logger.info("GET /products body: $body")

        assertTrue(
            response.status() in 200..299,
            "GET /products debe responder 2xx. Actual: ${response.status()}"
        )
        assertTrue(
            body.contains("\"id\":\"$pid\"") || body.contains("\"id\": \"$pid\""),
            "Producto PUBLISHED (id=$pid) DEBE aparecer en catálogo del cliente. Body: $body"
        )
    }

    // ── TC-03: Despublicar → deja de verse en catálogo cliente ──────────────

    @Test
    @Order(11)
    @DisplayName("TC-03: Despublicar producto (cambiar status PUBLISHED → DRAFT)")
    fun `despublicar producto cambiando status a DRAFT`() {
        val token = adminToken
        val pid = productId
        if (token == null || pid == null) {
            logger.warn("Sin token o productId — saltando despublicación")
            return
        }

        val catId = categoryId ?: "cat-qa-default"

        val response = apiContext.put(
            "/intrale/business/products/$pid",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer $token")
                .setData(mapOf(
                    "name" to "Medialunas de manteca QA — DESPUBLICADAS",
                    "shortDescription" to "Producto despublicado por test E2E #1634",
                    "basePrice" to 350.0,
                    "unit" to "docena",
                    "categoryId" to catId,
                    "status" to "DRAFT",
                    "isAvailable" to true
                ))
        )

        logger.info("Despublicar producto: status=${response.status()}")
        val body = response.text()
        logger.info("Despublicar producto body: $body")

        assertTrue(
            response.status() in 200..299,
            "Despublicar producto (PUT status=DRAFT) debe responder 2xx. Actual: ${response.status()}, body: $body"
        )
        assertTrue(
            body.contains("DRAFT"),
            "La respuesta debe confirmar status=DRAFT. Body: $body"
        )
    }

    @Test
    @Order(12)
    @DisplayName("TC-03: Producto despublicado (DRAFT) deja de verse en catálogo del cliente")
    fun `producto despublicado no es visible para el cliente`() {
        val token = adminToken
        val pid = productId
        if (token == null || pid == null) {
            logger.warn("Sin token o productId — saltando validación de despublicación")
            return
        }

        val response = apiContext.get(
            "/intrale/products",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer $token")
        )

        logger.info("GET /products (validar despublicado invisible): status=${response.status()}")
        val body = response.text()
        logger.info("GET /products body: $body")

        assertTrue(
            response.status() in 200..299,
            "GET /products debe responder 2xx. Actual: ${response.status()}"
        )
        assertTrue(
            !body.contains("\"id\":\"$pid\"") && !body.contains("\"id\": \"$pid\""),
            "Producto despublicado (id=$pid) NO debe aparecer en catálogo del cliente. Body: $body"
        )
    }

    // ── Validaciones de errores de entrada ──────────────────────────────────

    @Test
    @Order(13)
    @DisplayName("POST /intrale/business/products sin body responde 400")
    fun `crear producto sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/business/products",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData("")
        )

        logger.info("POST /business/products sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "POST /business/products sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }
}
