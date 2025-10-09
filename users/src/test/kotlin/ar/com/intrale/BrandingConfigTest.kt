package ar.com.intrale

import com.google.gson.Gson
import kotlinx.coroutines.runBlocking
import org.slf4j.LoggerFactory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BrandingConfigTest {

    private val logger = LoggerFactory.getLogger("BrandingConfigTest")
    private val repository = BrandingConfigRepository()
    private val gson = Gson()
    private val function = BrandingConfig(repository, logger, gson)

    @Test
    fun `fetch devuelve tema por defecto cuando no existe configuracion`() = runBlocking {
        val response = function.execute("demo", "branding", emptyMap(), "")
        assertTrue(response is BrandingConfigResponse)
        assertEquals("Inter", response.theme.typography)
    }

    @Test
    fun `update persiste configuracion y se recupera en solicitudes posteriores`() = runBlocking {
        val request = BrandingConfigRequest(
            operation = BrandingConfigOperation.Update,
            theme = BrandingThemePayload(
                typography = "Roboto",
                palette = BrandingPalettePayload(
                    primary = "#111111",
                    secondary = "#222222",
                    background = "#f5f5f5"
                ),
                assets = BrandingAssetsPayload(
                    logoUrl = "logo.png",
                    splashImageUrl = null
                )
            )
        )

        val updateResponse = function.execute(
            business = "demo",
            function = "branding",
            headers = emptyMap(),
            textBody = gson.toJson(request)
        )
        assertTrue(updateResponse is BrandingConfigResponse)
        assertEquals("Roboto", updateResponse.theme.typography)

        val fetchResponse = function.execute("demo", "branding", emptyMap(), "")
        assertTrue(fetchResponse is BrandingConfigResponse)
        assertEquals("Roboto", fetchResponse.theme.typography)
        assertEquals("#111111", fetchResponse.theme.palette.primary)
    }
}
