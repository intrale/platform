package asdo.business

enum class BusinessDeliveryPersonStatus { ACTIVE, INACTIVE, PENDING }

data class BusinessDeliveryPerson(
    val email: String,
    val fullName: String,
    val status: BusinessDeliveryPersonStatus
)

fun String.toBusinessDeliveryPersonStatus(): BusinessDeliveryPersonStatus = when (this.uppercase()) {
    "ACTIVE" -> BusinessDeliveryPersonStatus.ACTIVE
    "INACTIVE" -> BusinessDeliveryPersonStatus.INACTIVE
    else -> BusinessDeliveryPersonStatus.PENDING
}
