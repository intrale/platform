package ui.sc.client

import ar.com.intrale.shared.client.RecommendedProductDTO
import ar.com.intrale.shared.client.RecommendedProductsResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ClientHomeRecommendedModelsTest {

    @Test
    fun `RecommendedProduct tiene valores por defecto correctos`() {
        val product = RecommendedProduct(
            id = "p1",
            name = "Test",
            priceLabel = "$100",
            emoji = "\uD83C\uDF54",
            unitPrice = 100.0
        )

        assertTrue(product.isAvailable)
        assertEquals(null, product.promotionPrice)
        assertEquals(null, product.reason)
    }

    @Test
    fun `RecommendedProductsState Loading es el estado inicial`() {
        val state: RecommendedProductsState = RecommendedProductsState.Loading
        assertTrue(state is RecommendedProductsState.Loading)
    }

    @Test
    fun `RecommendedProductsState Loaded contiene productos`() {
        val products = listOf(
            RecommendedProduct("1", "P1", "$10", "\uD83C\uDF54", 10.0),
            RecommendedProduct("2", "P2", "$20", "\uD83C\uDF55", 20.0)
        )
        val state = RecommendedProductsState.Loaded(products)

        assertEquals(2, state.products.size)
    }

    @Test
    fun `ClientHomeUiState incluye recommendedState en Loading por defecto`() {
        val uiState = ClientHomeUiState()

        assertTrue(uiState.recommendedState is RecommendedProductsState.Loading)
    }

    @Test
    fun `ClientHomeUiState puede copiar con recommendedState actualizado`() {
        val uiState = ClientHomeUiState()
        val updated = uiState.copy(recommendedState = RecommendedProductsState.Empty)

        assertTrue(updated.recommendedState is RecommendedProductsState.Empty)
    }

    @Test
    fun `RecommendedProductDTO serializa reason correctamente`() {
        val dto = RecommendedProductDTO(
            id = "p1",
            name = "Producto",
            basePrice = 100.0,
            reason = "Comprado frecuentemente"
        )

        assertEquals("Comprado frecuentemente", dto.reason)
    }

    @Test
    fun `RecommendedProduct con promocion tiene ambos precios`() {
        val product = RecommendedProduct(
            id = "p1",
            name = "Promo",
            priceLabel = "$200",
            emoji = "\uD83C\uDF54",
            unitPrice = 200.0,
            promotionPrice = 150.0
        )

        assertEquals(200.0, product.unitPrice)
        assertEquals(150.0, product.promotionPrice)
    }
}
