package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Niveles de calidad de foto para catalogos.
 */
@Serializable
enum class PhotoQualityLevelDTO {
    @SerialName("GOOD") GOOD,
    @SerialName("IMPROVABLE") IMPROVABLE,
    @SerialName("BAD") BAD
}

/**
 * Request para evaluar la calidad de una foto de producto.
 */
@Serializable
data class PhotoQualityRequestDTO(
    @SerialName("productId")
    val productId: String = "",
    @SerialName("imageBase64")
    val imageBase64: String = "",
    @SerialName("mediaType")
    val mediaType: String = "image/jpeg",
    @SerialName("productName")
    val productName: String? = null
)

/**
 * Resultado de evaluacion de calidad de una foto.
 */
@Serializable
data class PhotoQualityAssessmentDTO(
    @SerialName("productId")
    val productId: String = "",
    @SerialName("overallScore")
    val overallScore: Double = 0.0,
    @SerialName("quality")
    val quality: PhotoQualityLevelDTO = PhotoQualityLevelDTO.BAD,
    @SerialName("issues")
    val issues: List<String> = emptyList(),
    @SerialName("recommendations")
    val recommendations: List<String> = emptyList(),
    @SerialName("timestamp")
    val timestamp: Long = 0
)

/**
 * Respuesta con evaluacion de calidad individual.
 */
@Serializable
data class PhotoQualityResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val productId: String = "",
    val overallScore: Double = 0.0,
    val quality: PhotoQualityLevelDTO = PhotoQualityLevelDTO.BAD,
    val issues: List<String> = emptyList(),
    val recommendations: List<String> = emptyList()
)

/**
 * Respuesta con listado de evaluaciones de calidad.
 */
@Serializable
data class PhotoQualityListResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val assessments: List<PhotoQualityAssessmentDTO> = emptyList(),
    val totalLowQuality: Int = 0
)
