package ui.sc.business

import asdo.business.ToGetBusinessProducts
import ext.dto.BusinessProductDTO
import ext.dto.BusinessProductsResponse
import ext.dto.StatusCodeDTO
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class BusinessProductsViewModelTest {

    @Test
    fun `loadProducts actualiza el estado con resultados`() = runTest {
        val viewModel = BusinessProductsViewModel(
            toGetBusinessProducts = FakeGetProducts()
        )

        viewModel.loadProducts("business-1")

        assertFalse(viewModel.state.isLoading)
        assertEquals(2, viewModel.state.products.size)
    }

    @Test
    fun `updateFilter solicita el estado indicado`() = runTest {
        val fake = FakeGetProducts()
        val viewModel = BusinessProductsViewModel(toGetBusinessProducts = fake)

        viewModel.updateFilter("business-1", BusinessProductsFilter.PUBLISHED)

        assertEquals(BusinessProductsFilter.PUBLISHED, viewModel.state.selectedFilter)
        assertEquals("PUBLISHED", fake.lastStatus)
    }

    @Test
    fun `errores se reflejan en el estado`() = runTest {
        val viewModel = BusinessProductsViewModel(
            toGetBusinessProducts = FakeGetProducts(Result.failure(Throwable("falló")))
        )

        viewModel.loadProducts("business-1")

        assertEquals("falló", viewModel.state.errorMessage)
        assertTrue(viewModel.state.products.isEmpty())
    }
}

private class FakeGetProducts(
    private val result: Result<BusinessProductsResponse> = Result.success(
        BusinessProductsResponse(
            statusCode = StatusCodeDTO(200, "OK"),
            products = listOf(
                BusinessProductDTO(id = "1", name = "Producto 1", basePrice = 10.0, status = "PUBLISHED", emoji = "🧀"),
                BusinessProductDTO(id = "2", name = "Producto 2", basePrice = 5.0, status = "DRAFT", emoji = "🍞")
            )
        )
    )
) : ToGetBusinessProducts {
    var lastStatus: String? = null
    override suspend fun execute(businessId: String, status: String): Result<BusinessProductsResponse> {
        lastStatus = status
        return result
    }
}
