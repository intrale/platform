package ar.com.intrale.strings

import ar.com.intrale.strings.catalog.DefaultCatalog_en
import ar.com.intrale.strings.catalog.DefaultCatalog_es
import ar.com.intrale.strings.model.MessageKey
import kotlin.test.Test
import kotlin.test.assertTrue

class CatalogParityTest {
    @Test
    fun `todas las keys tienen traduccion en ES y EN`() {
        val es = DefaultCatalog_es.entries.keys.map { it.name }.toSet()
        val en = DefaultCatalog_en.entries.keys.map { it.name }.toSet()
        val all = MessageKey.entries.map { it.name }.toSet()

        val faltanEnEs = all - es
        val faltanEnEn = all - en

        assertTrue(faltanEnEs.isEmpty(), "Faltan en ES: $faltanEnEs")
        assertTrue(faltanEnEn.isEmpty(), "Faltan en EN: $faltanEnEn")
    }
}
