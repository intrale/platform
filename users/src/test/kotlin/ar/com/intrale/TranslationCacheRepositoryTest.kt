package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TranslationCacheRepositoryTest {

    private val cache = TranslationCacheRepository()

    @Test
    fun `almacena y recupera traduccion correctamente`() {
        cache.put(
            business = "panaderia",
            productId = "prod-1",
            field = "name",
            locale = "en",
            originalText = "Empanadas",
            translatedText = "Empanadas",
            sourceLocale = "es"
        )

        val result = cache.get("panaderia", "prod-1", "name", "en")
        assertNotNull(result)
        assertEquals("Empanadas", result)
    }

    @Test
    fun `retorna null cuando no hay cache`() {
        val result = cache.get("panaderia", "prod-1", "name", "en")
        assertNull(result)
    }

    @Test
    fun `putProductTranslation almacena nombre y descripcion`() {
        cache.putProductTranslation(
            business = "panaderia",
            productId = "prod-1",
            locale = "en",
            originalName = "Medialunas",
            translatedName = "Croissants",
            originalDescription = "Medialunas de manteca",
            translatedDescription = "Butter croissants"
        )

        val (name, desc) = cache.getProductTranslation("panaderia", "prod-1", "en")
        assertEquals("Croissants", name)
        assertEquals("Butter croissants", desc)
    }

    @Test
    fun `hasTranslation retorna true cuando existe traduccion`() {
        cache.putProductTranslation(
            business = "panaderia",
            productId = "prod-1",
            locale = "en",
            originalName = "Pan",
            translatedName = "Bread",
            originalDescription = null,
            translatedDescription = null
        )

        assertTrue(cache.hasTranslation("panaderia", "prod-1", "en"))
        assertFalse(cache.hasTranslation("panaderia", "prod-1", "pt"))
        assertFalse(cache.hasTranslation("panaderia", "prod-2", "en"))
    }

    @Test
    fun `size retorna cantidad correcta de entradas`() {
        assertEquals(0, cache.size())

        cache.put("biz", "p1", "name", "en", "original", "translated")
        assertEquals(1, cache.size())

        cache.put("biz", "p1", "desc", "en", "original desc", "translated desc")
        assertEquals(2, cache.size())
    }

    @Test
    fun `key es case insensitive para business`() {
        cache.put("PaNaDeRia", "prod-1", "name", "en", "Empanadas", "Empanadas")
        val result = cache.get("panaderia", "prod-1", "name", "en")
        assertNotNull(result)
    }

    @Test
    fun `key es case insensitive para locale`() {
        cache.put("panaderia", "prod-1", "name", "EN", "Empanadas", "Empanadas")
        val result = cache.get("panaderia", "prod-1", "name", "en")
        assertNotNull(result)
    }

    @Test
    fun `descripcion null no se almacena`() {
        cache.putProductTranslation(
            business = "panaderia",
            productId = "prod-1",
            locale = "en",
            originalName = "Pan",
            translatedName = "Bread",
            originalDescription = null,
            translatedDescription = null
        )

        val (name, desc) = cache.getProductTranslation("panaderia", "prod-1", "en")
        assertEquals("Bread", name)
        assertNull(desc)
    }
}
