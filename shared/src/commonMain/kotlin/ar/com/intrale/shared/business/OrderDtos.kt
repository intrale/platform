package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class BusinessOrderDTO(
    val id: String = "",
    val shortCode: String? = null,
    val clientEmail: String = "",
    val status: String = "PENDING",
    val total: Double = 0.0,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@Serializable
data class BusinessOrdersListResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val orders: List<BusinessOrderDTO>? = null
)
