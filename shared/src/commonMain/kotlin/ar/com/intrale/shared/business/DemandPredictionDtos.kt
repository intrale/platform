package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Prediccion de demanda para un producto individual.
 */
@Serializable
data class ProductDemandPredictionDTO(
    @SerialName("productName")
    val productName: String = "",
    @SerialName("expectedQuantity")
    val expectedQuantity: Int = 0,
    @SerialName("trend")
    val trend: String = "stable",
    @SerialName("changePercent")
    val changePercent: Double = 0.0,
    @SerialName("stockAlert")
    val stockAlert: Boolean = false,
    @SerialName("insight")
    val insight: String = ""
)

/**
 * Resumen semanal de prediccion de demanda para un negocio.
 */
@Serializable
data class DemandPredictionDTO(
    @SerialName("weekStartDate")
    val weekStartDate: String = "",
    @SerialName("weekEndDate")
    val weekEndDate: String = "",
    @SerialName("topProducts")
    val topProducts: List<ProductDemandPredictionDTO> = emptyList(),
    @SerialName("summary")
    val summary: String = "",
    @SerialName("dataWeeksUsed")
    val dataWeeksUsed: Int = 0
)

/**
 * Response DTO para la prediccion de demanda.
 */
@Serializable
data class DemandPredictionResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val prediction: DemandPredictionDTO? = null
)
