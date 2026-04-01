package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Request para conteo de stock por foto.
 */
@Serializable
data class StockCountRequestDTO(
    @SerialName("imageBase64")
    val imageBase64: String = "",
    @SerialName("mediaType")
    val mediaType: String = "image/jpeg",
    @SerialName("autoUpdate")
    val autoUpdate: Boolean = false
)

/**
 * Producto identificado en la foto.
 */
@Serializable
data class StockCountProductDTO(
    @SerialName("name")
    val name: String = "",
    @SerialName("quantity")
    val quantity: Int = 0,
    @SerialName("confidence")
    val confidence: Double = 0.0,
    @SerialName("matchedProductId")
    val matchedProductId: String? = null,
    @SerialName("updated")
    val updated: Boolean = false
)

/**
 * Respuesta del conteo de stock por foto.
 */
@Serializable
data class StockCountResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val products: List<StockCountProductDTO> = emptyList(),
    @SerialName("unrecognizedCount")
    val unrecognizedCount: Int = 0,
    @SerialName("processingTimeMs")
    val processingTimeMs: Long = 0,
    val notes: String? = null
)
