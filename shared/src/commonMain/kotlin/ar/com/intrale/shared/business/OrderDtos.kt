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
    val deliveryPersonEmail: String? = null
)

@Serializable
data class BusinessOrderItemDTO(
    val id: String? = null,
    val name: String = "",
    val quantity: Int = 0,
    val unitPrice: Double = 0.0,
    val subtotal: Double = 0.0
)

@Serializable
data class BusinessOrderStatusEventDTO(
    val status: String = "",
    val timestamp: String = "",
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

@Serializable
data class BusinessOrderDetailDTO(
    val id: String = "",
    val shortCode: String? = null,
    val clientEmail: String = "",
    val clientName: String? = null,
    val status: String = "PENDING",
    val total: Double = 0.0,
    val items: List<BusinessOrderItemDTO> = emptyList(),
    val deliveryAddress: String? = null,
    val deliveryCity: String? = null,
    val deliveryReference: String? = null,
    val statusHistory: List<BusinessOrderStatusEventDTO> = emptyList(),
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@Serializable
data class BusinessOrderDetailResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val order: BusinessOrderDetailDTO? = null
)

@Serializable
data class BusinessOrderStatusUpdateRequestDTO(
    val orderId: String = "",
    val newStatus: String = "",
    val reason: String? = null
)

@Serializable
data class BusinessOrderStatusUpdateResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val orderId: String = "",
    val newStatus: String = "",
    val updatedAt: String = ""
)
