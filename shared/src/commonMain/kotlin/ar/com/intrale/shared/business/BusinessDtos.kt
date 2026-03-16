package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class BusinessDTO(
    val businessId: String,
    val publicId: String,
    val name: String,
    val description: String,
    val emailAdmin: String,
    val autoAcceptDeliveries: Boolean,
    val status: String
)

@Serializable
data class BusinessDashboardSummaryDTO(
    @SerialName("productsCount")
    val productsCount: Int = 0,
    @SerialName("pendingOrders")
    val pendingOrders: Int = 0,
    @SerialName("activeDrivers")
    val activeDrivers: Int = 0
)

@Serializable
data class SearchBusinessesRequest(
    val query: String = "",
    val status: String? = null,
    val limit: Int? = null,
    val lastKey: String? = null
)

@Serializable
data class SearchBusinessesResponse(
    val statusCode: StatusCodeDTO,
    val businesses: List<BusinessDTO>,
    val lastKey: String? = null
)

@Serializable
data class RegisterBusinessRequest(
    val name: String,
    val emailAdmin: String,
    val description: String,
    val autoAcceptDeliveries: Boolean = false
)

@Serializable
data class RegisterBusinessResponse(val statusCode: StatusCodeDTO)

@Serializable
data class ReviewBusinessRegistrationRequest(
    val publicId: String,
    val decision: String,
    val twoFactorCode: String
)

@Serializable
data class ReviewBusinessRegistrationResponse(val statusCode: StatusCodeDTO)

@Serializable
data class ReviewJoinBusinessRequest(val email: String, val decision: String)

@Serializable
data class ReviewJoinBusinessResponse(val statusCode: StatusCodeDTO)

@Serializable
data class RequestJoinBusinessRequest(val placeholder: String? = null)

@Serializable
data class RequestJoinBusinessResponse(val state: String)

@Serializable
data class ConfigAutoAcceptDeliveriesRequest(val autoAcceptDeliveries: Boolean)

@Serializable
data class AssignProfileRequest(val email: String, val profile: String)
