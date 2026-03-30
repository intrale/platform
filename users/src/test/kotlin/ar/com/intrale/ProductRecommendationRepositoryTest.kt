package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ProductRecommendationRepositoryTest {

    private val orderRepository = ClientOrderRepository()
    private val productRepository = ProductRepository()
    private val repository = ProductRecommendationRepository(orderRepository, productRepository)

    private fun seedProduct(
        business: String = "tienda",
        name: String,
        status: String = "PUBLISHED",
        basePrice: Double = 100.0,
        isAvailable: Boolean = true,
        stockQuantity: Int? = null
    ): ProductRecord {
        return productRepository.saveProduct(
            business,
            ProductRecord(
                name = name,
                basePrice = basePrice,
                unit = "u",
                categoryId = "cat-1",
                status = status,
                isAvailable = isAvailable,
                stockQuantity = stockQuantity
            )
        )
    }

    private fun createOrder(
        business: String = "tienda",
        email: String,
        productIds: List<String>,
        status: String = "DELIVERED"
    ) {
        val items = productIds.map { pid ->
            ClientOrderItemPayload(
                productId = pid,
                productName = "Producto $pid",
                name = "Producto $pid",
                quantity = 1,
                unitPrice = 100.0,
                subtotal = 100.0
            )
        }
        val payload = ClientOrderPayload(
            status = status,
            items = items,
            total = items.sumOf { it.subtotal },
            businessName = business
        )
        orderRepository.createOrder(business, email, payload)
    }

    @Test
    fun `usuario sin historial recibe productos mas vendidos`() {
        val p1 = seedProduct(name = "Producto A")
        val p2 = seedProduct(name = "Producto B")
        val p3 = seedProduct(name = "Producto C")
        val p4 = seedProduct(name = "Producto D")

        // Otros usuarios compraron estos productos
        createOrder(email = "otro@test.com", productIds = listOf(p1.id, p2.id))
        createOrder(email = "otro2@test.com", productIds = listOf(p1.id, p3.id))
        createOrder(email = "otro3@test.com", productIds = listOf(p1.id, p4.id))

        val recommendations = repository.getRecommendations("tienda", "nuevo@test.com")

        assertTrue(recommendations.isNotEmpty(), "Debe devolver recomendaciones para usuario nuevo")
        assertTrue(recommendations.size >= 4 || recommendations.size == productRepository.listPublishedProducts("tienda").size)
        // Producto A es el mas vendido (3 ordenes)
        assertEquals(p1.id, recommendations.first().id, "El mas vendido debe ser el primero")
    }

    @Test
    fun `usuario con historial recibe recomendaciones por co-ocurrencia`() {
        val pA = seedProduct(name = "Producto A")
        val pB = seedProduct(name = "Producto B")
        val pC = seedProduct(name = "Producto C")
        val pD = seedProduct(name = "Producto D")
        val pE = seedProduct(name = "Producto E")

        // El usuario compro A y B
        createOrder(email = "user@test.com", productIds = listOf(pA.id, pB.id))

        // Otros usuarios que compraron A tambien compraron C y D
        createOrder(email = "otro1@test.com", productIds = listOf(pA.id, pC.id, pD.id))
        createOrder(email = "otro2@test.com", productIds = listOf(pA.id, pC.id))
        // Otros que compraron B tambien compraron D y E
        createOrder(email = "otro3@test.com", productIds = listOf(pB.id, pD.id, pE.id))

        val recommendations = repository.getRecommendations("tienda", "user@test.com")

        // No debe incluir A ni B (ya los compro)
        val ids = recommendations.map { it.id }
        assertFalse(ids.contains(pA.id), "No debe recomendar productos ya comprados")
        assertFalse(ids.contains(pB.id), "No debe recomendar productos ya comprados")
        // C fue co-ocurrente en 2 ordenes, D en 2, E en 1 -> C y D primero
        assertTrue(ids.contains(pC.id), "Debe recomendar C (co-ocurrente)")
        assertTrue(ids.contains(pD.id), "Debe recomendar D (co-ocurrente)")
    }

    @Test
    fun `no recomienda productos sin stock`() {
        val pConStock = seedProduct(name = "Con stock", stockQuantity = 10)
        val pSinStock = seedProduct(name = "Sin stock", stockQuantity = 0)
        val pStockNull = seedProduct(name = "Stock ilimitado", stockQuantity = null)

        createOrder(email = "otro@test.com", productIds = listOf(pConStock.id, pSinStock.id, pStockNull.id))

        val recommendations = repository.getRecommendations("tienda", "nuevo@test.com")
        val ids = recommendations.map { it.id }

        assertTrue(ids.contains(pConStock.id), "Debe incluir producto con stock")
        assertFalse(ids.contains(pSinStock.id), "No debe incluir producto sin stock")
        assertTrue(ids.contains(pStockNull.id), "Debe incluir producto con stock ilimitado (null)")
    }

    @Test
    fun `no recomienda productos no publicados`() {
        val pPublished = seedProduct(name = "Publicado", status = "PUBLISHED")
        val pDraft = seedProduct(name = "Borrador", status = "DRAFT")

        createOrder(email = "otro@test.com", productIds = listOf(pPublished.id, pDraft.id))

        val recommendations = repository.getRecommendations("tienda", "nuevo@test.com")
        val ids = recommendations.map { it.id }

        assertTrue(ids.contains(pPublished.id), "Debe incluir producto publicado")
        assertFalse(ids.contains(pDraft.id), "No debe incluir producto en borrador")
    }

    @Test
    fun `no recomienda productos no disponibles`() {
        val pDisponible = seedProduct(name = "Disponible", isAvailable = true)
        val pNoDisponible = seedProduct(name = "No disponible", isAvailable = false)

        createOrder(email = "otro@test.com", productIds = listOf(pDisponible.id, pNoDisponible.id))

        val recommendations = repository.getRecommendations("tienda", "nuevo@test.com")
        val ids = recommendations.map { it.id }

        assertTrue(ids.contains(pDisponible.id))
        assertFalse(ids.contains(pNoDisponible.id))
    }

    @Test
    fun `ordenes canceladas se excluyen del calculo`() {
        val pA = seedProduct(name = "Producto A")
        val pB = seedProduct(name = "Producto B")

        // Solo ordenes canceladas
        createOrder(email = "otro@test.com", productIds = listOf(pA.id, pB.id), status = "CANCELLED")

        val recommendations = repository.getRecommendations("tienda", "nuevo@test.com")

        assertTrue(recommendations.isEmpty(), "No debe haber recomendaciones basadas en ordenes canceladas")
    }

    @Test
    fun `respeta el limite de resultados`() {
        for (i in 1..10) {
            val p = seedProduct(name = "Producto $i")
            createOrder(email = "otro@test.com", productIds = listOf(p.id))
        }

        val recommendations = repository.getRecommendations("tienda", "nuevo@test.com", limit = 3)

        assertEquals(3, recommendations.size, "Debe respetar el limite")
    }

    @Test
    fun `hasUserHistory retorna true para usuario con ordenes no canceladas`() {
        val p = seedProduct(name = "Producto")
        createOrder(email = "user@test.com", productIds = listOf(p.id), status = "DELIVERED")

        assertTrue(repository.hasUserHistory("tienda", "user@test.com"))
    }

    @Test
    fun `hasUserHistory retorna false para usuario sin ordenes`() {
        assertFalse(repository.hasUserHistory("tienda", "nuevo@test.com"))
    }

    @Test
    fun `hasUserHistory retorna false si solo tiene ordenes canceladas`() {
        val p = seedProduct(name = "Producto")
        createOrder(email = "user@test.com", productIds = listOf(p.id), status = "CANCELLED")

        assertFalse(repository.hasUserHistory("tienda", "user@test.com"))
    }

    @Test
    fun `recomendaciones son solo del negocio solicitado`() {
        val pTienda = seedProduct(business = "tienda", name = "Prod tienda")
        val pOtro = seedProduct(business = "otro-negocio", name = "Prod otro")

        createOrder(business = "tienda", email = "otro@test.com", productIds = listOf(pTienda.id))
        createOrder(business = "otro-negocio", email = "otro@test.com", productIds = listOf(pOtro.id))

        val recommendations = repository.getRecommendations("tienda", "nuevo@test.com")
        val ids = recommendations.map { it.id }

        assertTrue(ids.contains(pTienda.id))
        assertFalse(ids.contains(pOtro.id), "No debe recomendar productos de otro negocio")
    }

    @Test
    fun `complementa con mas vendidos cuando co-ocurrencia es insuficiente`() {
        // Solo 2 productos por co-ocurrencia, pero MIN_RESULTS es 4
        val pA = seedProduct(name = "Producto A")
        val pB = seedProduct(name = "Producto B")
        val pC = seedProduct(name = "Producto C")
        val pD = seedProduct(name = "Producto D")
        val pE = seedProduct(name = "Producto E")
        val pF = seedProduct(name = "Producto F")

        // Usuario compro A
        createOrder(email = "user@test.com", productIds = listOf(pA.id))
        // Un solo otro usuario compro A y B
        createOrder(email = "otro@test.com", productIds = listOf(pA.id, pB.id))
        // Productos populares para fallback
        createOrder(email = "x1@test.com", productIds = listOf(pC.id, pD.id))
        createOrder(email = "x2@test.com", productIds = listOf(pC.id, pE.id))
        createOrder(email = "x3@test.com", productIds = listOf(pC.id, pF.id))

        val recommendations = repository.getRecommendations("tienda", "user@test.com", limit = 6)

        // B viene por co-ocurrencia, el resto por mas vendidos
        val ids = recommendations.map { it.id }
        assertTrue(ids.contains(pB.id), "B debe estar por co-ocurrencia")
        assertTrue(recommendations.size >= ProductRecommendationRepository.MIN_RESULTS,
            "Debe tener al menos ${ProductRecommendationRepository.MIN_RESULTS} resultados")
    }
}
