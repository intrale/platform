package ar.com.intrale.i18nscan.codemod

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class GetStringToTxtCodemodTest {

    @Test
    fun `reemplaza getString con un unico argumento adicional`() {
        val source = """
            fun example(context: Context) {
                val text = context.getString(R.string.welcome_user, userName)
                println(text)
            }
        """.trimIndent()

        val result = transformContent(source)

        val expected = """
            fun example(context: Context) {
                val text = Txt(MessageKey.welcome_user, mapOf("userName" to userName))
                println(text)
            }
        """.trimIndent()

        assertEquals(expected, result.content)
        assertEquals(1, result.replacements.size)
        assertEquals(listOf("userName"), result.replacements.single().parameterNames)
    }

    @Test
    fun `reemplaza llamadas multilinea con multiples argumentos`() {
        val source = """
            fun render(resources: Resources) {
                val summary = resources.getString(
                    R.string.summary_template,
                    count,
                    total
                )
                println(summary)
            }
        """.trimIndent()

        val result = transformContent(source)

        val expected = """
            fun render(resources: Resources) {
                val summary = Txt(MessageKey.summary_template, mapOf("count" to count, "total" to total))
                println(summary)
            }
        """.trimIndent()

        assertEquals(expected, result.content)
        assertEquals(1, result.replacements.size)
        assertEquals(listOf("count", "total"), result.replacements.single().parameterNames)
    }

    @Test
    fun `mantiene llamadas sin argumentos de formato`() {
        val source = """
            fun legacy(context: Context) = context.getString(R.string.simple_value)
        """.trimIndent()

        val result = transformContent(source)

        assertTrue(result.content.contains("Txt(MessageKey.simple_value)"))
        assertEquals(1, result.replacements.size)
        assertTrue(result.replacements.single().parameterNames.isEmpty())
    }

    @Test
    fun `omite variantes con argumentos complejos`() {
        val source = """
            fun sample(context: Context) = context.getString(R.string.sample, formatArgs = arrayOf(value))
        """.trimIndent()

        val result = transformContent(source)

        assertEquals(source, result.content)
        assertTrue(result.replacements.isEmpty())
    }

    @Test
    fun `usa nombres argN cuando no puede inferir identificador`() {
        val source = """
            fun render(context: Context) = context.getString(R.string.sample, user.fullName)
        """.trimIndent()

        val result = transformContent(source)

        assertTrue(result.content.contains("mapOf(\"fullName\" to user.fullName)"))
        assertEquals(listOf("fullName"), result.replacements.single().parameterNames)
    }
}
