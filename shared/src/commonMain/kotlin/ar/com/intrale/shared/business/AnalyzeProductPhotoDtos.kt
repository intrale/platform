package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

/**
 * Request para analizar una foto de producto con IA.
 * La imagen se envia como base64.
 */
@Serializable
data class AnalyzeProductPhotoRequest(
    val imageBase64: String,
    val mediaType: String = "image/jpeg",
    val existingCategories: List<String> = emptyList()
)

/**
 * Respuesta del analisis IA de foto de producto.
 */
@Serializable
data class AnalyzeProductPhotoResponse(
    val statusCode: StatusCodeDTO? = null,
    val suggestedName: String = "",
    val suggestedDescription: String = "",
    val suggestedCategory: String = "",
    val confidence: Double = 0.0
)
