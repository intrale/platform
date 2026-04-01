package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PromoSuggestionRepositoryTest {

    private val repository = PromoSuggestionRepository()

    @Test
    fun `guardar y recuperar sugerencia de promo`() {
        val suggestion = PromoSuggestion(
            productId = "prod-1",
            productName = "Pan lactal",
            promoType = "DISCOUNT_PERCENT",
            discountPercent = 20,
            promoText = "Pan lactal con 20% OFF!",
            reason = "Sin ventas hace 10 dias",
            daysSinceLastSale = 10,
            createdAt = "2026-03-31T10:00:00Z"
        )

        val saved = repository.save("panaderia", suggestion)

        assertTrue(saved.id.isNotBlank())
        assertEquals("panaderia", saved.businessId)
        assertEquals("Pan lactal", saved.productName)

        val retrieved = repository.get("panaderia", saved.id)
        assertNotNull(retrieved)
        assertEquals(saved.id, retrieved.id)
        assertEquals("PENDING", retrieved.status)
    }

    @Test
    fun `listar sugerencias pendientes`() {
        repository.save("panaderia", PromoSuggestion(
            productId = "p1", productName = "Producto 1", status = "PENDING", createdAt = "2026-03-31T10:00:00Z"
        ))
        repository.save("panaderia", PromoSuggestion(
            productId = "p2", productName = "Producto 2", status = "APPROVED", createdAt = "2026-03-31T10:00:00Z"
        ))
        repository.save("panaderia", PromoSuggestion(
            productId = "p3", productName = "Producto 3", status = "PENDING", createdAt = "2026-03-31T10:00:00Z"
        ))

        val pending = repository.listPending("panaderia")

        assertEquals(2, pending.size)
        assertTrue(pending.all { it.status == "PENDING" })
    }

    @Test
    fun `actualizar estado de sugerencia`() {
        val saved = repository.save("panaderia", PromoSuggestion(
            productId = "p1", productName = "Producto 1", createdAt = "2026-03-31T10:00:00Z"
        ))

        val updated = repository.updateStatus("panaderia", saved.id, "APPROVED")

        assertNotNull(updated)
        assertEquals("APPROVED", updated.status)
    }

    @Test
    fun `retorna null al actualizar sugerencia inexistente`() {
        val result = repository.updateStatus("panaderia", "inexistente", "APPROVED")
        assertNull(result)
    }

    @Test
    fun `listar por negocio no mezcla negocios`() {
        repository.save("panaderia", PromoSuggestion(
            productId = "p1", productName = "Pan", createdAt = "2026-03-31T10:00:00Z"
        ))
        repository.save("heladeria", PromoSuggestion(
            productId = "p2", productName = "Helado", createdAt = "2026-03-31T10:00:00Z"
        ))

        val panaderiaItems = repository.listByBusiness("panaderia")
        assertEquals(1, panaderiaItems.size)
        assertEquals("Pan", panaderiaItems.first().productName)
    }
}
