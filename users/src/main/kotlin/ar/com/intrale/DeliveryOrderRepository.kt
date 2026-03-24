package ar.com.intrale

import ar.com.intrale.shared.delivery.DeliveryStatusHistoryEntryDTO
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

// Secuencia de estados válidos para avance
private val DELIVERY_STATE_SEQUENCE = listOf(
    "assigned",
    "heading_to_business",
    "at_business",
    "heading_to_client",
    "delivered"
)
private val TERMINAL_STATES = setOf("delivered", "not_delivered")
private val ACTIVE_STATES = setOf("assigned", "heading_to_business", "at_business", "heading_to_client")

private fun isTransitionValid(current: String, next: String): Boolean {
    if (next == "not_delivered") {
        return current in ACTIVE_STATES
    }
    val currentIndex = DELIVERY_STATE_SEQUENCE.indexOf(current.lowercase())
    val nextIndex = DELIVERY_STATE_SEQUENCE.indexOf(next.lowercase())
    return currentIndex >= 0 && nextIndex == currentIndex + 1
}

class DeliveryOrderRepository {

    private val logger: org.slf4j.Logger = org.slf4j.LoggerFactory.getLogger("ar.com.intrale")
    private val orders = ConcurrentHashMap<String, MutableList<DeliveryOrderPayload>>()

    private fun businessKey(business: String) = business.lowercase()

    fun listByAssigned(business: String, email: String): List<DeliveryOrderPayload> =
        orders.getOrDefault(businessKey(business), mutableListOf())
            .filter { it.assignedTo?.lowercase() == email.lowercase() }
            .map { it.copy() }

    fun listActive(business: String, email: String): List<DeliveryOrderPayload> =
        listByAssigned(business, email)
            .filter { it.status in ACTIVE_STATES }

    fun listAvailable(business: String): List<DeliveryOrderPayload> =
        orders.getOrDefault(businessKey(business), mutableListOf())
            .filter { it.status == "assigned" && it.assignedTo.isNullOrBlank() }
            .map { it.copy() }

    fun getOrder(business: String, orderId: String): DeliveryOrderPayload? =
        orders.getOrDefault(businessKey(business), mutableListOf())
            .firstOrNull { it.id == orderId }
            ?.copy()

    fun summary(business: String, email: String): DeliveryOrdersSummaryResponse {
        val assigned = listByAssigned(business, email)
        return DeliveryOrdersSummaryResponse(
            pending = assigned.count { it.status == "assigned" },
            inProgress = assigned.count { it.status in ACTIVE_STATES - setOf("assigned") },
            delivered = assigned.count { it.status == "delivered" }
        )
    }

    /**
     * Actualiza el estado de un pedido validando que la transición sea secuencial.
     * Retorna null si el pedido no existe, o lanza [InvalidStateTransitionException] si la
     * transición no es permitida.
     */
    fun updateStatus(business: String, orderId: String, newStatus: String, reason: String? = null): DeliveryOrderPayload? {
        val list = orders.getOrDefault(businessKey(business), mutableListOf())
        val index = list.indexOfFirst { it.id == orderId }
        if (index == -1) return null

        val current = list[index]
        val currentStatus = current.status.lowercase()
        val nextStatus = newStatus.lowercase()

        if (currentStatus in TERMINAL_STATES) {
            logger.warn("Intento de cambiar estado de pedido $orderId ya en estado terminal '$currentStatus'")
            throw InvalidStateTransitionException(currentStatus, nextStatus)
        }
        if (currentStatus != nextStatus && !isTransitionValid(currentStatus, nextStatus)) {
            logger.warn("Transicion invalida para pedido $orderId: '$currentStatus' -> '$nextStatus'")
            throw InvalidStateTransitionException(currentStatus, nextStatus)
        }

        val now = Instant.now().toString()
        val newEntry = DeliveryStatusHistoryEntryDTO(
            status = nextStatus,
            timestamp = now,
            reason = reason
        )
        val updatedHistory = (current.statusHistory ?: emptyList()) + newEntry
        val updated = current.copy(status = nextStatus, updatedAt = now, statusHistory = updatedHistory)
        list[index] = updated
        return updated
    }

    fun updateState(business: String, orderId: String, newState: String, reason: String? = null): DeliveryOrderPayload? {
        return updateStatus(business, orderId, newState, reason)
    }

    fun createOrder(business: String, payload: DeliveryOrderPayload): DeliveryOrderPayload {
        val now = Instant.now().toString()
        val initialHistory = listOf(
            DeliveryStatusHistoryEntryDTO(status = payload.status.ifBlank { "assigned" }, timestamp = now)
        )
        val created = payload.copy(
            id = payload.id.ifBlank { UUID.randomUUID().toString() },
            shortCode = payload.shortCode ?: generateShortCode(),
            createdAt = now,
            updatedAt = now,
            statusHistory = initialHistory
        )
        orders.getOrPut(businessKey(business)) { mutableListOf() }.add(created)
        return created
    }

    private fun generateShortCode(): String {
        val chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        return (1..6).map { chars.random() }.joinToString("")
    }
}

class InvalidStateTransitionException(val current: String, val next: String) :
    Exception("Transicion de estado no permitida: '$current' -> '$next'")
