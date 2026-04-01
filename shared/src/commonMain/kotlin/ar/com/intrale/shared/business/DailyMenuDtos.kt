package ar.com.intrale.shared.business

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Representa un item sugerido dentro del menu del dia.
 */
@Serializable
data class DailyMenuItemDTO(
    @SerialName("productId")
    val productId: String = "",
    @SerialName("productName")
    val productName: String = "",
    @SerialName("description")
    val description: String = "",
    @SerialName("suggestedPrice")
    val suggestedPrice: Double = 0.0
)

/**
 * Sugerencia completa de menu del dia generada por IA.
 */
@Serializable
data class DailyMenuSuggestionDTO(
    @SerialName("id")
    val id: String = "",
    @SerialName("businessName")
    val businessName: String = "",
    @SerialName("date")
    val date: String = "",
    @SerialName("title")
    val title: String = "",
    @SerialName("description")
    val description: String = "",
    @SerialName("items")
    val items: List<DailyMenuItemDTO> = emptyList(),
    @SerialName("reasoning")
    val reasoning: String = "",
    @SerialName("status")
    val status: String = "PENDING"
)

/**
 * Configuracion del menu del dia para un negocio.
 */
@Serializable
data class DailyMenuConfigDTO(
    @SerialName("enabled")
    val enabled: Boolean = false,
    @SerialName("suggestionHour")
    val suggestionHour: Int = 8
)

/**
 * Request para aprobar/rechazar una sugerencia de menu.
 */
@Serializable
data class DailyMenuActionDTO(
    @SerialName("action")
    val action: String = "",
    @SerialName("suggestionId")
    val suggestionId: String = ""
)

/**
 * DTO con el codigo de estado para respuestas.
 */
@Serializable
data class StatusCodeValueDTO(
    @SerialName("value")
    val value: Int = 200,
    @SerialName("description")
    val description: String = "OK"
)

/**
 * Respuesta con la sugerencia de menu del dia.
 */
@Serializable
data class DailyMenuSuggestionResponseDTO(
    @SerialName("statusCode_value")
    val statusCodeValue: StatusCodeValueDTO = StatusCodeValueDTO(),
    @SerialName("suggestion")
    val suggestion: DailyMenuSuggestionDTO? = null,
    @SerialName("message")
    val message: String = ""
)

/**
 * Respuesta con la configuracion del menu del dia.
 */
@Serializable
data class DailyMenuConfigResponseDTO(
    @SerialName("statusCode_value")
    val statusCodeValue: StatusCodeValueDTO = StatusCodeValueDTO(),
    @SerialName("config")
    val config: DailyMenuConfigDTO? = null
)
