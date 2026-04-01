package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class DailyMenuRepositoryTest {
    private val repository = DailyMenuRepository()

    @Test
    fun `almacenar y recuperar sugerencia por negocio`() {
        val suggestion = DailyMenuSuggestion(
            businessName = "pizzeria",
            title = "Pizza del dia",
            items = listOf(DailyMenuItem(productId = "p1", productName = "Muzzarella")),
            status = "PENDING"
        )

        repository.storeSuggestion("pizzeria", suggestion)
        val retrieved = repository.getLatestSuggestion("pizzeria")

        assertNotNull(retrieved)
        assertEquals("Pizza del dia", retrieved.title)
        assertEquals("PENDING", retrieved.status)
    }

    @Test
    fun `recuperar por ID`() {
        val suggestion = repository.storeSuggestion("pizzeria", DailyMenuSuggestion(
            businessName = "pizzeria",
            title = "Menu A"
        ))

        val retrieved = repository.getSuggestionById("pizzeria", suggestion.id)

        assertNotNull(retrieved)
        assertEquals(suggestion.id, retrieved.id)
    }

    @Test
    fun `actualizar estado de sugerencia`() {
        val suggestion = repository.storeSuggestion("pizzeria", DailyMenuSuggestion(
            businessName = "pizzeria",
            title = "Menu B",
            status = "PENDING"
        ))

        val updated = repository.updateSuggestionStatus("pizzeria", suggestion.id, "APPROVED")

        assertNotNull(updated)
        assertEquals("APPROVED", updated.status)
    }

    @Test
    fun `actualizar estado de sugerencia inexistente retorna null`() {
        val result = repository.updateSuggestionStatus("pizzeria", "no-existe", "APPROVED")

        assertNull(result)
    }

    @Test
    fun `contar sugerencias del dia`() {
        repository.storeSuggestion("pizzeria", DailyMenuSuggestion(businessName = "pizzeria"))
        repository.storeSuggestion("pizzeria", DailyMenuSuggestion(businessName = "pizzeria"))

        val count = repository.countTodaySuggestions("pizzeria")

        assertEquals(2, count)
    }

    @Test
    fun `negocio sin sugerencias retorna null`() {
        val result = repository.getLatestSuggestion("inexistente")

        assertNull(result)
    }

    @Test
    fun `menus aprobados recientes filtra por estado y dias`() {
        val approved = repository.storeSuggestion("pizzeria", DailyMenuSuggestion(
            businessName = "pizzeria",
            title = "Menu aprobado",
            status = "APPROVED"
        ))
        repository.updateSuggestionStatus("pizzeria", approved.id, "APPROVED")

        repository.storeSuggestion("pizzeria", DailyMenuSuggestion(
            businessName = "pizzeria",
            title = "Menu pendiente",
            status = "PENDING"
        ))

        val recentApproved = repository.getRecentApprovedMenus("pizzeria")

        assertEquals(1, recentApproved.size)
        assertEquals("Menu aprobado", recentApproved.first().title)
    }
}
