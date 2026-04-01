package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SearchHistoryRepositoryTest {

    private val repository = SearchHistoryRepository()

    @Test
    fun `getHistory retorna lista vacia cuando no hay historial`() {
        val history = repository.getHistory("user@test.com", "negocio")
        assertTrue(history.isEmpty())
    }

    @Test
    fun `addSearch agrega una busqueda al historial`() {
        repository.addSearch("user@test.com", "negocio", "asado")
        val history = repository.getHistory("user@test.com", "negocio")
        assertEquals(1, history.size)
        assertEquals("asado", history.first().query)
    }

    @Test
    fun `addSearch pone la busqueda mas reciente primero`() {
        repository.addSearch("user@test.com", "negocio", "chorizo")
        repository.addSearch("user@test.com", "negocio", "asado")
        val history = repository.getHistory("user@test.com", "negocio")
        assertEquals(2, history.size)
        assertEquals("asado", history[0].query)
        assertEquals("chorizo", history[1].query)
    }

    @Test
    fun `addSearch elimina duplicados y los mueve al inicio`() {
        repository.addSearch("user@test.com", "negocio", "chorizo")
        repository.addSearch("user@test.com", "negocio", "asado")
        repository.addSearch("user@test.com", "negocio", "chorizo") // duplicado
        val history = repository.getHistory("user@test.com", "negocio")
        assertEquals(2, history.size)
        assertEquals("chorizo", history[0].query)
        assertEquals("asado", history[1].query)
    }

    @Test
    fun `addSearch mantiene maximo 10 entradas`() {
        for (i in 1..15) {
            repository.addSearch("user@test.com", "negocio", "busqueda $i")
        }
        val history = repository.getHistory("user@test.com", "negocio")
        assertEquals(SearchHistoryRepository.MAX_HISTORY_SIZE, history.size)
        // La más reciente es la última agregada
        assertEquals("busqueda 15", history.first().query)
    }

    @Test
    fun `addSearch ignora queries en blanco`() {
        repository.addSearch("user@test.com", "negocio", "  ")
        val history = repository.getHistory("user@test.com", "negocio")
        assertTrue(history.isEmpty())
    }

    @Test
    fun `addSearch trimea la query`() {
        repository.addSearch("user@test.com", "negocio", "  asado  ")
        val history = repository.getHistory("user@test.com", "negocio")
        assertEquals("asado", history.first().query)
    }

    @Test
    fun `clearHistory elimina todo el historial del usuario`() {
        repository.addSearch("user@test.com", "negocio", "asado")
        repository.addSearch("user@test.com", "negocio", "chorizo")
        repository.clearHistory("user@test.com", "negocio")
        val history = repository.getHistory("user@test.com", "negocio")
        assertTrue(history.isEmpty())
    }

    @Test
    fun `historiales de distintos usuarios son independientes`() {
        repository.addSearch("user1@test.com", "negocio", "asado")
        repository.addSearch("user2@test.com", "negocio", "chorizo")
        val history1 = repository.getHistory("user1@test.com", "negocio")
        val history2 = repository.getHistory("user2@test.com", "negocio")
        assertEquals(1, history1.size)
        assertEquals("asado", history1.first().query)
        assertEquals(1, history2.size)
        assertEquals("chorizo", history2.first().query)
    }

    @Test
    fun `historiales de distintos negocios son independientes`() {
        repository.addSearch("user@test.com", "negocio1", "asado")
        repository.addSearch("user@test.com", "negocio2", "chorizo")
        val history1 = repository.getHistory("user@test.com", "negocio1")
        val history2 = repository.getHistory("user@test.com", "negocio2")
        assertEquals(1, history1.size)
        assertEquals("asado", history1.first().query)
        assertEquals(1, history2.size)
        assertEquals("chorizo", history2.first().query)
    }

    @Test
    fun `clearHistory no afecta otros usuarios`() {
        repository.addSearch("user1@test.com", "negocio", "asado")
        repository.addSearch("user2@test.com", "negocio", "chorizo")
        repository.clearHistory("user1@test.com", "negocio")
        val history1 = repository.getHistory("user1@test.com", "negocio")
        val history2 = repository.getHistory("user2@test.com", "negocio")
        assertTrue(history1.isEmpty())
        assertEquals(1, history2.size)
    }

    @Test
    fun `addSearch con duplicado case-insensitive elimina el anterior`() {
        repository.addSearch("user@test.com", "negocio", "Asado")
        repository.addSearch("user@test.com", "negocio", "asado")
        val history = repository.getHistory("user@test.com", "negocio")
        assertEquals(1, history.size)
        assertEquals("asado", history.first().query)
    }
}
