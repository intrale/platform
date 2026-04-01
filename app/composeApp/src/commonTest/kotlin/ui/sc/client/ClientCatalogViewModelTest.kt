package ui.sc.client

import asdo.business.ToDoListCategories
import asdo.business.ToDoListProducts
import ar.com.intrale.shared.business.CategoryDTO
import ar.com.intrale.shared.business.ProductDTO
import ar.com.intrale.shared.business.ProductStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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
        SearchHistoryStore.clearHistory()
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

    // --- Tests de sugerencias en tiempo real ---

    @Test
    fun `computeSuggestions con 2+ caracteres genera sugerencias`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        viewModel.computeSuggestions("man")

        val state = viewModel.state
        assertTrue(state.showSuggestions)
        assertEquals(1, state.suggestions.size)
        assertEquals("Manzana roja", state.suggestions[0].product.name)
    }

    @Test
    fun `computeSuggestions con menos de 2 caracteres no genera sugerencias`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        viewModel.computeSuggestions("m")

        assertFalse(viewModel.state.showSuggestions)
        assertTrue(viewModel.state.suggestions.isEmpty())
    }

    @Test
    fun `computeSuggestions filtra productos sin stock`() = runTest {
        val productsWithUnavailable = listOf(
            ProductDTO(
                id = "prod-1", businessId = "biz-1", name = "Pan integral",
                basePrice = 300.0, unit = "unidad", categoryId = "cat-1",
                status = ProductStatus.Published, isAvailable = false
            ),
            ProductDTO(
                id = "prod-2", businessId = "biz-1", name = "Pan lactal",
                basePrice = 400.0, unit = "unidad", categoryId = "cat-1",
                status = ProductStatus.Published, isAvailable = true
            )
        )
        val viewModel = createViewModel(
            toDoListProducts = FakeListProductsSuccess(productsWithUnavailable)
        )
        viewModel.loadCatalog()

        viewModel.computeSuggestions("pan")

        val suggestions = viewModel.state.suggestions
        assertEquals(1, suggestions.size)
        assertEquals("Pan lactal", suggestions[0].product.name)
    }

    @Test
    fun `computeSuggestions genera rangos de match correctos`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        viewModel.computeSuggestions("ana")

        val suggestions = viewModel.state.suggestions
        // "Banana" contiene "ana" en posicion 1 y 3
        val bananaSuggestion = suggestions.find { it.product.name == "Banana" }
        assertNotNull(bananaSuggestion)
        assertTrue(bananaSuggestion.matchRanges.isNotEmpty())
    }

    @Test
    fun `selectSuggestion guarda en historial y oculta sugerencias`() = runTest {
        setUp()
        val viewModel = createViewModel()
        viewModel.loadCatalog()
        viewModel.computeSuggestions("man")

        val suggestion = viewModel.state.suggestions.first()
        viewModel.selectSuggestion(suggestion)

        val state = viewModel.state
        assertEquals("Manzana roja", state.searchQuery)
        assertFalse(state.showSuggestions)
        assertTrue(SearchHistoryStore.history.value.contains("Manzana roja"))
    }

    @Test
    fun `confirmSearch guarda en historial con query de 2+ caracteres`() = runTest {
        setUp()
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        viewModel.onSearchChange("ban")
        viewModel.confirmSearch()

        assertTrue(SearchHistoryStore.history.value.contains("ban"))
        assertFalse(viewModel.state.showSuggestions)
    }

    @Test
    fun `confirmSearch no guarda en historial con query de menos de 2 caracteres`() = runTest {
        setUp()
        val viewModel = createViewModel()

        viewModel.onSearchChange("b")
        viewModel.confirmSearch()

        assertTrue(SearchHistoryStore.history.value.isEmpty())
    }

    @Test
    fun `selectHistoryItem aplica filtro y genera sugerencias`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        viewModel.selectHistoryItem("Banana")

        assertEquals("Banana", viewModel.state.searchQuery)
        // computeSuggestions se ejecuta al final y encuentra match
        assertTrue(viewModel.state.suggestions.isNotEmpty())
    }

    @Test
    fun `clearSearch resetea query y oculta sugerencias`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        viewModel.onSearchChange("man")
        viewModel.computeSuggestions("man")
        viewModel.clearSearch()

        assertEquals("", viewModel.state.searchQuery)
        assertFalse(viewModel.state.showSuggestions)
        assertTrue(viewModel.state.suggestions.isEmpty())
    }

    @Test
    fun `onSearchFocusChanged con foco y query vacio no muestra sugerencias`() = runTest {
        val viewModel = createViewModel()

        viewModel.onSearchFocusChanged(true)

        assertTrue(viewModel.state.isSearchFocused)
        assertFalse(viewModel.state.showSuggestions)
    }

    @Test
    fun `onSearchChange con 2+ caracteres activa showSuggestions`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        viewModel.onSearchChange("ma")

        assertTrue(viewModel.state.showSuggestions)
    }

    @Test
    fun `onSearchChange con menos de 2 caracteres desactiva showSuggestions`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        viewModel.onSearchChange("m")

        assertFalse(viewModel.state.showSuggestions)
    }

    // --- Tests de findMatchRanges ---

    @Test
    fun `findMatchRanges encuentra coincidencias case-insensitive`() {
        val ranges = ClientCatalogViewModel.findMatchRanges("Manzana roja", "man")

        assertEquals(1, ranges.size)
        assertEquals(0 until 3, ranges[0])
    }

    @Test
    fun `findMatchRanges encuentra multiples coincidencias`() {
        val ranges = ClientCatalogViewModel.findMatchRanges("banana", "an")

        assertEquals(2, ranges.size)
        assertEquals(1 until 3, ranges[0])
        assertEquals(3 until 5, ranges[1])
    }

    @Test
    fun `findMatchRanges retorna vacio con query en blanco`() {
        val ranges = ClientCatalogViewModel.findMatchRanges("Manzana", "")

        assertTrue(ranges.isEmpty())
    }

    @Test
    fun `findMatchRanges retorna vacio sin coincidencias`() {
        val ranges = ClientCatalogViewModel.findMatchRanges("Manzana", "xyz")

        assertTrue(ranges.isEmpty())
    }

    // --- Tests de dismissSuggestions ---

    @Test
    fun `dismissSuggestions oculta las sugerencias`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadCatalog()
        viewModel.computeSuggestions("man")
        assertTrue(viewModel.state.showSuggestions)

        viewModel.dismissSuggestions()

        assertFalse(viewModel.state.showSuggestions)
    }

    // --- Tests de clearLastAddedProduct ---

    @Test
    fun `clearLastAddedProduct limpia el ultimo producto agregado`() = runTest {
        setUp()
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        val loaded = viewModel.state.productsState as ClientProductsState.Loaded
        viewModel.addToCart(loaded.products.first())
        assertNotNull(viewModel.state.lastAddedProduct)

        viewModel.clearLastAddedProduct()

        assertNull(viewModel.state.lastAddedProduct)
    }

    @Test
    fun `clearLastAddedProduct sin producto previo no cambia estado`() = runTest {
        val viewModel = createViewModel()

        viewModel.clearLastAddedProduct()

        assertNull(viewModel.state.lastAddedProduct)
    }

    // --- Tests adicionales de cobertura ---

    @Test
    fun `loadCatalog con error en categorias muestra error`() = runTest {
        val viewModel = createViewModel(
            toDoListCategories = FakeListCategoriesFailure("Error categorias")
        )

        viewModel.loadCatalog()

        assertIs<ClientProductsState.Error>(viewModel.state.productsState)
    }

    @Test
    fun `onSearchFocusChanged con foco false actualiza estado`() = runTest {
        val viewModel = createViewModel()
        viewModel.onSearchFocusChanged(true)
        assertTrue(viewModel.state.isSearchFocused)

        viewModel.onSearchFocusChanged(false)

        assertFalse(viewModel.state.isSearchFocused)
    }

    @Test
    fun `computeSuggestions limita a MAX_SUGGESTIONS resultados`() = runTest {
        val manyProducts = (1..15).map { i ->
            ProductDTO(
                id = "prod-$i",
                businessId = "biz-1",
                name = "Producto test $i",
                basePrice = 100.0 * i,
                unit = "unidad",
                categoryId = "cat-1",
                status = ProductStatus.Published,
                isAvailable = true
            )
        }
        val viewModel = createViewModel(
            toDoListProducts = FakeListProductsSuccess(manyProducts)
        )
        viewModel.loadCatalog()

        viewModel.computeSuggestions("producto")

        assertTrue(viewModel.state.suggestions.size <= ClientCatalogViewModel.MAX_SUGGESTIONS)
    }

    @Test
    fun `computeSuggestions sin matches oculta sugerencias`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        viewModel.computeSuggestions("zzzzz")

        assertFalse(viewModel.state.showSuggestions)
        assertTrue(viewModel.state.suggestions.isEmpty())
    }

    @Test
    fun `addToCart incrementa cantidad en carrito existente`() = runTest {
        setUp()
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        val loaded = viewModel.state.productsState as ClientProductsState.Loaded
        val product = loaded.products.first()
        viewModel.addToCart(product)
        viewModel.addToCart(product)

        val cartItems = ClientCartStore.items.value
        assertEquals(2, cartItems[product.id]?.quantity)
    }

    @Test
    fun `selectCategory y luego busqueda combinada filtra correctamente`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        viewModel.selectCategory("cat-2")
        viewModel.onSearchChange("ban")

        val state = viewModel.state
        assertIs<ClientProductsState.Loaded>(state.productsState)
        val products = (state.productsState as ClientProductsState.Loaded).products
        assertEquals(1, products.size)
        assertEquals("Banana", products[0].name)
    }

    @Test
    fun `confirmSearch con query largo guarda en historial`() = runTest {
        setUp()
        val viewModel = createViewModel()
        viewModel.loadCatalog()

        viewModel.onSearchChange("manzana roja")
        viewModel.confirmSearch()

        assertTrue(SearchHistoryStore.history.value.contains("manzana roja"))
    }

    @Test
    fun `onSearchFocusChanged con foco y query no vacio mantiene sugerencias`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadCatalog()
        viewModel.onSearchChange("man")

        viewModel.onSearchFocusChanged(true)

        assertTrue(viewModel.state.isSearchFocused)
        assertTrue(viewModel.state.showSuggestions)
    }
}
