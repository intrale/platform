package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class LowRotationAnalyzerTest {

    private val productRepository = ProductRepository()
    private val orderRepository = ClientOrderRepository()
    private val analyzer = LowRotationAnalyzer(productRepository, orderRepository)

    @Test
    fun `detecta productos sin ventas como baja rotacion`() {
        // Producto publicado sin ninguna venta
        productRepository.saveProduct("panaderia", ProductRecord(
            name = "Pan lactal",
            basePrice = 2500.0,
            unit = "unidad",
            status = "PUBLISHED",
            categoryId = "pan"
        ))
        productRepository.saveProduct("panaderia", ProductRecord(
            name = "Medialunas",
            basePrice = 800.0,
            unit = "docena",
            status = "PUBLISHED",
            categoryId = "facturas"
        ))

        val result = analyzer.detectLowRotation("panaderia", thresholdDays = 7)

        assertEquals(2, result.size)
        assertTrue(result.any { it.productName == "Pan lactal" })
        assertTrue(result.any { it.productName == "Medialunas" })
        // Sin ventas -> daysSinceLastSale >= threshold * 2
        assertTrue(result.all { it.daysSinceLastSale >= 14 })
        assertTrue(result.all { it.totalSalesInPeriod == 0 })
    }

    @Test
    fun `no incluye productos en DRAFT`() {
        productRepository.saveProduct("panaderia", ProductRecord(
            name = "Producto borrador",
            basePrice = 1000.0,
            unit = "kg",
            status = "DRAFT",
            categoryId = "otros"
        ))

        val result = analyzer.detectLowRotation("panaderia", thresholdDays = 7)

        assertTrue(result.isEmpty())
    }

    @Test
    fun `retorna lista vacia cuando no hay productos`() {
        val result = analyzer.detectLowRotation("negocio-vacio", thresholdDays = 7)
        assertTrue(result.isEmpty())
    }

    @Test
    fun `ordena por dias sin venta descendente`() {
        productRepository.saveProduct("panaderia", ProductRecord(
            name = "Producto A",
            basePrice = 100.0,
            unit = "unidad",
            status = "PUBLISHED",
            categoryId = "cat1"
        ))
        productRepository.saveProduct("panaderia", ProductRecord(
            name = "Producto B",
            basePrice = 200.0,
            unit = "unidad",
            status = "PUBLISHED",
            categoryId = "cat1"
        ))

        val result = analyzer.detectLowRotation("panaderia", thresholdDays = 7)

        assertEquals(2, result.size)
        assertTrue(result[0].daysSinceLastSale >= result[1].daysSinceLastSale)
    }
}
