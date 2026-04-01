package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PhotoQualityServiceTest {

    private val service = ClaudePhotoQualityService(apiKey = "")

    @Test
    fun `sin API key retorna evaluacion por defecto con issues`() {
        val result = kotlinx.coroutines.runBlocking {
            service.evaluatePhoto(
                imageBase64 = "dGVzdA==",
                mediaType = "image/jpeg",
                productName = "Pizza"
            )
        }

        assertEquals(PhotoQualityLevel.BAD, result.quality)
        assertEquals(0.0, result.overallScore)
        assertTrue(result.issues.isNotEmpty())
        assertTrue(result.issues.first().contains("no se pudo evaluar", ignoreCase = true))
    }

    @Test
    fun `parsePhotoQualityResponse parsea JSON valido con calidad buena`() {
        val json = """{
            "overall_score": 0.85,
            "quality": "GOOD",
            "issues": [],
            "recommendations": []
        }"""

        val result = service.parsePhotoQualityResponse(json)

        assertEquals(0.85, result.overallScore)
        assertEquals(PhotoQualityLevel.GOOD, result.quality)
        assertTrue(result.issues.isEmpty())
        assertTrue(result.recommendations.isEmpty())
    }

    @Test
    fun `parsePhotoQualityResponse parsea JSON con calidad mejorable`() {
        val json = """{
            "overall_score": 0.55,
            "quality": "IMPROVABLE",
            "issues": ["La foto esta un poco oscura"],
            "recommendations": ["Proba con mas luz natural"]
        }"""

        val result = service.parsePhotoQualityResponse(json)

        assertEquals(0.55, result.overallScore)
        assertEquals(PhotoQualityLevel.IMPROVABLE, result.quality)
        assertEquals(1, result.issues.size)
        assertEquals("La foto esta un poco oscura", result.issues.first())
        assertEquals(1, result.recommendations.size)
    }

    @Test
    fun `parsePhotoQualityResponse parsea JSON con calidad mala`() {
        val json = """{
            "overall_score": 0.2,
            "quality": "BAD",
            "issues": ["Foto borrosa", "Sin iluminacion"],
            "recommendations": ["Usa un tripode", "Agrega luz natural"]
        }"""

        val result = service.parsePhotoQualityResponse(json)

        assertEquals(0.2, result.overallScore)
        assertEquals(PhotoQualityLevel.BAD, result.quality)
        assertEquals(2, result.issues.size)
        assertEquals(2, result.recommendations.size)
    }

    @Test
    fun `parsePhotoQualityResponse extrae JSON de bloque markdown`() {
        val markdown = """```json
{
    "overall_score": 0.9,
    "quality": "GOOD",
    "issues": [],
    "recommendations": []
}
```"""

        val result = service.parsePhotoQualityResponse(markdown)

        assertEquals(0.9, result.overallScore)
        assertEquals(PhotoQualityLevel.GOOD, result.quality)
    }

    @Test
    fun `parsePhotoQualityResponse con texto invalido retorna fallback`() {
        val result = service.parsePhotoQualityResponse("esto no es JSON")

        assertEquals(0.0, result.overallScore)
        assertEquals(PhotoQualityLevel.BAD, result.quality)
        assertTrue(result.issues.isNotEmpty())
    }

    @Test
    fun `parsePhotoQualityResponse clampea score fuera de rango`() {
        val json = """{
            "overall_score": 1.5,
            "quality": "GOOD",
            "issues": [],
            "recommendations": []
        }"""

        val result = service.parsePhotoQualityResponse(json)

        assertEquals(1.0, result.overallScore)
        assertEquals(PhotoQualityLevel.GOOD, result.quality)
    }

    @Test
    fun `calidad se determina por score no por texto del JSON`() {
        // JSON dice GOOD pero score es 0.3, deberia ser BAD
        val json = """{
            "overall_score": 0.3,
            "quality": "GOOD",
            "issues": ["Foto oscura"],
            "recommendations": ["Mejor luz"]
        }"""

        val result = service.parsePhotoQualityResponse(json)

        assertEquals(PhotoQualityLevel.BAD, result.quality)
    }
}
