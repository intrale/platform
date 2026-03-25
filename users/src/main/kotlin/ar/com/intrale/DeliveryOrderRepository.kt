package ar.com.intrale

import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class DeliveryOrderRepository {

    private val orders = ConcurrentHashMap<String, MutableList<DeliveryOrderPayload>>()

    private fun businessKey(business: String) = business.lowercase()
    private fun deliveryKey(business: String, email: String) = "${business.lowercase()}#${email.lowercase()}"

    fun listByAssigned(business: String, email: String): List<DeliveryOrderPayload> =
        orders.getOrDefault(businessKey(business), mutableListOf())
            .filter { it.assignedTo?.lowercase() == email.lowercase() }
            .map { it.copy() }

    fun listActive(business: String, email: String): List<DeliveryOrderPayload> =
        listByAssigned(business, email)
            .filter { it.status in setOf("picked_up", "in_transit", "arriving") }

    fun listAvailable(business: String): List<DeliveryOrderPayload> =
        orders.getOrDefault(businessKey(business), mutableListOf())
            .filter { it.status == "pending" && it.assignedTo.isNullOrBlank() }
            .map { it.copy() }

    fun getOrder(business: String, orderId: String): DeliveryOrderPayload? =
        orders.getOrDefault(businessKey(business), mutableListOf())
            .firstOrNull { it.id == orderId }
            ?.copy()

    fun summary(business: String, email: String): DeliveryOrdersSummaryResponse {
        val assigned = listByAssigned(business, email)
        return DeliveryOrdersSummaryResponse(
            pending = assigned.count { it.status == "pending" },
            inProgress = assigned.count { it.status in setOf("picked_up", "in_transit", "arriving") },
            delivered = assigned.count { it.status == "delivered" }
        )
    }

    fun updateStatus(business: String, orderId: String, newStatus: String): DeliveryOrderPayload? {
        val list = orders.getOrDefault(businessKey(business), mutableListOf())
        val index = list.indexOfFirst { it.id == orderId }
        if (index == -1) return null
        val updated = list[index].copy(status = newStatus, updatedAt = Instant.now().toString())
        list[index] = updated
        return updated
    }

    fun updateState(business: String, orderId: String, newState: String): DeliveryOrderPayload? {
        return updateStatus(business, orderId, newState)
    }

    /**
     * Asigna un pedido disponible a un repartidor.
     * Retorna null si el pedido no existe (404).
     * Lanza [OrderAlreadyTakenException] si el pedido ya tiene repartidor asignado (409).
     */
    fun takeOrder(business: String, orderId: String, deliveryEmail: String): DeliveryOrderPayload? {
        val list = orders.getOrDefault(businessKey(business), mutableListOf())
        val index = list.indexOfFirst { it.id == orderId }
        if (index == -1) return null
        val current = list[index]
        if (!current.assignedTo.isNullOrBlank()) {
            throw OrderAlreadyTakenException(orderId)
        }
        val updated = current.copy(
            assignedTo = deliveryEmail,
            status = "assigned",
            updatedAt = Instant.now().toString()
        )
        list[index] = updated
        return updated
    }

    fun createOrder(business: String, payload: DeliveryOrderPayload): DeliveryOrderPayload {
        val now = Instant.now().toString()
        val created = payload.copy(
            id = payload.id.ifBlank { UUID.randomUUID().toString() },
            shortCode = payload.shortCode ?: generateShortCode(),
            createdAt = now,
            updatedAt = now
        )
        orders.getOrPut(businessKey(business)) { mutableListOf() }.add(created)
        return created
    }

    private fun generateShortCode(): String {
        val chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        return (1..6).map { chars.random() }.joinToString("")
    }
}
