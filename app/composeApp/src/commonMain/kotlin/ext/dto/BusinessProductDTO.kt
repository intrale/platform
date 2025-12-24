package ext.dto

import kotlinx.serialization.Serializable

@Serializable
data class BusinessProductDTO(
    val id: String,
    val name: String,
    val basePrice: Double,
    val status: String,
    val emoji: String? = null
)

@Serializable
data class BusinessProductsResponse(
    val statusCode: StatusCodeDTO,
    val products: List<BusinessProductDTO>
)
