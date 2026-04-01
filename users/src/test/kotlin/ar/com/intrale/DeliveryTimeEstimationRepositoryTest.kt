package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DeliveryTimeEstimationRepositoryTest {
    private val repository = DeliveryTimeEstimationRepository()

    @Test
    fun `registrar estimacion y recuperarla por orderId`() {
        val record = DeliveryTimeRecord(
            orderId = "order-1",
            business = "pizzeria",
            estimatedMinutes = 30,
            distanceKm = 2.5,
            activeOrdersAtTime = 3,
            hourOfDay = 13,
            dayOfWeek = 5
        )

        repository.recordEstimation("pizzeria", record)

        val retrieved = repository.getRecordByOrderId("pizzeria", "order-1")
        assertNotNull(retrieved)
        assertEquals("order-1", retrieved.orderId)
        assertEquals(30, retrieved.estimatedMinutes)
        assertEquals(2.5, retrieved.distanceKm)
    }

    @Test
    fun `registrar tiempo real de entrega`() {
        repository.recordEstimation("cafe", DeliveryTimeRecord(
            orderId = "order-2", business = "cafe", estimatedMinutes = 20
        ))

        val updated = repository.recordActualTime("cafe", "order-2", 25)

        assertNotNull(updated)
        assertEquals(20, updated.estimatedMinutes)
        assertEquals(25, updated.actualMinutes)
    }

    @Test
    fun `registrar tiempo real para orden inexistente retorna null`() {
        val result = repository.recordActualTime("cafe", "inexistente", 20)
        assertNull(result)
    }

    @Test
    fun `promedio historico general con datos completos`() {
        repeat(5) { i ->
            repository.recordEstimation("sushi", DeliveryTimeRecord(
                orderId = "o-$i", business = "sushi", estimatedMinutes = 20
            ))
            repository.recordActualTime("sushi", "o-$i", 20 + i) // 20, 21, 22, 23, 24
        }

        val avg = repository.getHistoricalAverage("sushi")
        assertNotNull(avg)
        assertEquals(22.0, avg) // Promedio de 20..24
    }

    @Test
    fun `promedio historico ignora registros sin tiempo real`() {
        repository.recordEstimation("burgers", DeliveryTimeRecord(
            orderId = "o-1", business = "burgers", estimatedMinutes = 20
        ))
        repository.recordActualTime("burgers", "o-1", 25)

        repository.recordEstimation("burgers", DeliveryTimeRecord(
            orderId = "o-2", business = "burgers", estimatedMinutes = 15
        ))
        // No registramos tiempo real para o-2

        val avg = repository.getHistoricalAverage("burgers")
        assertNotNull(avg)
        assertEquals(25.0, avg) // Solo cuenta o-1
    }

    @Test
    fun `promedio historico sin datos retorna null`() {
        val avg = repository.getHistoricalAverage("nuevo-negocio")
        assertNull(avg)
    }

    @Test
    fun `promedio historico por hora filtra correctamente`() {
        // Registros a las 13h
        repeat(3) { i ->
            repository.recordEstimation("empanadas", DeliveryTimeRecord(
                orderId = "h13-$i", business = "empanadas", estimatedMinutes = 20, hourOfDay = 13
            ))
            repository.recordActualTime("empanadas", "h13-$i", 30)
        }

        // Registros a las 8h (fuera de rango +-2 de 13h)
        repeat(3) { i ->
            repository.recordEstimation("empanadas", DeliveryTimeRecord(
                orderId = "h8-$i", business = "empanadas", estimatedMinutes = 20, hourOfDay = 8
            ))
            repository.recordActualTime("empanadas", "h8-$i", 15)
        }

        val avgHour13 = repository.getHistoricalAverageByHour("empanadas", 13)
        assertNotNull(avgHour13)
        assertEquals(30.0, avgHour13) // Solo los de 13h
    }

    @Test
    fun `promedio historico por dia de la semana`() {
        // Viernes (5)
        repeat(3) { i ->
            repository.recordEstimation("heladeria", DeliveryTimeRecord(
                orderId = "v-$i", business = "heladeria", estimatedMinutes = 20, dayOfWeek = 5
            ))
            repository.recordActualTime("heladeria", "v-$i", 35)
        }

        // Lunes (1)
        repeat(3) { i ->
            repository.recordEstimation("heladeria", DeliveryTimeRecord(
                orderId = "l-$i", business = "heladeria", estimatedMinutes = 20, dayOfWeek = 1
            ))
            repository.recordActualTime("heladeria", "l-$i", 20)
        }

        val avgViernes = repository.getHistoricalAverageByDayOfWeek("heladeria", 5)
        assertNotNull(avgViernes)
        assertEquals(35.0, avgViernes)

        val avgLunes = repository.getHistoricalAverageByDayOfWeek("heladeria", 1)
        assertNotNull(avgLunes)
        assertEquals(20.0, avgLunes)
    }

    @Test
    fun `listar registros de un negocio`() {
        repeat(3) { i ->
            repository.recordEstimation("farmacia", DeliveryTimeRecord(
                orderId = "f-$i", business = "farmacia", estimatedMinutes = 15
            ))
        }

        val records = repository.listRecords("farmacia")
        assertEquals(3, records.size)
    }

    @Test
    fun `negocios distintos tienen datos separados`() {
        repository.recordEstimation("negocio-a", DeliveryTimeRecord(
            orderId = "a-1", business = "negocio-a", estimatedMinutes = 20
        ))
        repository.recordActualTime("negocio-a", "a-1", 25)

        repository.recordEstimation("negocio-b", DeliveryTimeRecord(
            orderId = "b-1", business = "negocio-b", estimatedMinutes = 10
        ))
        repository.recordActualTime("negocio-b", "b-1", 12)

        assertEquals(25.0, repository.getHistoricalAverage("negocio-a"))
        assertEquals(12.0, repository.getHistoricalAverage("negocio-b"))
    }
}
