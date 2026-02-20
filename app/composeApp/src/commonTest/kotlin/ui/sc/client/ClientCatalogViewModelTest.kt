package ui.sc.client

import asdo.business.ToDoListCategories
import asdo.business.ToDoListProducts
import ext.business.CategoryDTO
import ext.business.ProductDTO
import ext.business.ProductStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend

private val catalogTestLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private val sampleProducts = listOf(
    ProductDTO(
        id = "prod-1",
        businessId = "biz-1",
        name = "Manzana roja",
        basePrice = 1200.0,
        unit = "kg",
        categoryId = "cat-1",
        status = ProductStatus.Published
    ),
    ProductDTO(
        id = "prod-2",
        businessId = "biz-1",
        name = "Banana",
        basePrice = 800.0,
        unit = "kg",
        categoryId = "cat-2",
        status = ProductStatus.Published
    ),
    ProductDTO(
        id = "prod-3",
        businessId = "biz-1",
        name = "Leche entera",
        basePrice = 500.0,
        unit = "litro",
        categoryId = "cat-1",
        status = ProductStatus.Draft
    )
)

private val sampleCategories = listOf(
    CategoryDTO(id = "cat-1", name = "Frutas y verduras"),
    CategoryDTO(id = "cat-2", name = "Almacen")
)

// --- Fakes ---

private class FakeListProductsSuccess(
    private val products: List<ProductDTO> = sampleProducts
) : ToDoListProducts {
    override suspend fun execute(businessId: String): Result<List<ProductDTO>> =
        Result.success(products)
}

private class FakeListProductsFailure(
    private val error: String = "Error de red"
) : ToDoListProducts {
    override suspend fun execute(businessId: String): Result<List<ProductDTO>> =
        Result.failure(RuntimeException(error))
}

private class FakeListCategoriesSuccess(
    private val categories: List<CategoryDTO> = sampleCategories
) : ToDoListCategories {
    override suspend fun execute(businessId: String): Result<List<CategoryDTO>> =
        Result.success(categories)
}

private class FakeListCategoriesFailure(
    private val error: String = "Error de red"
) : ToDoListCategories {
    override suspend fun execute(businessId: String): Result<List<CategoryDTO>> =
        Result.failure(RuntimeException(error))
}

class ClientCatalogViewModelTest {

    private fun setUp() {
        ClientCartStore.clear()
    }

    private fun createViewModel(
        toDoListProducts: ToDoListProducts = FakeListProductsSuccess(),
        toDoListCategories: ToDoListCategories = FakeListCategoriesSuccess()
    ): ClientCatalogViewModel = ClientCatalogViewModel(
        toDoListProducts = toDoListProducts,
        toDoListCategories = toDoListCategories,
        loggerFactory = catalogTestLoggerFactory
    )

    @Test
    fun `loadCatalog exitoso carga productos y categorias`() = runTest {
        val viewModel = createViewModel()

        viewModel.loadCatalog()

        val state = viewModel.state
        assertIs<ClientProductsState.Loaded>(state.productsState)
        // Solo productos Published (prod-1 y prod-2, prod-3 es Draft)
        assertEquals(2, (state.productsState as ClientProductsState.Loaded).products.size)
        assertEquals(2, state.categories.size)
        assertEquals("Frutas y verduras", state.categories[0].name)
        assertEquals("Almacen", state.categories[1].name)
        assertNull(state.selectedCategoryId)
        assertEquals("", state.searchQuery)
    }

    @Test
    fun `loadCatalog con error muestra estado de error`() = runTest {
        val viewModel = createViewModel(
            toDoListProducts = FakeListProductsFailure("Sin conexion")
        )

        viewModel.loadCatalog()

        assertIs<ClientProductsState.Error>(viewModel.state.productsState)
        assertEquals(
            "Sin conexion",
            (viewModel.state.productsState as ClientProductsState.Error).message
        )
    }

    @Test
    fun `selectCategory filtra productos por categoria`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        viewModel.selectCategory("cat-1")

        val state = viewModel.state
        assertEquals("cat-1", state.selectedCategoryId)
        assertIs<ClientProductsState.Loaded>(state.productsState)
        val products = (state.productsState as ClientProductsState.Loaded).products
        assertEquals(1, products.size)
        assertEquals("Manzana roja", products[0].name)
    }

    @Test
    fun `onSearchChange filtra productos por nombre`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        viewModel.onSearchChange("ban")

        val state = viewModel.state
        assertEquals("ban", state.searchQuery)
        assertIs<ClientProductsState.Loaded>(state.productsState)
        val products = (state.productsState as ClientProductsState.Loaded).products
        assertEquals(1, products.size)
        assertEquals("Banana", products[0].name)
    }

    @Test
    fun `addToCart agrega producto al carrito`() = runTest {
        setUp()
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        val loaded = viewModel.state.productsState as ClientProductsState.Loaded
        val product = loaded.products.first()
        viewModel.addToCart(product)

        assertNotNull(viewModel.state.lastAddedProduct)
        assertEquals(product.id, viewModel.state.lastAddedProduct?.id)
        val cartItems = ClientCartStore.items.value
        assertTrue(cartItems.containsKey(product.id))
        assertEquals(1, cartItems[product.id]?.quantity)
    }

    @Test
    fun `loadCatalog sin productos muestra estado vacio`() = runTest {
        val viewModel = createViewModel(
            toDoListProducts = FakeListProductsSuccess(emptyList())
        )

        viewModel.loadCatalog()

        assertIs<ClientProductsState.Empty>(viewModel.state.productsState)
    }

    @Test
    fun `selectCategory null muestra todos los productos`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        viewModel.selectCategory("cat-1")
        viewModel.selectCategory(null)

        val state = viewModel.state
        assertNull(state.selectedCategoryId)
        assertIs<ClientProductsState.Loaded>(state.productsState)
        assertEquals(2, (state.productsState as ClientProductsState.Loaded).products.size)
    }

    @Test
    fun `busqueda sin resultados muestra estado vacio`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        viewModel.onSearchChange("producto inexistente")

        assertIs<ClientProductsState.Empty>(viewModel.state.productsState)
    }

    @Test
    fun `filtro combinado de categoria y busqueda`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        viewModel.selectCategory("cat-1")
        viewModel.onSearchChange("manzana")

        val state = viewModel.state
        assertIs<ClientProductsState.Loaded>(state.productsState)
        val products = (state.productsState as ClientProductsState.Loaded).products
        assertEquals(1, products.size)
        assertEquals("Manzana roja", products[0].name)
    }
}
