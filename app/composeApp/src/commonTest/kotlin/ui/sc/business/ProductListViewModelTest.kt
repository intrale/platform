package ui.sc.business

import ext.business.ProductDTO
import ext.business.ProductStatus
import asdo.business.ToDoListProducts
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class FakeListProducts(
    private val result: Result<List<ProductDTO>>
) : ToDoListProducts {
    override suspend fun execute(businessId: String): Result<List<ProductDTO>> = result
}

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

class ProductListViewModelTest {

    @Test
    fun `estado missing cuando no hay negocio seleccionado`() = runTest {
        val viewModel = ProductListViewModel(
            FakeListProducts(Result.success(emptyList())),
            loggerFactory = testLoggerFactory
        )
        viewModel.loadProducts(null)
        assertEquals(ProductListStatus.MissingBusiness, viewModel.state.status)
    }

    @Test
    fun `carga exitosa popula items`() = runTest {
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
        val viewModel = ProductListViewModel(
            FakeListProducts(Result.success(products)),
            loggerFactory = testLoggerFactory
        )
        viewModel.loadProducts("biz-1")
        assertEquals(ProductListStatus.Loaded, viewModel.state.status)
        assertEquals(1, viewModel.state.items.size)
    }

    @Test
    fun `error al cargar cambia estado`() = runTest {
        val viewModel = ProductListViewModel(
            FakeListProducts(Result.failure(Exception("boom"))),
            loggerFactory = testLoggerFactory
        )
        viewModel.loadProducts("biz-1")
        assertEquals(ProductListStatus.Error, viewModel.state.status)
        assertTrue(viewModel.state.errorMessage?.isNotBlank() == true)
    }
}
