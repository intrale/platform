package asdo.client

import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.client.RecommendedProductDTO
import ar.com.intrale.shared.client.RecommendedProductsResponse
import ext.client.CommRecommendedProductsService
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class FakeRecommendedProductsService(
    private val result: Result<RecommendedProductsResponse> = Result.success(
        RecommendedProductsResponse(
            statusCode = StatusCodeDTO(200, "OK"),
            products = listOf(
                RecommendedProductDTO(
                    id = "prod-1",
                    name = "Producto Test",
                    basePrice = 150.0,
                    emoji = "\uD83C\uDF54",
                    isAvailable = true,
                    reason = "Comprado frecuentemente"
                )
            )
        )
    )
) : CommRecommendedProductsService {
    override suspend fun execute(businessId: String) = result
}

class DoGetRecommendedProductsTest {

    @Test
    fun `obtener recomendaciones exitoso retorna lista de productos`() = runTest {
        val sut = DoGetRecommendedProducts(FakeRecommendedProductsService())

        val result = sut.execute("test-business")

        assertTrue(result.isSuccess)
        assertEquals(1, result.getOrThrow().products.size)
        assertEquals("Producto Test", result.getOrThrow().products.first().name)
    }

    @Test
    fun `obtener recomendaciones con lista vacia retorna respuesta vacia`() = runTest {
        val emptyService = FakeRecommendedProductsService(
            result = Result.success(RecommendedProductsResponse(products = emptyList()))
        )
        val sut = DoGetRecommendedProducts(emptyService)

        val result = sut.execute("test-business")

        assertTrue(result.isSuccess)
        assertTrue(result.getOrThrow().products.isEmpty())
    }

    @Test
    fun `obtener recomendaciones con error retorna failure`() = runTest {
        val failingService = FakeRecommendedProductsService(
            result = Result.failure(RuntimeException("Network error"))
        )
        val sut = DoGetRecommendedProducts(failingService)

        val result = sut.execute("test-business")

        assertTrue(result.isFailure)
    }

    @Test
    fun `obtener recomendaciones incluye reason del producto`() = runTest {
        val sut = DoGetRecommendedProducts(FakeRecommendedProductsService())

        val result = sut.execute("test-business")

        assertEquals("Comprado frecuentemente", result.getOrThrow().products.first().reason)
    }

    @Test
    fun `obtener recomendaciones con multiples productos retorna todos`() = runTest {
        val multiService = FakeRecommendedProductsService(
            result = Result.success(
                RecommendedProductsResponse(
                    products = listOf(
                        RecommendedProductDTO(id = "p1", name = "Producto 1", basePrice = 100.0),
                        RecommendedProductDTO(id = "p2", name = "Producto 2", basePrice = 200.0),
                        RecommendedProductDTO(id = "p3", name = "Producto 3", basePrice = 300.0),
                        RecommendedProductDTO(id = "p4", name = "Producto 4", basePrice = 400.0)
                    )
                )
            )
        )
        val sut = DoGetRecommendedProducts(multiService)

        val result = sut.execute("test-business")

        assertTrue(result.isSuccess)
        assertEquals(4, result.getOrThrow().products.size)
    }
}
