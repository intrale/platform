package ar.com.intrale

import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.time.Duration
import java.time.Instant

/**
 * Servicio de detección de anomalías en pedidos.
 *
 * Reglas implementadas:
 * - Pedidos duplicados: mismo usuario, mismos productos en < 5 minutos
 * - Monto inusual: total > 3x el ticket promedio del negocio
 * - Direcciones sospechosas: misma dirección usada por múltiples cuentas
 */
class OrderAnomalyDetector(
    private val orderRepository: ClientOrderRepository,
    private val anomalyRepository: OrderAnomalyRepository,
    private val config: AnomalyDetectionConfig = AnomalyDetectionConfig()
) {
    val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")

    /**
     * Evalúa un pedido nuevo contra las reglas de detección.
     * Retorna la lista de anomalías encontradas (puede ser vacía).
     */
    fun evaluate(
        business: String,
        email: String,
        order: ClientOrderPayload
    ): List<OrderAnomaly> {
        val anomalies = mutableListOf<OrderAnomaly>()

        checkDuplicateOrder(business, email, order)?.let { anomalies.add(it) }
        checkUnusualAmount(business, order)?.let { anomalies.add(it) }
        checkSuspiciousAddress(business, email, order)?.let { anomalies.add(it) }

        if (anomalies.isNotEmpty()) {
            logger.warn(
                "Pedido flaggeado con {} anomalía(s) para {}/{}: {}",
                anomalies.size, business, email,
                anomalies.joinToString { it.type.name }
            )
            anomalies.forEach { anomaly ->
                anomalyRepository.record(business, email, order.id.orEmpty(), anomaly)
            }
        }

        return anomalies
    }

    /**
     * Detecta pedidos duplicados: mismo usuario con productos idénticos en < 5 min.
     */
    internal fun checkDuplicateOrder(
        business: String,
        email: String,
        order: ClientOrderPayload
    ): OrderAnomaly? {
        val recentOrders = orderRepository.listOrders(business, email)
        val now = Instant.now()
        val windowMinutes = config.duplicateWindowMinutes

        val newProductIds = order.items.map { it.productId }.sorted()
        if (newProductIds.isEmpty()) return null

        val duplicate = recentOrders.any { existing ->
            val createdAt = runCatching { Instant.parse(existing.createdAt) }.getOrNull() ?: return@any false
            val minutesAgo = Duration.between(createdAt, now).toMinutes()
            if (minutesAgo > windowMinutes) return@any false

            val existingProductIds = existing.items.map { it.productId }.sorted()
            existingProductIds == newProductIds
        }

        return if (duplicate) {
            OrderAnomaly(
                type = AnomalyType.DUPLICATE_ORDER,
                severity = AnomalySeverity.HIGH,
                description = "Pedido duplicado detectado: mismos productos en menos de $windowMinutes minutos",
                details = mapOf(
                    "windowMinutes" to windowMinutes.toString(),
                    "productIds" to newProductIds.joinToString(",")
                )
            )
        } else null
    }

    /**
     * Detecta montos inusuales: total > 3x el ticket promedio del negocio.
     */
    internal fun checkUnusualAmount(
        business: String,
        order: ClientOrderPayload
    ): OrderAnomaly? {
        val allOrders = orderRepository.listAllOrdersForBusiness(business)
        if (allOrders.size < config.minOrdersForAverage) return null

        val averageTicket = allOrders.map { it.order.total }.average()
        val threshold = averageTicket * config.amountMultiplierThreshold

        return if (order.total > threshold && averageTicket > 0) {
            OrderAnomaly(
                type = AnomalyType.UNUSUAL_AMOUNT,
                severity = AnomalySeverity.MEDIUM,
                description = "Monto inusual: \$${order.total} supera ${config.amountMultiplierThreshold}x el ticket promedio (\$${String.format("%.2f", averageTicket)})",
                details = mapOf(
                    "orderTotal" to order.total.toString(),
                    "averageTicket" to String.format("%.2f", averageTicket),
                    "threshold" to String.format("%.2f", threshold),
                    "multiplier" to config.amountMultiplierThreshold.toString()
                )
            )
        } else null
    }

    /**
     * Detecta direcciones sospechosas: misma dirección usada por distintas cuentas.
     */
    internal fun checkSuspiciousAddress(
        business: String,
        email: String,
        order: ClientOrderPayload
    ): OrderAnomaly? {
        val address = order.deliveryAddress ?: return null
        val addressKey = normalizeAddress(address)
        if (addressKey.isBlank()) return null

        val allOrders = orderRepository.listAllOrdersForBusiness(business)
        val otherEmails = allOrders
            .filter { item ->
                item.clientEmail != email &&
                    item.order.deliveryAddress?.let { normalizeAddress(it) } == addressKey
            }
            .map { it.clientEmail }
            .distinct()

        return if (otherEmails.size >= config.suspiciousAddressMinAccounts) {
            OrderAnomaly(
                type = AnomalyType.SUSPICIOUS_ADDRESS,
                severity = AnomalySeverity.LOW,
                description = "Dirección usada por ${otherEmails.size + 1} cuentas distintas",
                details = mapOf(
                    "address" to addressKey,
                    "otherAccountsCount" to otherEmails.size.toString()
                )
            )
        } else null
    }

    private fun normalizeAddress(address: ClientAddressPayload): String {
        val street = address.street.trim().lowercase()
        val number = address.number.trim().lowercase()
        val city = address.city.trim().lowercase()
        return "$street|$number|$city"
    }
}
