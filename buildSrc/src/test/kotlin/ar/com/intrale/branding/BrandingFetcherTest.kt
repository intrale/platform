package ar.com.intrale.branding

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class BrandingFetcherTest {

    private val sampleJson = """
        {
          "version": 1,
          "schemaVersion": 0,
          "payload": {
            "appName": "Intrale"
          }
        }
    """.trimIndent()

    @Test
    fun `compone la url agregando brandId y preview cuando corresponde`() {
        val capturedUrls = mutableListOf<String>()

        val result = fetchBrandingEnvelope(
            endpoint = "https://branding.intrale.dev/api/brands",
            brandId = "intrale",
            previewVersion = "beta-1",
            httpFetcher = { url, _, _ ->
                capturedUrls += url
                BrandingHttpResponse(code = 200, body = sampleJson, successful = true)
            }
        )

        assertEquals("Intrale", result.envelope.payload.appName)
        assertEquals(sampleJson, result.rawJson)
        assertEquals(
            listOf("https://branding.intrale.dev/api/brands/intrale?previewVersion=beta-1"),
            capturedUrls,
            "La URL debe incluir brandId y previewVersion"
        )
    }

    @Test
    fun `reemplaza placeholders de brandId y escapa el preview`() {
        val capturedUrls = mutableListOf<String>()

        fetchBrandingEnvelope(
            endpoint = "https://branding.dev/brands/{brandId}",
            brandId = "intrale",
            previewVersion = "QA sprint/1",
            httpFetcher = { url, _, _ ->
                capturedUrls += url
                BrandingHttpResponse(code = 200, body = sampleJson, successful = true)
            }
        )

        assertEquals(1, capturedUrls.size)
        val expectedPreview = URLEncoder.encode("QA sprint/1", StandardCharsets.UTF_8)
        assertEquals(
            "https://branding.dev/brands/intrale?previewVersion=$expectedPreview",
            capturedUrls.first(),
            "La URL debe interpolar el brandId y codificar el preview"
        )
    }

    @Test
    fun `lanza excepcion ante respuestas no exitosas`() {
        val error = assertFailsWith<IllegalStateException> {
            fetchBrandingEnvelope(
                endpoint = "https://branding.dev/brands",
                brandId = "intrale",
                httpFetcher = { _, _, _ ->
                    BrandingHttpResponse(code = 503, body = "", successful = false)
                }
            )
        }

        assertTrue(error.message?.contains("Respuesta inválida") == true)
    }
}
