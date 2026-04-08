package ar.com.intrale

import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.time.Duration
import java.time.Instant

/**
 * Tipo de anomalia detectada en un pedido.
 */
enum class AnomalyType {
    DUPLICATE_ORDER,
    UNUSUAL_AMOUNT,
    SUSPICIOUS_FREQUENCY
}

/**
 * Severidad de la anomalia.
 */
enum class AnomalySeverity {
    LOW, MEDIUM, HIGH
}

/**
 * Resultado del analisis de anomalias sobre un pedido.
 */
data class AnomalyDetectionResult(
    val orderId: String,
    val anomalies: List<DetectedAnomaly>,
    val flagged: Boolean,
    val requiresManualReview: Boolean
)

/**
 * Detalle de una anomalia individual detectada.
 */
data class DetectedAnomaly(
    val type: AnomalyType,
    val severity: AnomalySeverity,
    val description: String,
    val score: Double
)

/**
 * Configuracion de sensibilidad para la deteccion de anomalias.
 */
data class AnomalyDetectionConfig(
    /** Ventana de tiempo en minutos para detectar pedidos duplicados */
    val duplicateWindowMinutes: Long = 5,
    /** Multiplicador del ticket promedio para considerar monto inusual */
    val amountThresholdMultiplier: Double = 3.0,
    /** Cantidad maxima de pedidos por hora antes de flaggear frecuencia sospechosa */
    val maxOrdersPerHour: Int = 5,
    /** Score minimo para flaggear un pedido (0.0 a 1.0) */
    val flagThreshold: Double = 0.5
)

/**
 * Servicio de deteccion de anomalias en pedidos.
 * Evalua reglas heuristicas para identificar pedidos sospechosos.
 */
class OrderAnomalyDetectionService(
    private val orderRepository: ClientOrderRepository,
    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")
) {

    /**
     * Analiza un pedido recien creado contra las reglas de deteccion.
     *
     * @param business identificador del negocio
     * @param clientEmail email del cliente que realizo el pedido
     * @param order pedido a analizar
     * @param config configuracion de sensibilidad
     * @return resultado del analisis con las anomalias detectadas
     */
    fun analyze(
        business: String,
        clientEmail: String,
        order: ClientOrderPayload,
        config: AnomalyDetectionConfig = AnomalyDetectionConfig()
    ): AnomalyDetectionResult {
        logger.info("Analizando anomalias para pedido {} del cliente {} en negocio {}", order.id, clientEmail, business)
        val anomalies = mutableListOf<DetectedAnomaly>()

        // Regla 1: Pedidos duplicados (mismo contenido en ventana de tiempo)
        checkDuplicateOrders(business, clientEmail, order, config)?.let { anomalies.add(it) }

        // Regla 2: Monto inusual (> N veces el ticket promedio del negocio)
        checkUnusualAmount(business, order, config)?.let { anomalies.add(it) }

        // Regla 3: Frecuencia sospechosa (demasiados pedidos en poco tiempo)
        checkSuspiciousFrequency(business, clientEmail, config)?.let { anomalies.add(it) }

        val maxScore = anomalies.maxOfOrNull { it.score } ?: 0.0
        val flagged = maxScore >= config.flagThreshold

        if (flagged) {
            logger.warn("Pedido {} flaggeado con {} anomalias detectadas (score maximo: {})",
                order.id, anomalies.size, maxScore)
        } else {
            logger.debug("Pedido {} sin anomalias significativas", order.id)
        }

        return AnomalyDetectionResult(
            orderId = order.id ?: "",
            anomalies = anomalies,
            flagged = flagged,
            requiresManualReview = flagged
        )
    }

    /**
     * Detecta pedidos duplicados: mismo cliente, mismos productos, dentro de la ventana temporal.
     */
    internal fun checkDuplicateOrders(
        business: String,
        clientEmail: String,
        currentOrder: ClientOrderPayload,
        config: AnomalyDetectionConfig
    ): DetectedAnomaly? {
        val recentOrders = orderRepository.listOrders(business, clientEmail)
        val cutoff = Instant.now().minus(Duration.ofMinutes(config.duplicateWindowMinutes))

        val currentItems = currentOrder.items
            .map { "${it.productId}:${it.quantity}" }
            .sorted()

        for (existing in recentOrders) {
            if (existing.id == currentOrder.id) continue

            val createdAt = existing.createdAt?.let {
                runCatching { Instant.parse(it) }.getOrNull()
            } ?: continue

            if (createdAt.isBefore(cutoff)) continue

            val existingItems = existing.items
                .map { "${it.productId}:${it.quantity}" }
                .sorted()

            if (currentItems == existingItems) {
                logger.info("Pedido duplicado detectado: {} es identico a {} (creado {})",
                    currentOrder.id, existing.id, existing.createdAt)
                return DetectedAnomaly(
                    type = AnomalyType.DUPLICATE_ORDER,
                    severity = AnomalySeverity.HIGH,
                    description = "Pedido con items identicos al pedido ${existing.shortCode ?: existing.id} " +
                            "creado hace menos de ${config.duplicateWindowMinutes} minutos",
                    score = 0.9
                )
            }
        }
        return null
    }

    /**
     * Detecta montos inusuales comparando con el ticket promedio del negocio.
     */
    internal fun checkUnusualAmount(
        business: String,
        order: ClientOrderPayload,
        config: AnomalyDetectionConfig
    ): DetectedAnomaly? {
        val allOrders = orderRepository.listAllOrdersForBusiness(business)
        if (allOrders.size < 3) {
            // No hay suficientes datos historicos para calcular promedio
            return null
        }

        val averageTicket = allOrders
            .map { it.order.total }
            .filter { it > 0 }
            .average()

        if (averageTicket <= 0) return null

        val threshold = averageTicket * config.amountThresholdMultiplier
        if (order.total > threshold) {
            val ratio = order.total / averageTicket
            val severity = when {
                ratio > 10 -> AnomalySeverity.HIGH
                ratio > 5 -> AnomalySeverity.MEDIUM
                else -> AnomalySeverity.LOW
            }
            logger.info("Monto inusual detectado: pedido {} con total {} (promedio: {}, ratio: {})",
                order.id, order.total, averageTicket, ratio)
            return DetectedAnomaly(
                type = AnomalyType.UNUSUAL_AMOUNT,
                severity = severity,
                description = "Monto del pedido (${order.total}) es ${String.format("%.1f", ratio)}x " +
                        "el ticket promedio del negocio (${String.format("%.2f", averageTicket)})",
                score = (ratio / (config.amountThresholdMultiplier * 2)).coerceAtMost(1.0)
            )
        }
        return null
    }

    /**
     * Detecta frecuencia sospechosa: demasiados pedidos de un mismo cliente en poco tiempo.
     */
    internal fun checkSuspiciousFrequency(
        business: String,
        clientEmail: String,
        config: AnomalyDetectionConfig
    ): DetectedAnomaly? {
        val recentOrders = orderRepository.listOrders(business, clientEmail)
        val oneHourAgo = Instant.now().minus(Duration.ofHours(1))

        val recentCount = recentOrders.count { order ->
            order.createdAt?.let { ts ->
                runCatching { Instant.parse(ts) }.getOrNull()?.isAfter(oneHourAgo)
            } ?: false
        }

        if (recentCount >= config.maxOrdersPerHour) {
            logger.info("Frecuencia sospechosa: cliente {} realizo {} pedidos en la ultima hora en negocio {}",
                clientEmail, recentCount, business)
            return DetectedAnomaly(
                type = AnomalyType.SUSPICIOUS_FREQUENCY,
                severity = if (recentCount > config.maxOrdersPerHour * 2) AnomalySeverity.HIGH else AnomalySeverity.MEDIUM,
                description = "El cliente realizo $recentCount pedidos en la ultima hora " +
                        "(limite: ${config.maxOrdersPerHour})",
                score = (recentCount.toDouble() / (config.maxOrdersPerHour * 2)).coerceAtMost(1.0)
            )
        }
        return null
    }
}
