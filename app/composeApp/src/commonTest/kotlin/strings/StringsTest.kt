@file:Suppress("DEPRECATION_ERROR")

package ar.com.intrale.strings

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class StringsTest {

    private val esCatalog: LangBundle = mapOf(
        StringKey.App_Name to "Intrale",
        StringKey.Login_Title to "Iniciar sesión",
        StringKey.Login_Button to "Entrar",
        StringKey.Error_Generic to "Ocurrió un error",
    )

    private val brandOverrideCatalog: LangBundle = mapOf(
        StringKey.App_Name to "MiMarca",
    )

    private val testCatalog = StringCatalog(
        defaultsByLang = mapOf(Lang("es") to esCatalog),
        brandOverrides = mapOf(BrandId("marca1") to mapOf(Lang("es") to brandOverrideCatalog)),
    )

    // ── StringCatalog ───────────────────────────────────────────────

    @Test
    fun `StringCatalog resolve retorna valor por defecto`() {
        val result = testCatalog.resolve(StringKey.Login_Title, brand = null, lang = Lang("es"))
        assertEquals("Iniciar sesión", result)
    }

    @Test
    fun `StringCatalog resolve retorna override de marca`() {
        val result = testCatalog.resolve(
            StringKey.App_Name,
            brand = BrandId("marca1"),
            lang = Lang("es"),
        )
        assertEquals("MiMarca", result)
    }

    // ── Strings (object) ────────────────────────────────────────────

    @Test
    fun `Strings t retorna fallback cuando no hay catalogo`() {
        Strings.setCatalog(StringCatalog(defaultsByLang = emptyMap()))
        Strings.setLang(Lang("es"))
        Strings.setBrand(null)

        val result = Strings.t(StringKey.App_Name)

        assertEquals("⟪App_Name⟫", result)
    }

    @Test
    fun `Strings t resuelve clave correctamente`() {
        Strings.setCatalog(testCatalog)
        Strings.setLang(Lang("es"))
        Strings.setBrand(null)

        val result = Strings.t(StringKey.Login_Button)

        assertEquals("Entrar", result)
    }

    @Test
    fun `Strings t con args interpola parametros`() {
        val catalogWithTemplate = StringCatalog(
            defaultsByLang = mapOf(
                Lang("es") to mapOf(
                    StringKey.Error_Generic to "Error: {{detalle}} (código {{codigo}})",
                ),
            ),
        )
        Strings.setCatalog(catalogWithTemplate)
        Strings.setLang(Lang("es"))
        Strings.setBrand(null)

        val result = Strings.t(
            StringKey.Error_Generic,
            args = mapOf("detalle" to "timeout", "codigo" to "504"),
        )

        assertEquals("Error: timeout (código 504)", result)
    }
}
