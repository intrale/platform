package ui.sc.client

import asdo.client.ClientPreferences
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ClientPushPreferencesStoreTest {

    @Test
    fun `estado inicial tiene todas las notificaciones habilitadas`() {
        ClientPushPreferencesStore.clear()
        val state = ClientPushPreferencesStore.preferences.value

        assertTrue(state.enabled)
        assertTrue(state.orderConfirmed)
        assertTrue(state.orderDelivering)
        assertTrue(state.orderNearby)
        assertTrue(state.orderDelivered)
    }

    @Test
    fun `updateFromPreferences sincroniza correctamente`() {
        ClientPushPreferencesStore.clear()
        val prefs = ClientPreferences(
            pushNotificationsEnabled = false,
            pushOrderConfirmed = true,
            pushOrderDelivering = false,
            pushOrderNearby = true,
            pushOrderDelivered = false
        )

        ClientPushPreferencesStore.updateFromPreferences(prefs)
        val state = ClientPushPreferencesStore.preferences.value

        assertFalse(state.enabled)
        assertTrue(state.orderConfirmed)
        assertFalse(state.orderDelivering)
        assertTrue(state.orderNearby)
        assertFalse(state.orderDelivered)
    }

    @Test
    fun `toggleEnabled cambia el estado global de push`() {
        ClientPushPreferencesStore.clear()

        ClientPushPreferencesStore.toggleEnabled(false)

        assertFalse(ClientPushPreferencesStore.preferences.value.enabled)
    }

    @Test
    fun `toggleOrderConfirmed cambia preferencia individual`() {
        ClientPushPreferencesStore.clear()

        ClientPushPreferencesStore.toggleOrderConfirmed(false)

        assertFalse(ClientPushPreferencesStore.preferences.value.orderConfirmed)
    }

    @Test
    fun `toggleOrderDelivering cambia preferencia individual`() {
        ClientPushPreferencesStore.clear()

        ClientPushPreferencesStore.toggleOrderDelivering(false)

        assertFalse(ClientPushPreferencesStore.preferences.value.orderDelivering)
    }

    @Test
    fun `toggleOrderNearby cambia preferencia individual`() {
        ClientPushPreferencesStore.clear()

        ClientPushPreferencesStore.toggleOrderNearby(false)

        assertFalse(ClientPushPreferencesStore.preferences.value.orderNearby)
    }

    @Test
    fun `toggleOrderDelivered cambia preferencia individual`() {
        ClientPushPreferencesStore.clear()

        ClientPushPreferencesStore.toggleOrderDelivered(false)

        assertFalse(ClientPushPreferencesStore.preferences.value.orderDelivered)
    }

    @Test
    fun `toPreferencesUpdate genera preferencias con estado actual del store`() {
        ClientPushPreferencesStore.clear()
        ClientPushPreferencesStore.toggleEnabled(true)
        ClientPushPreferencesStore.toggleOrderNearby(false)
        val base = ClientPreferences(language = "es")

        val result = ClientPushPreferencesStore.toPreferencesUpdate(base)

        assertEquals("es", result.language)
        assertTrue(result.pushNotificationsEnabled)
        assertTrue(result.pushOrderConfirmed)
        assertTrue(result.pushOrderDelivering)
        assertFalse(result.pushOrderNearby)
        assertTrue(result.pushOrderDelivered)
    }

    @Test
    fun `clear restaura el estado por defecto`() {
        ClientPushPreferencesStore.toggleEnabled(false)
        ClientPushPreferencesStore.toggleOrderConfirmed(false)

        ClientPushPreferencesStore.clear()
        val state = ClientPushPreferencesStore.preferences.value

        assertTrue(state.enabled)
        assertTrue(state.orderConfirmed)
    }
}
