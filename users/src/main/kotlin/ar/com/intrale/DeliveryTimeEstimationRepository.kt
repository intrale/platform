package ar.com.intrale

import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * Registro historico de una entrega con estimado vs tiempo real.
 * Se usa para ajustar predicciones futuras.
 */
data class DeliveryTimeRecord(
    val orderId: String = "",
    val business: String = "",
    val estimatedMinutes: Int = 0,
    val actualMinutes: Int? = null,
    val distanceKm: Double? = null,
    val activeOrdersAtTime: Int = 0,
    val hourOfDay: Int = 0,
    val dayOfWeek: Int = 0,
    val createdAt: String = Instant.now().toString()
)

/**
 * Repositorio para registros historicos de estimacion de tiempo de entrega.
 * Almacena datos de entregas pasadas para mejorar predicciones futuras
 * mediante promedios ponderados.
 */
class DeliveryTimeEstimationRepository {

    private val records = ConcurrentHashMap<String, MutableList<DeliveryTimeRecord>>()

    private fun businessKey(business: String) = business.lowercase()

    /**
     * Registra una nueva estimacion al confirmar un pedido.
     */
    fun recordEstimation(business: String, record: DeliveryTimeRecord): DeliveryTimeRecord {
        val saved = record.copy(createdAt = Instant.now().toString())
        records.getOrPut(businessKey(business)) { mutableListOf() }.add(saved)
        return saved
    }

    /**
     * Actualiza el tiempo real de entrega cuando se completa un pedido.
     * Permite comparar estimado vs real para mejorar predicciones.
     */
    fun recordActualTime(business: String, orderId: String, actualMinutes: Int): DeliveryTimeRecord? {
        val list = records[businessKey(business)] ?: return null
        val index = list.indexOfFirst { it.orderId == orderId }
        if (index == -1) return null
        val updated = list[index].copy(actualMinutes = actualMinutes)
        list[index] = updated
        return updated
    }

    /**
     * Obtiene el promedio historico de tiempos reales de entrega para un negocio.
     * Solo considera registros que tienen tiempo real (entregas completadas).
     */
    fun getHistoricalAverage(business: String): Double? {
        val list = records[businessKey(business)] ?: return null
        val completed = list.filter { it.actualMinutes != null }
        if (completed.isEmpty()) return null
        return completed.mapNotNull { it.actualMinutes }.average()
    }

    /**
     * Obtiene el promedio historico filtrado por hora del dia (+-2 horas).
     * Permite considerar variaciones por hora pico.
     */
    fun getHistoricalAverageByHour(business: String, hourOfDay: Int): Double? {
        val list = records[businessKey(business)] ?: return null
        val hourRange = ((hourOfDay - 2)..(hourOfDay + 2)).map { (it + 24) % 24 }.toSet()
        val filtered = list.filter { it.actualMinutes != null && it.hourOfDay in hourRange }
        if (filtered.isEmpty()) return null
        return filtered.mapNotNull { it.actualMinutes }.average()
    }

    /**
     * Obtiene el promedio historico filtrado por dia de la semana.
     */
    fun getHistoricalAverageByDayOfWeek(business: String, dayOfWeek: Int): Double? {
        val list = records[businessKey(business)] ?: return null
        val filtered = list.filter { it.actualMinutes != null && it.dayOfWeek == dayOfWeek }
        if (filtered.isEmpty()) return null
        return filtered.mapNotNull { it.actualMinutes }.average()
    }

    /**
     * Retorna todos los registros de un negocio (para tests y debugging).
     */
    fun listRecords(business: String): List<DeliveryTimeRecord> =
        records.getOrDefault(businessKey(business), mutableListOf()).map { it.copy() }

    /**
     * Obtiene el registro de estimacion de un pedido especifico.
     */
    fun getRecordByOrderId(business: String, orderId: String): DeliveryTimeRecord? =
        records[businessKey(business)]?.firstOrNull { it.orderId == orderId }?.copy()
}
