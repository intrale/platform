package ui.sc.business

import asdo.business.ToDoListProducts
import asdo.business.ToDoListCategories
import asdo.business.ToDoUpdateProduct
import ar.com.intrale.shared.business.CategoryDTO
import ar.com.intrale.shared.business.ProductDTO
import ar.com.intrale.shared.business.ProductRequest
import ar.com.intrale.shared.business.ProductStatus
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

private class CapturingUpdateProduct(
    private val result: (ProductRequest) -> Result<ProductDTO> = { req ->
        Result.success(
            ProductDTO(
                id = "1",
                name = req.name,
                basePrice = req.basePrice,
                unit = req.unit,
                categoryId = req.categoryId,
                status = req.status
            )
        )
    }
) : ToDoUpdateProduct {
    var lastStatus: ProductStatus? = null
        private set

    override suspend fun execute(
        businessId: String,
        productId: String,
        request: ProductRequest
    ): Result<ProductDTO> {
        lastStatus = request.status
        return result(request)
    }
}

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

class ProductListViewModelTest {

    @Test
    fun `estado missing cuando no hay negocio seleccionado`() = runTest {
        val viewModel = ProductListViewModel(
            FakeListProducts(Result.success(emptyList())),
            FakeListCategories(Result.success(emptyList())),
            updateProduct = CapturingUpdateProduct(),
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
            updateProduct = CapturingUpdateProduct(),
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
            updateProduct = CapturingUpdateProduct(),
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
            updateProduct = CapturingUpdateProduct(),
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
            updateProduct = CapturingUpdateProduct(),
            loggerFactory = testLoggerFactory
        )
        viewModel.loadProducts("biz-1")
        assertEquals(ProductListStatus.Loaded, viewModel.state.status)
        assertFalse(viewModel.state.items.first().isAvailable)
        assertEquals(0, viewModel.state.items.first().stockQuantity)
    }

    @Test
    fun `pausar producto invoca updateProduct con status Paused`() = runTest {
        val products = listOf(
            ProductDTO(
                id = "1",
                name = "Manzana",
                basePrice = 10.0,
                unit = "kg",
                categoryId = "frutas",
                status = ProductStatus.Published
            )
        )
        val fakeUpdate = CapturingUpdateProduct()
        val viewModel = ProductListViewModel(
            FakeListProducts(Result.success(products)),
            FakeListCategories(Result.success(listOf(CategoryDTO(id = "frutas", name = "Frutas")))),
            updateProduct = fakeUpdate,
            loggerFactory = testLoggerFactory
        )
        viewModel.loadProducts("biz-1")
        val item = viewModel.state.items.first()
        val result = viewModel.pause(item)
        assertTrue(result.isSuccess)
        assertEquals(ProductStatus.Paused, fakeUpdate.lastStatus)
    }

    @Test
    fun `reanudar producto invoca updateProduct con status Published`() = runTest {
        val products = listOf(
            ProductDTO(
                id = "1",
                name = "Manzana",
                basePrice = 10.0,
                unit = "kg",
                categoryId = "frutas",
                status = ProductStatus.Paused
            )
        )
        val fakeUpdate = CapturingUpdateProduct()
        val viewModel = ProductListViewModel(
            FakeListProducts(Result.success(products)),
            FakeListCategories(Result.success(listOf(CategoryDTO(id = "frutas", name = "Frutas")))),
            updateProduct = fakeUpdate,
            loggerFactory = testLoggerFactory
        )
        viewModel.loadProducts("biz-1")
        val item = viewModel.state.items.first()
        val result = viewModel.resume(item)
        assertTrue(result.isSuccess)
        assertEquals(ProductStatus.Published, fakeUpdate.lastStatus)
    }
}
