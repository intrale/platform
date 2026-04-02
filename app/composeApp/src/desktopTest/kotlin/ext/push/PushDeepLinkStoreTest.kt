package ext.push

import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class PushDeepLinkStoreTest {

    @BeforeTest
    fun setup() {
        PushDeepLinkStore.clear()
    }

    @Test
    fun `setPendingOrderNavigation guarda el orderId`() {
        PushDeepLinkStore.setPendingOrderNavigation("order-456")

        assertEquals("order-456", PushDeepLinkStore.pendingOrderId.value)
    }

    @Test
    fun `consumePendingOrderNavigation retorna y limpia el orderId`() {
        PushDeepLinkStore.setPendingOrderNavigation("order-789")

        val consumed = PushDeepLinkStore.consumePendingOrderNavigation()

        assertEquals("order-789", consumed)
        assertNull(PushDeepLinkStore.pendingOrderId.value)
    }

    @Test
    fun `consumePendingOrderNavigation retorna null si no hay pendiente`() {
        val consumed = PushDeepLinkStore.consumePendingOrderNavigation()

        assertNull(consumed)
    }

    @Test
    fun `clear limpia el orderId pendiente`() {
        PushDeepLinkStore.setPendingOrderNavigation("order-999")

        PushDeepLinkStore.clear()

        assertNull(PushDeepLinkStore.pendingOrderId.value)
    }
}
