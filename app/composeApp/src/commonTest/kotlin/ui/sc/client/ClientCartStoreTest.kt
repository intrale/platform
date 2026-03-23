package ui.sc.client

import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val productA = ClientProduct(
    id = "prod-a",
    name = "Manzana roja",
    priceLabel = "$1200 / kg",
    emoji = "🍎",
    unitPrice = 1200.0,
    isAvailable = true
)

private val productB = ClientProduct(
    id = "prod-b",
    name = "Naranja",
    priceLabel = "$800 / kg",
    emoji = "🍊",
    unitPrice = 800.0,
    isAvailable = true
)

private val unavailableProduct = ClientProduct(
    id = "prod-c",
    name = "Sin stock",
    priceLabel = "$500",
    emoji = "📦",
    unitPrice = 500.0,
    isAvailable = false
)

class ClientCartStoreTest {

    @BeforeTest
    fun setUp() {
        ClientCartStore.clear()
    }

    @Test
    fun `add agrega producto con cantidad 1`() {
        ClientCartStore.add(productA)

        val items = ClientCartStore.items.value
        assertEquals(1, items.size)
        assertEquals(1, items["prod-a"]?.quantity)
    }

    @Test
    fun `add producto existente incrementa cantidad`() {
        ClientCartStore.add(productA)
        ClientCartStore.add(productA)

        val items = ClientCartStore.items.value
        assertEquals(2, items["prod-a"]?.quantity)
    }

    @Test
    fun `add producto no disponible no se agrega`() {
        ClientCartStore.add(unavailableProduct)

        assertTrue(ClientCartStore.items.value.isEmpty())
    }

    @Test
    fun `increment aumenta cantidad en 1`() {
        ClientCartStore.add(productA)
        ClientCartStore.increment("prod-a")

        assertEquals(2, ClientCartStore.items.value["prod-a"]?.quantity)
    }

    @Test
    fun `increment en id inexistente no cambia el estado`() {
        ClientCartStore.add(productA)
        ClientCartStore.increment("prod-inexistente")

        assertEquals(1, ClientCartStore.items.value.size)
    }

    @Test
    fun `decrement reduce cantidad en 1`() {
        ClientCartStore.add(productA)
        ClientCartStore.add(productA)
        ClientCartStore.decrement("prod-a")

        assertEquals(1, ClientCartStore.items.value["prod-a"]?.quantity)
    }

    @Test
    fun `decrement en cantidad 1 elimina el producto`() {
        ClientCartStore.add(productA)
        ClientCartStore.decrement("prod-a")

        assertTrue(ClientCartStore.items.value.isEmpty())
    }

    @Test
    fun `remove elimina el producto del carrito`() {
        ClientCartStore.add(productA)
        ClientCartStore.add(productB)
        ClientCartStore.remove("prod-a")

        val items = ClientCartStore.items.value
        assertEquals(1, items.size)
        assertNull(items["prod-a"])
    }

    @Test
    fun `clear vacia todos los items`() {
        ClientCartStore.add(productA)
        ClientCartStore.add(productB)
        ClientCartStore.clear()

        assertTrue(ClientCartStore.items.value.isEmpty())
    }

    @Test
    fun `clear limpia la direccion seleccionada`() {
        ClientCartStore.selectAddress("addr-1")
        ClientCartStore.clear()

        assertNull(ClientCartStore.selectedAddressId.value)
    }

    @Test
    fun `clear limpia el medio de pago seleccionado`() {
        ClientCartStore.selectPaymentMethod("pm-1")
        ClientCartStore.clear()

        assertNull(ClientCartStore.selectedPaymentMethodId.value)
    }

    @Test
    fun `setQuantity con cantidad mayor a 0 actualiza cantidad`() {
        ClientCartStore.add(productA)
        ClientCartStore.setQuantity(productA, 5)

        assertEquals(5, ClientCartStore.items.value["prod-a"]?.quantity)
    }

    @Test
    fun `setQuantity con cantidad 0 elimina el producto`() {
        ClientCartStore.add(productA)
        ClientCartStore.setQuantity(productA, 0)

        assertTrue(ClientCartStore.items.value.isEmpty())
    }

    @Test
    fun `selectAddress actualiza la direccion seleccionada`() {
        ClientCartStore.selectAddress("addr-123")

        assertEquals("addr-123", ClientCartStore.selectedAddressId.value)
    }

    @Test
    fun `selectPaymentMethod actualiza el medio de pago seleccionado`() {
        ClientCartStore.selectPaymentMethod("pm-efectivo")

        assertEquals("pm-efectivo", ClientCartStore.selectedPaymentMethodId.value)
    }

    @Test
    fun `multiples productos se acumulan correctamente`() {
        ClientCartStore.add(productA)
        ClientCartStore.add(productA)
        ClientCartStore.add(productB)

        val items = ClientCartStore.items.value
        assertEquals(2, items.size)
        assertEquals(2, items["prod-a"]?.quantity)
        assertEquals(1, items["prod-b"]?.quantity)
    }
}
