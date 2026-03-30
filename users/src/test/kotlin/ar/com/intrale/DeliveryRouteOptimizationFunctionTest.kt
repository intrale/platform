package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class DeliveryRouteOptimizationFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val orderRepository = DeliveryOrderRepository()
    private val routeService = RouteOptimizationService()
    private val validator = LocalJwtValidator()

    private fun createFunction() = DeliveryRouteOptimizationFunction(
        config, logger, orderRepository, routeService, validator
    )

    @Test
    fun `POST optimiza ruta con paradas explicitas`() = runBlocking {
        val function = createFunction()
        val email = "driver@test.com"

        val body = """{
            "stops": [
                {"orderId": "o1", "address": "Palermo", "latitude": -34.5875, "longitude": -58.4112, "customerName": "Juan"},
                {"orderId": "o2", "address": "Belgrano", "latitude": -34.5603, "longitude": -58.4558, "customerName": "Maria"},
                {"orderId": "o3", "address": "Recoleta", "latitude": -34.5877, "longitude": -58.3933, "customerName": "Pedro"}
            ],
            "currentLatitude": -34.6037,
            "currentLongitude": -58.3816
        }"""

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/route-optimization",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "POST",
                "X-Function-Path" to "delivery/route-optimization"
            ),
            textBody = body
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is RouteOptimizationResponse)
        val route = response as RouteOptimizationResponse
        assertEquals(3, route.stops.size)
        assertTrue(route.totalDistanceKm > 0)
        assertNotNull(route.googleMapsUrl)
        // Verificar que las posiciones están numeradas correctamente
        assertEquals(1, route.stops[0].position)
        assertEquals(2, route.stops[1].position)
        assertEquals(3, route.stops[2].position)
    }

    @Test
    fun `POST con menos de 2 paradas retorna error de validacion`() = runBlocking {
        val function = createFunction()
        val email = "driver@test.com"

        val body = """{
            "stops": [
                {"orderId": "o1", "address": "Palermo", "latitude": -34.5875, "longitude": -58.4112}
            ]
        }"""

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/route-optimization",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "POST",
                "X-Function-Path" to "delivery/route-optimization"
            ),
            textBody = body
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `POST con paradas sin coordenadas retorna error`() = runBlocking {
        val function = createFunction()
        val email = "driver@test.com"

        val body = """{
            "stops": [
                {"orderId": "o1", "address": "Palermo"},
                {"orderId": "o2", "address": "Belgrano"}
            ]
        }"""

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/route-optimization",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "POST",
                "X-Function-Path" to "delivery/route-optimization"
            ),
            textBody = body
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `POST con body invalido retorna error de validacion`() = runBlocking {
        val function = createFunction()
        val email = "driver@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/route-optimization",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "POST",
                "X-Function-Path" to "delivery/route-optimization"
            ),
            textBody = "invalid json"
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `GET active sin pedidos retorna lista vacia con mensaje`() = runBlocking {
        val function = createFunction()
        val email = "driver@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/route-optimization/active",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/route-optimization/active"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is RouteOptimizationResponse)
        val route = response as RouteOptimizationResponse
        assertTrue(route.stops.isEmpty())
        assertEquals("No hay pedidos activos para optimizar", route.message)
    }

    @Test
    fun `GET active con un solo pedido retorna sin optimizacion`() = runBlocking {
        val function = createFunction()
        val email = "driver@test.com"

        orderRepository.createOrder("biz", DeliveryOrderPayload(
            status = "in_transit",
            assignedTo = email,
            address = "Av. Santa Fe 3200"
        ))

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/route-optimization/active",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/route-optimization/active"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val route = response as RouteOptimizationResponse
        assertEquals(1, route.stops.size)
        assertEquals("Solo hay un pedido activo, no se requiere optimizacion", route.message)
    }

    @Test
    fun `sin token retorna no autorizado`() = runBlocking {
        val function = createFunction()

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/route-optimization",
            headers = mapOf(
                "X-Http-Method" to "POST",
                "X-Function-Path" to "delivery/route-optimization"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.Unauthorized, response.statusCode)
    }

    @Test
    fun `metodo no soportado retorna error`() = runBlocking {
        val function = createFunction()
        val email = "driver@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/route-optimization",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "DELETE",
                "X-Function-Path" to "delivery/route-optimization"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `GET sub-ruta no soportada retorna error`() = runBlocking {
        val function = createFunction()
        val email = "driver@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/route-optimization/unknown",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/route-optimization/unknown"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }
}
