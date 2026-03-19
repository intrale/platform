package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class BusinessOrderDTO(
    val id: String = "",
    val shortCode: String? = null,
    val clientEmail: String = "",
    val status: String = "PENDING",
    val total: Double = 0.0,
    @SerialName("assignedDeliveryPersonEmail")
    val assignedDeliveryPersonEmail: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@Serializable
data class BusinessOrdersListResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val orders: List<BusinessOrderDTO>? = null
)

@Serializable
data class AssignOrderDeliveryPersonRequest(
    @SerialName("orderId")
    val orderId: String,
    @SerialName("deliveryPersonEmail")
    val deliveryPersonEmail: String?
)

@Serializable
data class AssignOrderDeliveryPersonResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    @SerialName("orderId")
    val orderId: String = "",
    @SerialName("deliveryPersonEmail")
    val deliveryPersonEmail: String? = null,
    val message: String? = null
)

@Serializable
data class DeliveryPersonSummaryDTO(
    val email: String = "",
    @SerialName("fullName")
    val fullName: String = ""
)

@Serializable
data class DeliveryPersonListResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    @SerialName("deliveryPeople")
    val deliveryPeople: List<DeliveryPersonSummaryDTO>? = null
)
