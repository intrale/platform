package asdo.business

import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.business.AnalyzeProductPhotoResponse
import ext.business.CommAnalyzeProductPhotoService
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DoAnalyzeProductPhotoTest {

    private fun fakeService(result: Result<AnalyzeProductPhotoResponse>) =
        object : CommAnalyzeProductPhotoService {
            override suspend fun analyzePhoto(
                businessId: String,
                imageBase64: String,
                mediaType: String,
                existingCategories: List<String>
            ) = result
        }

    @Test
    fun `analisis exitoso retorna sugerencias de producto`() = runTest {
        val response = AnalyzeProductPhotoResponse(
            statusCode = StatusCodeDTO(200, "OK"),
            suggestedName = "Medialunas",
            suggestedDescription = "Medialunas de manteca artesanales",
            suggestedCategory = "Panaderia",
            confidence = 0.92
        )
        val sut = DoAnalyzeProductPhoto(fakeService(Result.success(response)))

        val result = sut.execute(
            businessId = "miNegocio",
            imageBase64 = "base64data",
            mediaType = "image/jpeg",
            existingCategories = listOf("Panaderia", "Bebidas")
        )

        assertTrue(result.isSuccess)
        assertEquals("Medialunas", result.getOrThrow().suggestedName)
        assertEquals("Panaderia", result.getOrThrow().suggestedCategory)
        assertEquals(0.92, result.getOrThrow().confidence)
    }

    @Test
    fun `analisis fallido retorna error`() = runTest {
        val sut = DoAnalyzeProductPhoto(
            fakeService(Result.failure(RuntimeException("API no disponible")))
        )

        val result = sut.execute(
            businessId = "miNegocio",
            imageBase64 = "base64data",
            mediaType = "image/jpeg",
            existingCategories = emptyList()
        )

        assertTrue(result.isFailure)
    }
}
