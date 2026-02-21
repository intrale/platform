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

    fun createOrder(business: String, email: String, payload: ClientOrderPayload): ClientOrderPayload {
        val now = Instant.now().toString()
        val created = payload.copy(
            id = payload.id.ifBlank { UUID.randomUUID().toString() },
            shortCode = payload.shortCode ?: generateShortCode(),
            createdAt = now,
            updatedAt = now
        )
        orders.getOrPut(key(business, email)) { mutableListOf() }.add(created)
        return created
    }

    private fun generateShortCode(): String {
        val chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        return (1..6).map { chars.random() }.joinToString("")
    }
}
