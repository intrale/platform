package ar.com.intrale

import java.time.Instant
import java.util.UUID

class ClientOrderRepository {

    private val orders = mutableMapOf<String, MutableList<ClientOrderPayload>>()

    private fun key(business: String, email: String) = "${business.lowercase()}#${email.lowercase()}"

    fun listOrders(business: String, email: String): List<ClientOrderPayload> =
        orders.getOrDefault(key(business, email), emptyList()).map { it.copy() }

    fun getOrder(business: String, email: String, orderId: String): ClientOrderPayload? =
        orders[key(business, email)]?.firstOrNull { it.id == orderId }?.copy()

    fun listAllOrdersForBusiness(business: String): List<BusinessOrderItem> =
        orders.entries
            .filter { (k, _) -> k.startsWith("${business.lowercase()}#") }
            .flatMap { (k, list) ->
                val clientEmail = k.substringAfter("#")
                list.map { order -> BusinessOrderItem(clientEmail = clientEmail, order = order.copy()) }
            }
            .sortedByDescending { it.order.createdAt }

    fun assignDeliveryPerson(business: String, orderId: String, deliveryPersonEmail: String?): ClientOrderPayload? {
        val allOrders = orders.values.flatten()
        val order = allOrders.firstOrNull { it.id == orderId } ?: return null
        val updatedOrder = order.copy(
            assignedDeliveryPersonEmail = deliveryPersonEmail,
            updatedAt = java.time.Instant.now().toString()
        )
        orders.forEach { (key, list) ->
            val index = list.indexOfFirst { it.id == orderId }
            if (index >= 0) {
                list[index] = updatedOrder
            }
        }
        return updatedOrder
    }

    fun createOrder(business: String, email: String, payload: ClientOrderPayload): ClientOrderPayload {
        val now = Instant.now().toString()
        val statusEvent = ClientOrderStatusEventDTO(
            status = payload.status,
            timestamp = now,
            message = null
        )
        val created = payload.copy(
            id = payload.id?.ifBlank { UUID.randomUUID().toString() } ?: UUID.randomUUID().toString(),
            shortCode = payload.shortCode ?: generateShortCode(),
            createdAt = now,
            updatedAt = now,
            statusHistory = listOf(statusEvent)
        )
        orders.getOrPut(key(business, email)) { mutableListOf() }.add(created)
        return created
    }

    private fun generateShortCode(): String {
        val chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        return (1..6).map { chars.random() }.joinToString("")
    }
}
