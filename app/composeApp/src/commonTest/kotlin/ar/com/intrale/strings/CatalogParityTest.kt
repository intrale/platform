package ar.com.intrale.strings

import ar.com.intrale.strings.catalog.DefaultCatalog_en
import ar.com.intrale.strings.catalog.DefaultCatalog_es
import ar.com.intrale.strings.model.MessageKey
import kotlin.test.Test
import kotlin.test.assertTrue

class CatalogParityTest {

    // Si hay claves que querés ignorar explícitamente, agregalas acá
    private val EXCLUDED_KEYS = emptySet<String>()

    @Test
    fun `todas las keys tienen traduccion en ES y EN`() {
        // Tomamos los nombres de las keys de cada catálogo (son Map<MessageKey, String>)
        val es: Set<String> = DefaultCatalog_es.keys.map { it.name }.toSet() - EXCLUDED_KEYS
        val en: Set<String> = DefaultCatalog_en.keys.map { it.name }.toSet() - EXCLUDED_KEYS

        // Lista canónica: todos los MessageKey definidos
        // (si tu compilador soporta .entries, podés usar MessageKey.entries.map { it.name })
        val all: Set<String> = enumValues<MessageKey>().map { it.name }.toSet() - EXCLUDED_KEYS

        val faltanEnEs = (all - es).sorted()
        val faltanEnEn = (all - en).sorted()
        val sobranEnEs = (es - all).sorted()
        val sobranEnEn = (en - all).sorted()

        val resumen = buildString {
            appendLine("Paridad de catálogos")
            appendLine(" - Total MessageKey: ${all.size}")
            appendLine(" - ES: ${es.size} | EN: ${en.size}")
            if (faltanEnEs.isNotEmpty()) appendLine("⛔ Faltan en ES: ${faltanEnEs.joinToString()}")
            if (faltanEnEn.isNotEmpty()) appendLine("⛔ Faltan en EN: ${faltanEnEn.joinToString()}")
            if (sobranEnEs.isNotEmpty()) appendLine("⚠️  Sobran en ES (no están en MessageKey): ${sobranEnEs.joinToString()}")
            if (sobranEnEn.isNotEmpty()) appendLine("⚠️  Sobran en EN (no están en MessageKey): ${sobranEnEn.joinToString()}")
            if (faltanEnEs.isEmpty() && faltanEnEn.isEmpty() && sobranEnEs.isEmpty() && sobranEnEn.isEmpty()) {
                append("✅ Paridad OK")
            }
        }

        println(resumen)

        assertTrue(
            faltanEnEs.isEmpty() && faltanEnEn.isEmpty() && sobranEnEs.isEmpty() && sobranEnEn.isEmpty(),
            resumen
        )
    }
}
