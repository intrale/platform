package ar.com.intrale

import org.slf4j.helpers.NOPLogger
import java.time.DayOfWeek
import java.time.LocalDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DeliveryTimeEstimationServiceTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val estimationRepository = DeliveryTimeEstimationRepository()
    private val clientOrderRepository = ClientOrderRepository()
    private val deliveryOrderRepository = DeliveryOrderRepository()

    private val service = DeliveryTimeEstimationService(
        logger, estimationRepository, clientOrderRepository, deliveryOrderRepository
    )

    // Lunes 10:00 AM (hora normal, no pico)
    private val normalTime = LocalDateTime.of(2026, 3, 30, 10, 0)

    // Viernes 13:00 PM (hora pico almuerzo + viernes)
    private val peakTime = LocalDateTime.of(2026, 4, 3, 13, 0)

    @Test
    fun `estimacion basica sin pedidos activos ni historico`() {
        val result = service.estimate(business = "pizzeria", now = normalTime)

        // Sin pedidos activos: solo tiempo base (15 min)
        assertTrue(result.estimatedMinutes >= 5, "Estimado debe ser al menos 5 minutos")
        assertTrue(result.estimatedMinutes <= 30, "Estimado sin carga no debe superar 30 minutos")
        assertEquals(0, result.activeOrders)
        assertNull(result.historicalAvgMinutes)
        assertEquals(0.30, result.confidence) // Sin historico, confianza baja
        assertTrue(result.displayText.isNotBlank())
    }

    @Test
    fun `estimacion considera pedidos activos en cola`() {
        // Crear pedidos activos
        clientOrderRepository.createOrder("pizzeria", "client1@test.com",
            ClientOrderPayload(status = "PENDING", businessName = "pizzeria"))
        clientOrderRepository.createOrder("pizzeria", "client2@test.com",
            ClientOrderPayload(status = "PREPARING", businessName = "pizzeria"))
        clientOrderRepository.createOrder("pizzeria", "client3@test.com",
            ClientOrderPayload(status = "DELIVERED", businessName = "pizzeria")) // No cuenta

        val result = service.estimate(business = "pizzeria", now = normalTime)

        assertEquals(2, result.activeOrders) // Solo PENDING y PREPARING
        // 15 base + 2*5 = 25, el estimado debe reflejar la carga
        assertTrue(result.estimatedMinutes > 15, "Con pedidos activos el estimado debe ser mayor al base")
    }

    @Test
    fun `estimacion incluye tiempo de traslado por distancia`() {
        val resultSinDistancia = service.estimate(business = "cafe", now = normalTime)
        val resultConDistancia = service.estimate(business = "cafe", distanceKm = 5.0, now = normalTime)

        assertTrue(
            resultConDistancia.estimatedMinutes > resultSinDistancia.estimatedMinutes,
            "Con distancia el estimado debe ser mayor"
        )
        assertEquals(5.0, resultConDistancia.distanceKm)
    }

    @Test
    fun `hora pico incrementa la estimacion`() {
        val resultNormal = service.estimate(business = "empanadas", now = normalTime) // 10 AM
        val resultPico = service.estimate(business = "empanadas", now = peakTime) // 13 PM viernes

        assertTrue(
            resultPico.estimatedMinutes >= resultNormal.estimatedMinutes,
            "En hora pico el estimado debe ser igual o mayor"
        )
    }

    @Test
    fun `historico mejora la confianza y ajusta estimado`() {
        // Sembrar datos historicos (>5 registros con tiempo real)
        repeat(10) { i ->
            estimationRepository.recordEstimation("panaderia", DeliveryTimeRecord(
                orderId = "order-hist-$i",
                business = "panaderia",
                estimatedMinutes = 20,
                hourOfDay = 10,
                dayOfWeek = 1 // Lunes
            ))
            estimationRepository.recordActualTime("panaderia", "order-hist-$i", actualMinutes = 25)
        }

        val result = service.estimate(business = "panaderia", now = normalTime)

        assertNotNull(result.historicalAvgMinutes)
        assertTrue(result.confidence > 0.30, "Con historico la confianza debe ser mayor")
        // El estimado deberia estar influenciado por el promedio real (25 min)
        assertTrue(result.estimatedMinutes >= 15, "El historico debe influir en la estimacion")
    }

    @Test
    fun `texto de display es correcto segun rango`() {
        // Test con estimacion corta
        val textCorto = service.formatDisplayText(10, 15)
        assertTrue(textCorto.contains("~15 minutos"), "Display corto: $textCorto")

        // Test con estimacion media
        val textMedio = service.formatDisplayText(20, 30)
        assertTrue(textMedio.contains("~25 minutos"), "Display medio: $textMedio")

        // Test con estimacion larga
        val textLargo = service.formatDisplayText(35, 50)
        assertTrue(textLargo.contains("35-50 minutos"), "Display largo: $textLargo")
    }

    @Test
    fun `modelo calcula correctamente sin multiplicadores`() {
        // Hora sin multiplicador (10 AM, lunes = dia sin multiplicador)
        val estimate = service.calculateModelEstimate(
            activeOrders = 3,
            distanceKm = 2.0,
            hourOfDay = 10,
            dayOfWeek = 1 // Lunes
        )

        // Base(15) + activeOrders(3*5=15) + distancia(2/25*60=4.8) = 34.8
        assertTrue(estimate > 30.0 && estimate < 40.0,
            "Modelo basico: esperado ~34.8, obtenido $estimate")
    }

    @Test
    fun `modelo aplica multiplicador de hora pico`() {
        val estimateNormal = service.calculateModelEstimate(0, null, 10, 1)
        val estimatePico = service.calculateModelEstimate(0, null, 13, 1)

        assertTrue(estimatePico > estimateNormal,
            "Hora pico (13h) debe dar mayor estimado que hora normal (10h)")
    }

    @Test
    fun `modelo aplica multiplicador de dia viernes`() {
        val estimateLunes = service.calculateModelEstimate(0, null, 10, 1)
        val estimateViernes = service.calculateModelEstimate(0, null, 10, 5)

        assertTrue(estimateViernes > estimateLunes,
            "Viernes debe dar mayor estimado que lunes")
    }

    @Test
    fun `estimacion minima es 5 minutos`() {
        val result = service.estimate(business = "vacio", now = normalTime)
        assertTrue(result.minMinutes >= 5, "Minimo debe ser al menos 5 minutos")
        assertTrue(result.estimatedMinutes >= 5, "Estimado debe ser al menos 5 minutos")
    }

    @Test
    fun `combinar estimados sin historico usa solo modelo`() {
        val combined = service.combineEstimates(30.0, null)
        assertEquals(30, combined)
    }

    @Test
    fun `combinar estimados con historico usa pesos`() {
        // Modelo: 20, Historico: 40
        // Resultado: 20*0.4 + 40*0.6 = 8 + 24 = 32
        val combined = service.combineEstimates(20.0, 40.0)
        assertEquals(32, combined)
    }

    @Test
    fun `confianza escala con cantidad de registros historicos`() {
        val confSinDatos = service.calculateConfidence(null, "nuevo")
        assertEquals(0.30, confSinDatos)

        // Agregar pocos registros
        repeat(3) { i ->
            estimationRepository.recordEstimation("medio", DeliveryTimeRecord(
                orderId = "o-$i", business = "medio", estimatedMinutes = 20
            ))
            estimationRepository.recordActualTime("medio", "o-$i", 22)
        }
        val confPoco = service.calculateConfidence(22.0, "medio")
        assertEquals(0.50, confPoco)

        // Agregar mas registros (total 10)
        repeat(7) { i ->
            estimationRepository.recordEstimation("medio", DeliveryTimeRecord(
                orderId = "o-extra-$i", business = "medio", estimatedMinutes = 20
            ))
            estimationRepository.recordActualTime("medio", "o-extra-$i", 22)
        }
        val confBuena = service.calculateConfidence(22.0, "medio")
        assertEquals(0.70, confBuena)
    }

    @Test
    fun `negocios distintos tienen estimaciones independientes`() {
        clientOrderRepository.createOrder("pizza", "c@test.com",
            ClientOrderPayload(status = "PENDING", businessName = "pizza"))
        clientOrderRepository.createOrder("pizza", "c2@test.com",
            ClientOrderPayload(status = "PENDING", businessName = "pizza"))

        val resultPizza = service.estimate(business = "pizza", now = normalTime)
        val resultSushi = service.estimate(business = "sushi", now = normalTime)

        assertTrue(resultPizza.activeOrders > resultSushi.activeOrders,
            "Pizza tiene pedidos activos, sushi no")
    }
}
