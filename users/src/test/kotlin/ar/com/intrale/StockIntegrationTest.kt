package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Tests de integracion para la logica de stock en el repositorio de productos.
 * Verifican el comportamiento de deduccion, alertas y filtrado.
 */
class StockIntegrationTest {

    private val repository = ProductRepository()

    private fun seedProduct(
        name: String,
        stockQuantity: Int? = null,
        minStock: Int? = null,
        status: String = "PUBLISHED",
        isAvailable: Boolean = true
    ): ProductRecord {
        return repository.saveProduct("test-business", ProductRecord(
            name = name,
            basePrice = 100.0,
            unit = "u",
            categoryId = "cat-1",
            status = status,
            isAvailable = isAvailable,
            stockQuantity = stockQuantity,
            minStock = minStock
        ))
    }

    // --- Deduccion batch ---

    @Test
    fun `deductStockBatch descuenta correctamente multiples productos`() {
        val p1 = seedProduct("Producto A", stockQuantity = 20)
        val p2 = seedProduct("Producto B", stockQuantity = 10)

        val result = repository.deductStockBatch("test-business", listOf(
            StockDeductionItem(p1.id, 5),
            StockDeductionItem(p2.id, 3)
        ))

        assertEquals(2, result.updatedProducts.size)
        assertEquals(15, result.updatedProducts.first { it.name == "Producto A" }.stockQuantity)
        assertEquals(7, result.updatedProducts.first { it.name == "Producto B" }.stockQuantity)
        assertTrue(result.errors.isEmpty())
    }

    @Test
    fun `deductStockBatch genera alertas cuando stock baja del minimo`() {
        val product = seedProduct("Producto critico", stockQuantity = 8, minStock = 5)

        val result = repository.deductStockBatch("test-business", listOf(
            StockDeductionItem(product.id, 5)
        ))

        assertEquals(1, result.lowStockAlerts.size)
        assertEquals(3, result.lowStockAlerts[0].stockQuantity)
    }

    @Test
    fun `deductStockBatch reporta error para productos inexistentes`() {
        val result = repository.deductStockBatch("test-business", listOf(
            StockDeductionItem("no-existe", 5)
        ))

        assertEquals(1, result.errors.size)
        assertTrue(result.errors[0].contains("no-existe"))
    }

    @Test
    fun `deductStockBatch marca producto como no disponible cuando llega a cero`() {
        val product = seedProduct("Ultimo stock", stockQuantity = 2)

        val result = repository.deductStockBatch("test-business", listOf(
            StockDeductionItem(product.id, 5)
        ))

        val updated = result.updatedProducts.first()
        assertEquals(0, updated.stockQuantity)
        assertFalse(updated.isAvailable)
    }

    // --- adjustStock ---

    @Test
    fun `adjustStock con delta positivo incrementa stock`() {
        val product = seedProduct("Producto", stockQuantity = 10)

        val updated = repository.adjustStock("test-business", product.id, 5)

        assertEquals(15, updated?.stockQuantity)
        assertTrue(updated?.isAvailable == true)
    }

    @Test
    fun `adjustStock con delta negativo decrementa stock`() {
        val product = seedProduct("Producto", stockQuantity = 10)

        val updated = repository.adjustStock("test-business", product.id, -3)

        assertEquals(7, updated?.stockQuantity)
    }

    @Test
    fun `adjustStock no baja de cero`() {
        val product = seedProduct("Producto", stockQuantity = 3)

        val updated = repository.adjustStock("test-business", product.id, -10)

        assertEquals(0, updated?.stockQuantity)
        assertFalse(updated?.isAvailable == true)
    }

    // --- setStock ---

    @Test
    fun `setStock establece valor absoluto`() {
        val product = seedProduct("Producto", stockQuantity = 10)

        val updated = repository.setStock("test-business", product.id, 42)

        assertEquals(42, updated?.stockQuantity)
        assertTrue(updated?.isAvailable == true)
    }

    @Test
    fun `setStock a cero marca como no disponible`() {
        val product = seedProduct("Producto", stockQuantity = 10)

        val updated = repository.setStock("test-business", product.id, 0)

        assertEquals(0, updated?.stockQuantity)
        assertFalse(updated?.isAvailable == true)
    }

    // --- Filtrado de productos publicados ---

    @Test
    fun `listPublishedProducts excluye productos con isAvailable false`() {
        seedProduct("Disponible", stockQuantity = 10, status = "PUBLISHED")
        seedProduct("Sin stock", stockQuantity = 0, status = "PUBLISHED", isAvailable = false)
        seedProduct("Borrador", stockQuantity = 50, status = "DRAFT")

        val published = repository.listPublishedProducts("test-business")

        assertEquals(1, published.size)
        assertEquals("Disponible", published[0].name)
    }

    @Test
    fun `listPublishedProductsPaginated excluye productos no disponibles`() {
        seedProduct("Disponible", stockQuantity = 10, status = "PUBLISHED")
        seedProduct("Sin stock", stockQuantity = 0, status = "PUBLISHED", isAvailable = false)

        val result = repository.listPublishedProductsPaginated("test-business")

        assertEquals(1, result.items.size)
        assertEquals("Disponible", result.items[0].name)
    }

    // --- Inventario ordenado ---

    @Test
    fun `listProductsByStock ordena por stock ascendente`() {
        seedProduct("Alto stock", stockQuantity = 100)
        seedProduct("Bajo stock", stockQuantity = 2)
        seedProduct("Medio stock", stockQuantity = 30)
        seedProduct("Sin gestion", stockQuantity = null)

        val inventory = repository.listProductsByStock("test-business")

        assertEquals(3, inventory.size) // excluye el null
        assertEquals("Bajo stock", inventory[0].name)
        assertEquals("Medio stock", inventory[1].name)
        assertEquals("Alto stock", inventory[2].name)
    }

    // --- Alertas de stock bajo ---

    @Test
    fun `listLowStockProducts retorna solo los que estan debajo del minimo`() {
        seedProduct("OK", stockQuantity = 50, minStock = 10)
        seedProduct("Justo en minimo", stockQuantity = 10, minStock = 10)
        seedProduct("Bajo minimo", stockQuantity = 3, minStock = 10)
        seedProduct("Sin minimo", stockQuantity = 2, minStock = null)

        val alerts = repository.listLowStockProducts("test-business")

        assertEquals(2, alerts.size)
        assertEquals("Bajo minimo", alerts[0].name)
        assertEquals("Justo en minimo", alerts[1].name)
    }
}
