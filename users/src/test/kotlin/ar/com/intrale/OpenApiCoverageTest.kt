package ar.com.intrale

import java.io.File
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Núcleo anti-drift de CA-2 (#4300): verifica que TODO tag `bind<Function>(tag="...")` de
 * Modules.kt esté presente como path en la spec `resources/openapi.yaml`. Falla si falta uno,
 * forzando a mantener la spec sincronizada con la fuente de verdad (Modules.kt).
 */
class OpenApiCoverageTest {

    private fun readModulesSource(): String {
        val candidates = listOf(
            "src/main/kotlin/ar/com/intrale/Modules.kt",
            "users/src/main/kotlin/ar/com/intrale/Modules.kt",
            "../users/src/main/kotlin/ar/com/intrale/Modules.kt"
        )
        val file = candidates.map { File(it) }.firstOrNull { it.exists() }
        assertNotNull(file, "No se encontró Modules.kt (cwd=${File(".").absolutePath}); candidatos: $candidates")
        return file.readText()
    }

    private fun functionTags(source: String): List<String> {
        val regex = Regex("""bind<Function>\s*\(tag\s*=\s*"([^"]+)"\)""")
        return regex.findAll(source).map { it.groupValues[1] }.toList()
    }

    private fun openApiSpec(): String {
        val resource = this::class.java.classLoader.getResource("openapi.yaml")
        assertNotNull(resource, "No se encontró openapi.yaml en el classpath")
        return resource.readText()
    }

    @Test
    fun `todos los tags de Modules estan cubiertos en la spec OpenAPI`() {
        val tags = functionTags(readModulesSource())
        assertTrue(tags.size >= 45, "Se esperaban al menos 45 tags, se encontraron ${tags.size}")

        val spec = openApiSpec()
        val missing = tags.filter { tag -> !spec.contains("/{business}/$tag:") }

        if (missing.isNotEmpty()) {
            fail(
                "La spec OpenAPI (resources/openapi.yaml) no cubre ${missing.size} endpoint(s) " +
                    "registrados en Modules.kt: $missing. Regenerar la spec (gen-openapi.js) o agregarlos a mano."
            )
        }
    }

    @Test
    fun `la spec declara el esquema bearerAuth y servidor no productivo`() {
        val spec = openApiSpec()
        assertTrue(spec.contains("bearerAuth"), "la spec debe documentar el esquema bearerAuth (CA-S2/S5)")
        assertTrue(spec.contains("localhost"), "la spec debe declarar un server no productivo (CA-S2)")
    }
}
