package asdo.delivery

import ext.delivery.DeliveryStateChangeResponse

enum class DeliveryState {
    PENDING, PICKED_UP, IN_TRANSIT, DELIVERED, CANCELLED
}

data class DeliveryStateChangeResult(
    val orderId: String,
    val newState: DeliveryState
)

fun String.toDeliveryState(): DeliveryState = when (this.lowercase()) {
    "pending" -> DeliveryState.PENDING
    "picked_up", "pickedup" -> DeliveryState.PICKED_UP
    "in_transit", "intransit" -> DeliveryState.IN_TRANSIT
    "delivered" -> DeliveryState.DELIVERED
    "cancelled" -> DeliveryState.CANCELLED
    else -> DeliveryState.PENDING
}

fun DeliveryState.toApiString(): String = when (this) {
    DeliveryState.PENDING -> "pending"
    DeliveryState.PICKED_UP -> "picked_up"
    DeliveryState.IN_TRANSIT -> "in_transit"
    DeliveryState.DELIVERED -> "delivered"
    DeliveryState.CANCELLED -> "cancelled"
}

fun DeliveryStateChangeResponse.toDomain(): DeliveryStateChangeResult =
    DeliveryStateChangeResult(
        orderId = orderId,
        newState = state.toDeliveryState()
    )
