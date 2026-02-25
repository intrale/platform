package ui.sc.client

import asdo.business.ToGetProduct
import ext.business.ProductDTO
import ext.business.ProductStatus
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend

private val detailTestLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private val sampleProductDTO = ProductDTO(
    id = "prod-1",
    businessId = "biz-1",
    name = "Manzana roja",
    shortDescription = "Manzana organica de Mendoza",
    basePrice = 1200.0,
    unit = "kg",
    categoryId = "cat-1",
    status = ProductStatus.Published
)

// --- Fakes ---

private class FakeGetProductSuccess(
    private val product: ProductDTO = sampleProductDTO
) : ToGetProduct {
    override suspend fun execute(businessId: String, productId: String): Result<ProductDTO> =
        Result.success(product)
}

private class FakeGetProductFailure(
    private val error: String = "Error de red"
) : ToGetProduct {
    override suspend fun execute(businessId: String, productId: String): Result<ProductDTO> =
        Result.failure(RuntimeException(error))
}

// =============================================================================
// ClientProductDetailViewModel
// =============================================================================

class ClientProductDetailViewModelTest {

    @BeforeTest
    fun setUp() {
        ClientCartStore.clear()
        ClientProductSelectionStore.clear()
    }

    private fun createViewModel(
        toGetProduct: ToGetProduct = FakeGetProductSuccess()
    ): ClientProductDetailViewModel = ClientProductDetailViewModel(
        toGetProduct = toGetProduct,
        loggerFactory = detailTestLoggerFactory
    )

    @Test
    fun `loadProduct exitoso carga detalle del producto`() = runTest {
        ClientProductSelectionStore.select("prod-1")
        val viewModel = createViewModel()

        viewModel.loadProduct()

        assertIs<ProductDetailState.Loaded>(viewModel.state.productState)
        val detail = (viewModel.state.productState as ProductDetailState.Loaded).detail
        assertEquals("Manzana roja", detail.name)
        assertEquals("Manzana organica de Mendoza", detail.description)
        assertEquals("kg", detail.unit)
        assertEquals(1200.0, detail.unitPrice)
    }

    @Test
    fun `loadProduct sin seleccion muestra error`() = runTest {
        val viewModel = createViewModel()

        viewModel.loadProduct()

        assertIs<ProductDetailState.Error>(viewModel.state.productState)
    }

    @Test
    fun `loadProduct con error del servicio muestra error`() = runTest {
        ClientProductSelectionStore.select("prod-1")
        val viewModel = createViewModel(toGetProduct = FakeGetProductFailure("Sin conexion"))

        viewModel.loadProduct()

        assertIs<ProductDetailState.Error>(viewModel.state.productState)
        assertEquals("Sin conexion", (viewModel.state.productState as ProductDetailState.Error).message)
    }

    @Test
    fun `estado inicial tiene cantidad 1 y no esta en carrito`() {
        val viewModel = createViewModel()

        assertEquals(1, viewModel.state.quantity)
        assertFalse(viewModel.state.isInCart)
        assertEquals(0, viewModel.state.cartQuantity)
        assertNull(viewModel.state.snackbarMessage)
    }

    @Test
    fun `incrementQuantity aumenta la cantidad`() = runTest {
        ClientProductSelectionStore.select("prod-1")
        val viewModel = createViewModel()
        viewModel.loadProduct()

        viewModel.incrementQuantity()

        assertEquals(2, viewModel.state.quantity)
    }

    @Test
    fun `decrementQuantity reduce la cantidad pero no debajo de 1`() = runTest {
        ClientProductSelectionStore.select("prod-1")
        val viewModel = createViewModel()
        viewModel.loadProduct()

        viewModel.decrementQuantity()

        assertEquals(1, viewModel.state.quantity)
    }

    @Test
    fun `decrementQuantity reduce desde cantidad mayor a 1`() = runTest {
        ClientProductSelectionStore.select("prod-1")
        val viewModel = createViewModel()
        viewModel.loadProduct()
        viewModel.incrementQuantity()
        viewModel.incrementQuantity()

        viewModel.decrementQuantity()

        assertEquals(2, viewModel.state.quantity)
    }

    @Test
    fun `addOrUpdateCart agrega producto al carrito`() = runTest {
        ClientProductSelectionStore.select("prod-1")
        val viewModel = createViewModel()
        viewModel.loadProduct()
        viewModel.incrementQuantity()

        viewModel.addOrUpdateCart()

        assertTrue(viewModel.state.isInCart)
        assertEquals(2, viewModel.state.cartQuantity)
        assertEquals(2, ClientCartStore.items.value["prod-1"]?.quantity)
        assertEquals("added", viewModel.state.snackbarMessage)
    }

    @Test
    fun `addOrUpdateCart con producto ya en carrito muestra mensaje updated`() = runTest {
        val product = ClientProduct(
            id = "prod-1",
            name = "Manzana",
            priceLabel = "\$1200.00",
            emoji = "\uD83D\uDECD\uFE0F",
            unitPrice = 1200.0
        )
        ClientCartStore.add(product)
        ClientProductSelectionStore.select("prod-1")
        val viewModel = createViewModel()
        viewModel.loadProduct()

        viewModel.incrementQuantity()
        viewModel.addOrUpdateCart()

        assertEquals("updated", viewModel.state.snackbarMessage)
    }

    @Test
    fun `loadProduct detecta producto existente en carrito`() = runTest {
        val product = ClientProduct(
            id = "prod-1",
            name = "Manzana",
            priceLabel = "\$1200.00",
            emoji = "\uD83D\uDECD\uFE0F",
            unitPrice = 1200.0
        )
        ClientCartStore.add(product)
        ClientCartStore.add(product)
        ClientProductSelectionStore.select("prod-1")
        val viewModel = createViewModel()

        viewModel.loadProduct()

        assertTrue(viewModel.state.isInCart)
        assertEquals(2, viewModel.state.quantity)
        assertEquals(2, viewModel.state.cartQuantity)
    }

    @Test
    fun `clearSnackbar limpia el mensaje`() = runTest {
        ClientProductSelectionStore.select("prod-1")
        val viewModel = createViewModel()
        viewModel.loadProduct()
        viewModel.addOrUpdateCart()
        assertEquals("added", viewModel.state.snackbarMessage)

        viewModel.clearSnackbar()

        assertNull(viewModel.state.snackbarMessage)
    }
}
