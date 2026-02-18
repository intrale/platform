package ui.sc.business

import asdo.auth.ToDoResetLoginCache
import asdo.business.ToDoCreateCategory
import asdo.business.ToDoCreateProduct
import asdo.business.ToDoDeleteCategory
import asdo.business.ToDoDeleteProduct
import asdo.business.ToDoListCategories
import asdo.business.ToDoListProducts
import asdo.business.ToDoUpdateCategory
import asdo.business.ToDoUpdateProduct
import asdo.business.ToGetBusinessDashboardSummary
import asdo.business.ToGetBusinesses
import ext.business.CategoryDTO
import ext.business.CategoryRequest
import ext.business.ProductDTO
import ext.business.ProductRequest
import ext.business.ProductStatus
import ext.dto.BusinessDTO
import ext.dto.BusinessDashboardSummaryDTO
import ext.dto.SearchBusinessesResponse
import ext.dto.StatusCodeDTO
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import ui.session.SessionStore
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

// ── Fakes comunes ──────────────────────────────────────────────────────────────

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private val sampleBusinessDTO = BusinessDTO(
    businessId = "biz-1",
    publicId = "pub-1",
    name = "Mi Negocio",
    description = "Descripcion",
    emailAdmin = "admin@test.com",
    autoAcceptDeliveries = false,
    status = "Active"
)

private val sampleSummary = BusinessDashboardSummaryDTO(
    productsCount = 5,
    pendingOrders = 3,
    activeDrivers = 2
)

private val okStatus = StatusCodeDTO(value = 200, description = "OK")

// ── Fakes para DashboardViewModel ──────────────────────────────────────────────

private class FakeResetLoginCache(
    private val shouldFail: Boolean = false
) : ToDoResetLoginCache {
    var called = false
        private set

    override suspend fun execute() {
        called = true
        if (shouldFail) throw RuntimeException("logout failed")
    }
}

private class FakeGetBusinesses(
    private val result: Result<SearchBusinessesResponse>
) : ToGetBusinesses {
    override suspend fun execute(
        query: String,
        status: String?,
        limit: Int?,
        lastKey: String?
    ): Result<SearchBusinessesResponse> = result
}

private class FakeGetDashboardSummary(
    private val result: Result<BusinessDashboardSummaryDTO>
) : ToGetBusinessDashboardSummary {
    override suspend fun execute(businessId: String): Result<BusinessDashboardSummaryDTO> = result
}

// ── Fakes para CategoryListViewModel ───────────────────────────────────────────

private class FakeListCategoriesForList(
    private val result: Result<List<CategoryDTO>>
) : ToDoListCategories {
    override suspend fun execute(businessId: String): Result<List<CategoryDTO>> = result
}

private class FakeDeleteCategoryForList(
    private val result: Result<Unit> = Result.success(Unit)
) : ToDoDeleteCategory {
    override suspend fun execute(
        businessId: String,
        categoryId: String,
        reassignToCategoryId: String?
    ): Result<Unit> = result
}

// ── Fakes para CategoryFormViewModel ───────────────────────────────────────────

private class FakeCreateCategory(
    private val result: Result<CategoryDTO> = Result.success(
        CategoryDTO(id = "cat-new", name = "Nueva Categoria")
    )
) : ToDoCreateCategory {
    var called = false
        private set

    override suspend fun execute(
        businessId: String,
        request: CategoryRequest
    ): Result<CategoryDTO> {
        called = true
        return result
    }
}

private class FakeUpdateCategory(
    private val result: Result<CategoryDTO> = Result.success(
        CategoryDTO(id = "cat-1", name = "Actualizada")
    )
) : ToDoUpdateCategory {
    var called = false
        private set

    override suspend fun execute(
        businessId: String,
        categoryId: String,
        request: CategoryRequest
    ): Result<CategoryDTO> {
        called = true
        return result
    }
}

private class FakeDeleteCategoryForForm(
    private val result: Result<Unit> = Result.success(Unit)
) : ToDoDeleteCategory {
    override suspend fun execute(
        businessId: String,
        categoryId: String,
        reassignToCategoryId: String?
    ): Result<Unit> = result
}

// ── Fakes para ProductListViewModel ────────────────────────────────────────────

private class FakeListProductsForList(
    private val result: Result<List<ProductDTO>>
) : ToDoListProducts {
    override suspend fun execute(businessId: String): Result<List<ProductDTO>> = result
}

private class FakeListCategoriesForProducts(
    private val result: Result<List<CategoryDTO>>
) : ToDoListCategories {
    override suspend fun execute(businessId: String): Result<List<CategoryDTO>> = result
}

// ── Fakes para ProductFormViewModel ────────────────────────────────────────────

private fun sampleProductDTO(id: String = "prod-new") = ProductDTO(
    id = id,
    name = "Producto Test",
    shortDescription = "Descripcion corta",
    basePrice = 25.0,
    unit = "kg",
    categoryId = "cat-1",
    status = ProductStatus.Draft
)

private class FakeCreateProduct(
    private val result: Result<ProductDTO> = Result.success(sampleProductDTO())
) : ToDoCreateProduct {
    var called = false
        private set

    override suspend fun execute(
        businessId: String,
        request: ProductRequest
    ): Result<ProductDTO> {
        called = true
        return result
    }
}

private class FakeUpdateProduct(
    private val result: Result<ProductDTO> = Result.success(sampleProductDTO(id = "prod-updated"))
) : ToDoUpdateProduct {
    var called = false
        private set

    override suspend fun execute(
        businessId: String,
        productId: String,
        request: ProductRequest
    ): Result<ProductDTO> {
        called = true
        return result
    }
}

private class FakeDeleteProduct(
    private val result: Result<Unit> = Result.success(Unit)
) : ToDoDeleteProduct {
    override suspend fun execute(businessId: String, productId: String): Result<Unit> = result
}

private class FakeListProductsForForm(
    private val result: Result<List<ProductDTO>> = Result.success(emptyList())
) : ToDoListProducts {
    override suspend fun execute(businessId: String): Result<List<ProductDTO>> = result
}

private class FakeListCategoriesForForm(
    private val result: Result<List<CategoryDTO>> = Result.success(emptyList())
) : ToDoListCategories {
    override suspend fun execute(businessId: String): Result<List<CategoryDTO>> = result
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests para DashboardViewModel
// ═══════════════════════════════════════════════════════════════════════════════

class DashboardViewModelTest {

    @BeforeTest
    fun setup() {
        SessionStore.clear()
    }

    @Test
    fun `loadDashboard exitoso carga negocios y resumen`() = runTest {
        val businesses = FakeGetBusinesses(
            Result.success(
                SearchBusinessesResponse(
                    statusCode = okStatus,
                    businesses = listOf(sampleBusinessDTO)
                )
            )
        )
        val summary = FakeGetDashboardSummary(Result.success(sampleSummary))
        val vm = DashboardViewModel(
            toDoResetLoginCache = FakeResetLoginCache(),
            toGetBusinesses = businesses,
            toGetBusinessDashboardSummary = summary,
            loggerFactory = testLoggerFactory
        )

        vm.loadDashboard()

        assertEquals(1, vm.state.businesses.size)
        assertEquals("biz-1", vm.state.selectedBusinessId)
        assertEquals("Mi Negocio", vm.state.selectedBusinessName)
        assertFalse(vm.state.isBusinessLoading)
        assertNull(vm.state.businessError)
        val summaryState = vm.state.summaryState
        assertTrue(summaryState is BusinessDashboardSummaryState.Loaded)
        assertEquals(5, summaryState.summary.productsCount)
        assertEquals(3, summaryState.summary.pendingOrders)
    }

    @Test
    fun `loadDashboard sin negocios muestra lista vacia`() = runTest {
        val businesses = FakeGetBusinesses(
            Result.success(
                SearchBusinessesResponse(
                    statusCode = okStatus,
                    businesses = emptyList()
                )
            )
        )
        val summary = FakeGetDashboardSummary(Result.success(sampleSummary))
        val vm = DashboardViewModel(
            toDoResetLoginCache = FakeResetLoginCache(),
            toGetBusinesses = businesses,
            toGetBusinessDashboardSummary = summary,
            loggerFactory = testLoggerFactory
        )

        vm.loadDashboard()

        assertTrue(vm.state.businesses.isEmpty())
        assertNull(vm.state.selectedBusinessId)
        assertFalse(vm.state.isBusinessLoading)
        assertEquals(BusinessDashboardSummaryState.MissingBusiness, vm.state.summaryState)
    }

    @Test
    fun `loadDashboard con error muestra businessError`() = runTest {
        val businesses = FakeGetBusinesses(
            Result.failure(RuntimeException("network error"))
        )
        val summary = FakeGetDashboardSummary(Result.success(sampleSummary))
        val vm = DashboardViewModel(
            toDoResetLoginCache = FakeResetLoginCache(),
            toGetBusinesses = businesses,
            toGetBusinessDashboardSummary = summary,
            loggerFactory = testLoggerFactory
        )

        vm.loadDashboard()

        assertFalse(vm.state.isBusinessLoading)
        assertNotNull(vm.state.businessError)
        assertTrue(vm.state.businessError!!.contains("network error"))
        assertTrue(vm.state.summaryState is BusinessDashboardSummaryState.Error)
    }

    @Test
    fun `selectBusiness actualiza negocio seleccionado`() = runTest {
        val biz1 = sampleBusinessDTO
        val biz2 = sampleBusinessDTO.copy(businessId = "biz-2", name = "Segundo Negocio")
        val businesses = FakeGetBusinesses(
            Result.success(
                SearchBusinessesResponse(
                    statusCode = okStatus,
                    businesses = listOf(biz1, biz2)
                )
            )
        )
        val summary = FakeGetDashboardSummary(Result.success(sampleSummary))
        val vm = DashboardViewModel(
            toDoResetLoginCache = FakeResetLoginCache(),
            toGetBusinesses = businesses,
            toGetBusinessDashboardSummary = summary,
            loggerFactory = testLoggerFactory
        )

        vm.loadDashboard()
        vm.selectBusiness("biz-2")

        assertEquals("biz-2", vm.state.selectedBusinessId)
        assertEquals("Segundo Negocio", vm.state.selectedBusinessName)
    }

    @Test
    fun `logout limpia estado`() = runTest {
        val resetCache = FakeResetLoginCache()
        val vm = DashboardViewModel(
            toDoResetLoginCache = resetCache,
            toGetBusinesses = FakeGetBusinesses(
                Result.success(SearchBusinessesResponse(okStatus, listOf(sampleBusinessDTO)))
            ),
            toGetBusinessDashboardSummary = FakeGetDashboardSummary(Result.success(sampleSummary)),
            loggerFactory = testLoggerFactory
        )

        vm.logout()

        assertTrue(resetCache.called)
        assertNull(SessionStore.sessionState.value.selectedBusinessId)
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests para CategoryListViewModel
// ═══════════════════════════════════════════════════════════════════════════════

class CategoryListViewModelExtendedTest {

    @Test
    fun `loadCategories exitoso muestra lista`() = runTest {
        val categories = listOf(
            CategoryDTO(id = "cat-1", name = "Bebidas", description = "Todas las bebidas", productCount = 5),
            CategoryDTO(id = "cat-2", name = "Comidas", description = "Platos principales", productCount = 10)
        )
        val vm = CategoryListViewModel(
            listCategories = FakeListCategoriesForList(Result.success(categories)),
            deleteCategory = FakeDeleteCategoryForList(),
            loggerFactory = testLoggerFactory
        )

        vm.loadCategories("biz-1")

        assertEquals(CategoryListStatus.Loaded, vm.state.status)
        assertEquals(2, vm.state.items.size)
        assertEquals("Bebidas", vm.state.items[0].name)
        assertEquals("Comidas", vm.state.items[1].name)
    }

    @Test
    fun `loadCategories sin businessId muestra MissingBusiness`() = runTest {
        val vm = CategoryListViewModel(
            listCategories = FakeListCategoriesForList(Result.success(emptyList())),
            deleteCategory = FakeDeleteCategoryForList(),
            loggerFactory = testLoggerFactory
        )

        vm.loadCategories(null)

        assertEquals(CategoryListStatus.MissingBusiness, vm.state.status)
        assertTrue(vm.state.items.isEmpty())
    }

    @Test
    fun `deleteCategory exitoso remueve de la lista`() = runTest {
        val categories = listOf(
            CategoryDTO(id = "cat-1", name = "Bebidas"),
            CategoryDTO(id = "cat-2", name = "Comidas")
        )
        val vm = CategoryListViewModel(
            listCategories = FakeListCategoriesForList(Result.success(categories)),
            deleteCategory = FakeDeleteCategoryForList(Result.success(Unit)),
            loggerFactory = testLoggerFactory
        )

        vm.loadCategories("biz-1")
        assertEquals(2, vm.state.items.size)

        val result = vm.deleteCategory("cat-1")

        assertTrue(result.isSuccess)
        assertEquals(1, vm.state.items.size)
        assertEquals("cat-2", vm.state.items.first().id)
    }

    @Test
    fun `loadCategories con error muestra Error`() = runTest {
        val vm = CategoryListViewModel(
            listCategories = FakeListCategoriesForList(Result.failure(RuntimeException("db error"))),
            deleteCategory = FakeDeleteCategoryForList(),
            loggerFactory = testLoggerFactory
        )

        vm.loadCategories("biz-1")

        assertEquals(CategoryListStatus.Error, vm.state.status)
        assertNotNull(vm.state.errorMessage)
        assertTrue(vm.state.errorMessage!!.contains("db error"))
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests para CategoryFormViewModel
// ═══════════════════════════════════════════════════════════════════════════════

class CategoryFormViewModelExtendedTest {

    @Test
    fun `applyDraft en modo edicion carga datos`() = runTest {
        val vm = CategoryFormViewModel(
            createCategory = FakeCreateCategory(),
            updateCategory = FakeUpdateCategory(),
            deleteCategory = FakeDeleteCategoryForForm()
        )
        val draft = CategoryDraft(id = "cat-1", name = "Bebidas", description = "Refrescos")

        vm.applyDraft(draft)

        assertEquals("cat-1", vm.uiState.id)
        assertEquals("Bebidas", vm.uiState.name)
        assertEquals("Refrescos", vm.uiState.description)
        assertEquals(CategoryFormMode.Edit, vm.mode)
    }

    @Test
    fun `save en modo crear invoca createCategory`() = runTest {
        val fakeCreate = FakeCreateCategory()
        val vm = CategoryFormViewModel(
            createCategory = fakeCreate,
            updateCategory = FakeUpdateCategory(),
            deleteCategory = FakeDeleteCategoryForForm()
        )
        vm.uiState = vm.uiState.copy(name = "Nueva Categoria")

        val result = vm.save("biz-1")

        assertTrue(result.isSuccess)
        assertTrue(fakeCreate.called)
        assertEquals(CategoryFormMode.Edit, vm.mode)
        assertEquals("cat-new", vm.uiState.id)
    }

    @Test
    fun `save en modo editar invoca updateCategory`() = runTest {
        val fakeUpdate = FakeUpdateCategory()
        val vm = CategoryFormViewModel(
            createCategory = FakeCreateCategory(),
            updateCategory = fakeUpdate,
            deleteCategory = FakeDeleteCategoryForForm()
        )
        vm.applyDraft(CategoryDraft(id = "cat-1", name = "Bebidas", description = "Original"))
        vm.uiState = vm.uiState.copy(name = "Bebidas Actualizadas")

        val result = vm.save("biz-1")

        assertTrue(result.isSuccess)
        assertTrue(fakeUpdate.called)
        assertEquals(CategoryFormMode.Edit, vm.mode)
    }

    @Test
    fun `save con nombre vacio falla validacion`() = runTest {
        val fakeCreate = FakeCreateCategory()
        val vm = CategoryFormViewModel(
            createCategory = fakeCreate,
            updateCategory = FakeUpdateCategory(),
            deleteCategory = FakeDeleteCategoryForForm()
        )
        // uiState.name es "" por defecto

        val result = vm.save("biz-1")

        assertTrue(result.isFailure)
        assertFalse(fakeCreate.called)
        assertNotNull(vm.errorMessage)
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests para ProductListViewModel
// ═══════════════════════════════════════════════════════════════════════════════

class ProductListViewModelExtendedTest {

    private val sampleProducts = listOf(
        ProductDTO(
            id = "prod-1",
            name = "Manzana",
            shortDescription = "Roja",
            basePrice = 10.0,
            unit = "kg",
            categoryId = "cat-frutas",
            status = ProductStatus.Published
        ),
        ProductDTO(
            id = "prod-2",
            name = "Zanahoria",
            shortDescription = "Naranja",
            basePrice = 8.0,
            unit = "kg",
            categoryId = "cat-verduras",
            status = ProductStatus.Published
        )
    )

    private val sampleCategories = listOf(
        CategoryDTO(id = "cat-frutas", name = "Frutas"),
        CategoryDTO(id = "cat-verduras", name = "Verduras")
    )

    @Test
    fun `loadProducts exitoso muestra lista`() = runTest {
        val vm = ProductListViewModel(
            listProducts = FakeListProductsForList(Result.success(sampleProducts)),
            listCategories = FakeListCategoriesForProducts(Result.success(sampleCategories)),
            loggerFactory = testLoggerFactory
        )

        vm.loadProducts("biz-1")

        assertEquals(ProductListStatus.Loaded, vm.state.status)
        assertEquals(2, vm.state.items.size)
        assertEquals("Manzana", vm.state.items[0].name)
        assertEquals("Frutas", vm.state.items[0].categoryName)
    }

    @Test
    fun `loadProducts sin businessId muestra MissingBusiness`() = runTest {
        val vm = ProductListViewModel(
            listProducts = FakeListProductsForList(Result.success(emptyList())),
            listCategories = FakeListCategoriesForProducts(Result.success(emptyList())),
            loggerFactory = testLoggerFactory
        )

        vm.loadProducts(null)

        assertEquals(ProductListStatus.MissingBusiness, vm.state.status)
        assertTrue(vm.state.items.isEmpty())
    }

    @Test
    fun `selectCategory filtra productos`() = runTest {
        val vm = ProductListViewModel(
            listProducts = FakeListProductsForList(Result.success(sampleProducts)),
            listCategories = FakeListCategoriesForProducts(Result.success(sampleCategories)),
            loggerFactory = testLoggerFactory
        )

        vm.loadProducts("biz-1")
        assertEquals(2, vm.state.items.size)

        vm.selectCategory("cat-frutas")

        assertEquals(1, vm.state.items.size)
        assertEquals("Manzana", vm.state.items.first().name)
        assertEquals("cat-frutas", vm.state.items.first().categoryId)
    }

    @Test
    fun `clearCategoryFilter muestra todos`() = runTest {
        val vm = ProductListViewModel(
            listProducts = FakeListProductsForList(Result.success(sampleProducts)),
            listCategories = FakeListCategoriesForProducts(Result.success(sampleCategories)),
            loggerFactory = testLoggerFactory
        )

        vm.loadProducts("biz-1")
        vm.selectCategory("cat-frutas")
        assertEquals(1, vm.state.items.size)

        vm.clearCategoryFilter()

        assertEquals(2, vm.state.items.size)
        assertEquals(ProductListStatus.Loaded, vm.state.status)
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests para ProductFormViewModel
// ═══════════════════════════════════════════════════════════════════════════════

class ProductFormViewModelExtendedTest {

    @Test
    fun `applyDraft carga datos del borrador`() = runTest {
        val vm = ProductFormViewModel(
            createProduct = FakeCreateProduct(),
            updateProduct = FakeUpdateProduct(),
            deleteProduct = FakeDeleteProduct(),
            listProducts = FakeListProductsForForm(),
            listCategories = FakeListCategoriesForForm()
        )
        val draft = ProductDraft(
            id = "prod-1",
            name = "Manzana",
            shortDescription = "Roja",
            basePrice = 15.5,
            unit = "kg",
            categoryId = "cat-frutas",
            status = ProductStatus.Published
        )

        vm.applyDraft(draft)

        assertEquals("prod-1", vm.uiState.id)
        assertEquals("Manzana", vm.uiState.name)
        assertEquals("Roja", vm.uiState.shortDescription)
        assertEquals("15.5", vm.uiState.basePrice)
        assertEquals("kg", vm.uiState.unit)
        assertEquals("cat-frutas", vm.uiState.categoryId)
        assertEquals(ProductStatus.Published, vm.uiState.status)
        assertEquals(ProductFormMode.Edit, vm.mode)
    }

    @Test
    fun `save en modo crear invoca createProduct`() = runTest {
        val fakeCreate = FakeCreateProduct()
        val vm = ProductFormViewModel(
            createProduct = fakeCreate,
            updateProduct = FakeUpdateProduct(),
            deleteProduct = FakeDeleteProduct(),
            listProducts = FakeListProductsForForm(),
            listCategories = FakeListCategoriesForForm()
        )
        vm.uiState = vm.uiState.copy(
            name = "Manzana",
            basePrice = "10.0",
            unit = "kg",
            categoryId = "cat-frutas"
        )

        val result = vm.save("biz-1")

        assertTrue(result.isSuccess)
        assertTrue(fakeCreate.called)
        assertEquals(ProductFormMode.Edit, vm.mode)
    }

    @Test
    fun `save con precio invalido muestra error`() = runTest {
        val fakeCreate = FakeCreateProduct()
        val vm = ProductFormViewModel(
            createProduct = fakeCreate,
            updateProduct = FakeUpdateProduct(),
            deleteProduct = FakeDeleteProduct(),
            listProducts = FakeListProductsForForm(),
            listCategories = FakeListCategoriesForForm()
        )
        vm.uiState = vm.uiState.copy(
            name = "Manzana",
            basePrice = "abc",
            unit = "kg",
            categoryId = "cat-frutas"
        )

        val result = vm.save("biz-1")

        assertTrue(result.isFailure)
        assertFalse(fakeCreate.called)
    }

    @Test
    fun `loadCategories exitoso carga dropdown`() = runTest {
        val categories = listOf(
            CategoryDTO(id = "cat-1", name = "Frutas"),
            CategoryDTO(id = "cat-2", name = "Verduras")
        )
        val vm = ProductFormViewModel(
            createProduct = FakeCreateProduct(),
            updateProduct = FakeUpdateProduct(),
            deleteProduct = FakeDeleteProduct(),
            listProducts = FakeListProductsForForm(),
            listCategories = FakeListCategoriesForForm(Result.success(categories))
        )

        vm.loadCategories("biz-1")

        assertEquals(2, vm.categories.size)
        assertEquals("Frutas", vm.categories[0].name)
        assertEquals("Verduras", vm.categories[1].name)
        assertFalse(vm.categoriesLoading)
        assertNull(vm.categoryError)
    }

    @Test
    fun `updateStatus cambia estado del producto`() = runTest {
        val vm = ProductFormViewModel(
            createProduct = FakeCreateProduct(),
            updateProduct = FakeUpdateProduct(),
            deleteProduct = FakeDeleteProduct(),
            listProducts = FakeListProductsForForm(),
            listCategories = FakeListCategoriesForForm()
        )

        assertEquals(ProductStatus.Draft, vm.uiState.status)

        vm.updateStatus(ProductStatus.Published)

        assertEquals(ProductStatus.Published, vm.uiState.status)
    }
}
