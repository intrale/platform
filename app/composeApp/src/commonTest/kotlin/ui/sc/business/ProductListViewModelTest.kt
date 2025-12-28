package ui.sc.business

import ext.business.ProductDTO
import ext.business.ProductStatus
import asdo.business.ToDoListProducts
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class FakeListProducts(
    private val result: Result<List<ProductDTO>>
) : ToDoListProducts {
    override suspend fun execute(businessId: String): Result<List<ProductDTO>> = result
}

class ProductListViewModelTest {

    @Test
    fun `estado missing cuando no hay negocio seleccionado`() = runBlocking {
        val viewModel = ProductListViewModel(FakeListProducts(Result.success(emptyList())))
        viewModel.loadProducts(null)
        assertEquals(ProductListStatus.MissingBusiness, viewModel.state.status)
    }

    @Test
    fun `carga exitosa popula items`() = runBlocking {
        val products = listOf(
            ProductDTO(
                id = "1",
                name = "Manzana",
                shortDescription = "Roja",
                basePrice = 10.0,
                unit = "kg",
                categoryId = "frutas",
                status = ProductStatus.Published
            )
        )
        val viewModel = ProductListViewModel(FakeListProducts(Result.success(products)))
        viewModel.loadProducts("biz-1")
        assertEquals(ProductListStatus.Loaded, viewModel.state.status)
        assertEquals(1, viewModel.state.items.size)
    }

    @Test
    fun `error al cargar cambia estado`() = runBlocking {
        val viewModel = ProductListViewModel(FakeListProducts(Result.failure(Exception("boom"))))
        viewModel.loadProducts("biz-1")
        assertEquals(ProductListStatus.Error, viewModel.state.status)
        assertTrue(viewModel.state.errorMessage?.isNotBlank() == true)
    }
}
