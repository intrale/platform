package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class BusinessConfigDTO(
    val businessId: String = "",
    val name: String = "",
    val address: String = "",
    val phone: String = "",
    val email: String = "",
    val logoUrl: String = ""
)

@Serializable
data class UpdateBusinessConfigRequest(
    val name: String,
    val address: String,
    val phone: String,
    val email: String,
    val logoUrl: String = ""
)

@Serializable
data class UpdateBusinessConfigResponse(
    val statusCode: StatusCodeDTO,
    val config: BusinessConfigDTO
)

@Serializable
data class GetBusinessConfigResponse(
    val statusCode: StatusCodeDTO,
    val config: BusinessConfigDTO
)
