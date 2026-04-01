package ar.com.intrale

import org.slf4j.Logger
import java.time.DayOfWeek
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.math.*

/**
 * Resultado de la estimacion de tiempo de entrega.
 */
data class EstimationResult(
    val estimatedMinutes: Int,
    val minMinutes: Int,
    val maxMinutes: Int,
    val confidence: Double,
    val displayText: String,
    val activeOrders: Int,
    val distanceKm: Double?,
    val hourOfDay: Int,
    val dayOfWeek: Int,
    val historicalAvgMinutes: Double?
)

/**
 * Servicio de estimacion inteligente de tiempo de entrega.
 *
 * Calcula el tiempo estimado basandose en:
 * - Pedidos activos del negocio (carga actual)
 * - Distancia al punto de entrega
 * - Hora del dia (picos de demanda)
 * - Dia de la semana
 * - Historico real de entregas anteriores
 *
 * Usa promedios ponderados donde el historico tiene mayor peso
 * cuando hay suficientes datos.
 */
class DeliveryTimeEstimationService(
    private val logger: Logger,
    private val estimationRepository: DeliveryTimeEstimationRepository,
    private val orderRepository: ClientOrderRepository,
    private val deliveryOrderRepository: DeliveryOrderRepository
) {

    companion object {
        // Tiempo base de preparacion en minutos
        const val BASE_PREPARATION_MINUTES = 15

        // Minutos adicionales por cada pedido activo en cola
        const val MINUTES_PER_ACTIVE_ORDER = 5

        // Velocidad promedio de entrega en km/h
        const val AVG_DELIVERY_SPEED_KMH = 25.0

        // Multiplicadores por franja horaria (hora pico = mas demora)
        private val HOUR_MULTIPLIERS = mapOf(
            // Almuerzo (12-14h): alta demanda
            12 to 1.3, 13 to 1.4, 14 to 1.2,
            // Cena (20-22h): alta demanda
            20 to 1.3, 21 to 1.4, 22 to 1.2,
            // Madrugada (0-6h): baja actividad
            0 to 0.8, 1 to 0.8, 2 to 0.8, 3 to 0.8, 4 to 0.8, 5 to 0.8
        )

        // Multiplicadores por dia de la semana (viernes/sabado mas carga)
        private val DAY_MULTIPLIERS = mapOf(
            DayOfWeek.FRIDAY.value to 1.15,
            DayOfWeek.SATURDAY.value to 1.2,
            DayOfWeek.SUNDAY.value to 1.1
        )

        // Peso del historico vs modelo basico cuando hay datos suficientes
        const val HISTORICAL_WEIGHT = 0.6
        const val MODEL_WEIGHT = 0.4

        // Minimo de registros historicos para usar promedios ponderados
        const val MIN_HISTORICAL_RECORDS = 5

        // Rango de confianza (porcentaje del estimado)
        const val CONFIDENCE_MARGIN = 0.25
    }

    /**
     * Estima el tiempo de entrega para un pedido.
     *
     * @param business nombre del negocio
     * @param distanceKm distancia al punto de entrega en km (puede ser null)
     * @param now momento actual (parametrizable para tests)
     * @return resultado de la estimacion
     */
    fun estimate(
        business: String,
        distanceKm: Double? = null,
        now: LocalDateTime = LocalDateTime.now(ZoneId.of("America/Argentina/Buenos_Aires"))
    ): EstimationResult {
        val hourOfDay = now.hour
        val dayOfWeek = now.dayOfWeek.value

        // 1. Contar pedidos activos del negocio
        val activeOrders = countActiveOrders(business)

        // 2. Calcular tiempo base del modelo
        val modelEstimate = calculateModelEstimate(activeOrders, distanceKm, hourOfDay, dayOfWeek)

        // 3. Obtener promedio historico
        val historicalAvg = getWeightedHistoricalAvg(business, hourOfDay, dayOfWeek)

        // 4. Combinar modelo con historico (promedio ponderado)
        val finalEstimate = combineEstimates(modelEstimate, historicalAvg)

        // 5. Calcular confianza
        val confidence = calculateConfidence(historicalAvg, business)

        // 6. Calcular rango min/max
        val margin = (finalEstimate * CONFIDENCE_MARGIN).toInt().coerceAtLeast(3)
        val minMinutes = (finalEstimate - margin).coerceAtLeast(5)
        val maxMinutes = finalEstimate + margin

        // 7. Generar texto para mostrar al cliente
        val displayText = formatDisplayText(minMinutes, maxMinutes)

        logger.info(
            "Estimacion para negocio $business: ${finalEstimate}min " +
            "(rango $minMinutes-$maxMinutes), confianza ${String.format("%.0f", confidence * 100)}%, " +
            "pedidos activos: $activeOrders, distancia: ${distanceKm ?: "N/A"}km"
        )

        return EstimationResult(
            estimatedMinutes = finalEstimate,
            minMinutes = minMinutes,
            maxMinutes = maxMinutes,
            confidence = confidence,
            displayText = displayText,
            activeOrders = activeOrders,
            distanceKm = distanceKm,
            hourOfDay = hourOfDay,
            dayOfWeek = dayOfWeek,
            historicalAvgMinutes = historicalAvg
        )
    }

    /**
     * Cuenta los pedidos activos (no entregados ni cancelados) de un negocio.
     */
    internal fun countActiveOrders(business: String): Int {
        val clientOrders = orderRepository.listAllOrdersForBusiness(business)
            .count { it.order.status in setOf("PENDING", "CONFIRMED", "PREPARING", "READY") }
        val deliveryActive = deliveryOrderRepository.listAvailable(business).size
        return clientOrders + deliveryActive
    }

    /**
     * Calcula el tiempo estimado basado en el modelo (sin historico).
     */
    internal fun calculateModelEstimate(
        activeOrders: Int,
        distanceKm: Double?,
        hourOfDay: Int,
        dayOfWeek: Int
    ): Double {
        // Tiempo de preparacion base + carga por pedidos en cola
        var estimate = BASE_PREPARATION_MINUTES + (activeOrders * MINUTES_PER_ACTIVE_ORDER).toDouble()

        // Tiempo de traslado basado en distancia
        if (distanceKm != null && distanceKm > 0) {
            val travelMinutes = (distanceKm / AVG_DELIVERY_SPEED_KMH) * 60.0
            estimate += travelMinutes
        }

        // Aplicar multiplicador por hora del dia
        val hourMultiplier = HOUR_MULTIPLIERS.getOrDefault(hourOfDay, 1.0)
        estimate *= hourMultiplier

        // Aplicar multiplicador por dia de la semana
        val dayMultiplier = DAY_MULTIPLIERS.getOrDefault(dayOfWeek, 1.0)
        estimate *= dayMultiplier

        return estimate
    }

    /**
     * Obtiene un promedio historico ponderado considerando hora y dia.
     * Prioriza datos de la misma franja horaria, luego del mismo dia,
     * y finalmente el promedio general.
     */
    internal fun getWeightedHistoricalAvg(business: String, hourOfDay: Int, dayOfWeek: Int): Double? {
        val byHour = estimationRepository.getHistoricalAverageByHour(business, hourOfDay)
        val byDay = estimationRepository.getHistoricalAverageByDayOfWeek(business, dayOfWeek)
        val general = estimationRepository.getHistoricalAverage(business)

        // Priorizar datos mas especificos
        return when {
            byHour != null && byDay != null -> byHour * 0.5 + byDay * 0.3 + (general ?: byHour) * 0.2
            byHour != null -> byHour * 0.7 + (general ?: byHour) * 0.3
            byDay != null -> byDay * 0.6 + (general ?: byDay) * 0.4
            general != null -> general
            else -> null
        }
    }

    /**
     * Combina la estimacion del modelo con el historico usando pesos.
     */
    internal fun combineEstimates(modelEstimate: Double, historicalAvg: Double?): Int {
        if (historicalAvg == null) {
            return modelEstimate.roundToInt().coerceAtLeast(5)
        }
        val combined = modelEstimate * MODEL_WEIGHT + historicalAvg * HISTORICAL_WEIGHT
        return combined.roundToInt().coerceAtLeast(5)
    }

    /**
     * Calcula la confianza de la estimacion (0.0 a 1.0).
     * Mayor cantidad de datos historicos = mayor confianza.
     */
    internal fun calculateConfidence(historicalAvg: Double?, business: String): Double {
        val recordCount = estimationRepository.listRecords(business)
            .count { it.actualMinutes != null }

        return when {
            recordCount >= 50 && historicalAvg != null -> 0.95
            recordCount >= 20 && historicalAvg != null -> 0.85
            recordCount >= MIN_HISTORICAL_RECORDS && historicalAvg != null -> 0.70
            recordCount > 0 -> 0.50
            else -> 0.30 // Sin datos historicos, solo modelo basico
        }
    }

    /**
     * Formatea el texto de estimacion para mostrar al cliente.
     */
    internal fun formatDisplayText(minMinutes: Int, maxMinutes: Int): String {
        return when {
            maxMinutes <= 15 -> "Tu pedido llega en ~${maxMinutes} minutos"
            maxMinutes <= 30 -> "Tu pedido llega en ~${(minMinutes + maxMinutes) / 2} minutos"
            maxMinutes <= 60 -> "Tu pedido llega en $minMinutes-$maxMinutes minutos"
            else -> {
                val minHours = minMinutes / 60
                val maxHours = (maxMinutes + 59) / 60
                if (minHours == maxHours) "Tu pedido llega en ~$minHours hora${if (minHours > 1) "s" else ""}"
                else "Tu pedido llega en $minHours-$maxHours horas"
            }
        }
    }

    private fun Double.roundToInt(): Int = this.toInt().let { truncated ->
        if (this - truncated >= 0.5) truncated + 1 else truncated
    }
}
