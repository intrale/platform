package ui.sc.business

import asdo.business.ToDoListProducts
import asdo.business.ToDoListCategories
import ext.business.CategoryDTO
import ext.business.ProductDTO
import ext.business.ProductStatus
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private class FakeListProducts(
    private val result: Result<List<ProductDTO>>
) : ToDoListProducts {
    override suspend fun execute(businessId: String): Result<List<ProductDTO>> = result
}

private class FakeListCategories(
    private val result: Result<List<CategoryDTO>>
) : ToDoListCategories {
    override suspend fun execute(businessId: String): Result<List<CategoryDTO>> = result
}

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

class ProductListViewModelTest {

    @Test
    fun `estado missing cuando no hay negocio seleccionado`() = runTest {
        val viewModel = ProductListViewModel(
            FakeListProducts(Result.success(emptyList())),
            FakeListCategories(Result.success(emptyList())),
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
            FakeListCategories(Result.success(listOf(CategoryDTO(id = "frutas", name = "Frutas")))),
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
            FakeListCategories(Result.success(emptyList())),
            loggerFactory = testLoggerFactory
        )
        viewModel.loadProducts("biz-1")
        assertEquals(ProductListStatus.Error, viewModel.state.status)
        assertTrue(viewModel.state.errorMessage?.isNotBlank() == true)
    }

    @Test
    fun `filtrar por categoria reduce items`() = runTest {
        val products = listOf(
            ProductDTO(
                id = "1",
                name = "Manzana",
                shortDescription = "Roja",
                basePrice = 10.0,
                unit = "kg",
                categoryId = "frutas",
                status = ProductStatus.Published
            ),
            ProductDTO(
                id = "2",
                name = "Zanahoria",
                shortDescription = "Naranja",
                basePrice = 8.0,
                unit = "kg",
                categoryId = "vegetales",
                status = ProductStatus.Published
            )
        )
        val viewModel = ProductListViewModel(
            FakeListProducts(Result.success(products)),
            FakeListCategories(
                Result.success(
                    listOf(
                        CategoryDTO(id = "frutas", name = "Frutas"),
                        CategoryDTO(id = "vegetales", name = "Vegetales")
                    )
                )
            ),
            loggerFactory = testLoggerFactory
        )
        viewModel.loadProducts("biz-1")
        viewModel.selectCategory("frutas")
        assertEquals(1, viewModel.state.items.size)
        assertEquals("frutas", viewModel.state.items.first().categoryId)
    }

    @Test
    fun `producto agotado mapea isAvailable false`() = runTest {
        val products = listOf(
            ProductDTO(
                id = "1",
                name = "Manzana",
                shortDescription = "Roja",
                basePrice = 10.0,
                unit = "kg",
                categoryId = "frutas",
                status = ProductStatus.Published,
                isAvailable = false,
                stockQuantity = 0
            )
        )
        val viewModel = ProductListViewModel(
            FakeListProducts(Result.success(products)),
            FakeListCategories(Result.success(listOf(CategoryDTO(id = "frutas", name = "Frutas")))),
            loggerFactory = testLoggerFactory
        )
        viewModel.loadProducts("biz-1")
        assertEquals(ProductListStatus.Loaded, viewModel.state.status)
        assertFalse(viewModel.state.items.first().isAvailable)
        assertEquals(0, viewModel.state.items.first().stockQuantity)
    }
}
