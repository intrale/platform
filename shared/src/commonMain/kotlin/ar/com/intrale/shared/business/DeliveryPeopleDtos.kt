package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class BusinessDeliveryPersonDTO(
    val email: String = "",
    @SerialName("fullName")
    val fullName: String = "",
    val status: String = "PENDING"
)

@Serializable
data class BusinessDeliveryPeopleListResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    @SerialName("deliveryPeople")
    val deliveryPeople: List<BusinessDeliveryPersonDTO>? = null
)

@Serializable
data class ToggleDeliveryPersonStatusRequestDTO(
    val email: String = "",
    val newStatus: String = ""
)

@Serializable
data class ToggleDeliveryPersonStatusResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val email: String = "",
    val newStatus: String = ""
)

@Serializable
data class InviteDeliveryPersonRequestDTO(
    val email: String = ""
)

@Serializable
data class InviteDeliveryPersonResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val email: String = "",
    val message: String = ""
)
