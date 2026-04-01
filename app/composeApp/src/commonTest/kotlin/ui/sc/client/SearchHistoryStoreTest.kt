package ui.sc.client

import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SearchHistoryStoreTest {

    @BeforeTest
    fun setUp() {
        SearchHistoryStore.clearHistory()
    }

    @Test
    fun `addSearch agrega query al historial`() {
        SearchHistoryStore.addSearch("manzana")

        assertEquals(listOf("manzana"), SearchHistoryStore.history.value)
    }

    @Test
    fun `addSearch ignora queries con menos de 2 caracteres`() {
        SearchHistoryStore.addSearch("m")

        assertTrue(SearchHistoryStore.history.value.isEmpty())
    }

    @Test
    fun `addSearch ignora queries vacios`() {
        SearchHistoryStore.addSearch("")
        SearchHistoryStore.addSearch(" ")

        assertTrue(SearchHistoryStore.history.value.isEmpty())
    }

    @Test
    fun `addSearch mueve duplicados al tope`() {
        SearchHistoryStore.addSearch("manzana")
        SearchHistoryStore.addSearch("banana")
        SearchHistoryStore.addSearch("manzana")

        assertEquals(listOf("manzana", "banana"), SearchHistoryStore.history.value)
    }

    @Test
    fun `addSearch limita a 10 entradas`() {
        repeat(12) { i ->
            SearchHistoryStore.addSearch("query-$i")
        }

        assertEquals(10, SearchHistoryStore.history.value.size)
        assertEquals("query-11", SearchHistoryStore.history.value.first())
    }

    @Test
    fun `addSearch hace trim del query`() {
        SearchHistoryStore.addSearch("  manzana  ")

        assertEquals(listOf("manzana"), SearchHistoryStore.history.value)
    }

    @Test
    fun `removeSearch elimina query especifico`() {
        SearchHistoryStore.addSearch("manzana")
        SearchHistoryStore.addSearch("banana")

        SearchHistoryStore.removeSearch("manzana")

        assertEquals(listOf("banana"), SearchHistoryStore.history.value)
    }

    @Test
    fun `removeSearch con query inexistente no cambia nada`() {
        SearchHistoryStore.addSearch("manzana")

        SearchHistoryStore.removeSearch("inexistente")

        assertEquals(listOf("manzana"), SearchHistoryStore.history.value)
    }

    @Test
    fun `clearHistory vacia todo el historial`() {
        SearchHistoryStore.addSearch("manzana")
        SearchHistoryStore.addSearch("banana")

        SearchHistoryStore.clearHistory()

        assertTrue(SearchHistoryStore.history.value.isEmpty())
    }

    @Test
    fun `filteredHistory sin prefijo retorna todo`() {
        SearchHistoryStore.addSearch("manzana")
        SearchHistoryStore.addSearch("banana")

        val result = SearchHistoryStore.filteredHistory()

        assertEquals(2, result.size)
    }

    @Test
    fun `filteredHistory con prefijo filtra correctamente`() {
        SearchHistoryStore.addSearch("manzana roja")
        SearchHistoryStore.addSearch("banana")
        SearchHistoryStore.addSearch("mandarina")

        val result = SearchHistoryStore.filteredHistory("man")

        assertEquals(2, result.size)
        assertTrue(result.contains("manzana roja"))
        assertTrue(result.contains("mandarina"))
    }

    @Test
    fun `filteredHistory con prefijo en blanco retorna todo`() {
        SearchHistoryStore.addSearch("manzana")
        SearchHistoryStore.addSearch("banana")

        val result = SearchHistoryStore.filteredHistory("  ")

        assertEquals(2, result.size)
    }

    @Test
    fun `filteredHistory es case-insensitive`() {
        SearchHistoryStore.addSearch("Manzana")

        val result = SearchHistoryStore.filteredHistory("manzana")

        assertEquals(1, result.size)
        assertEquals("Manzana", result[0])
    }
}
