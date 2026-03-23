package ar.com.intrale

import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BusinessDeliveryPeopleFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val repo = DeliveryProfileRepository()
    private val gson = Gson()

    private val function = BusinessDeliveryPeopleFunction(
        config = config,
        logger = logger,
        deliveryProfileRepository = repo
    )

    @Test
    fun `GET devuelve lista vacia cuando no hay repartidores`() = runBlocking {
        val response = function.securedExecute(
            business = "biz",
            function = "business/delivery-people",
            headers = mapOf("X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is BusinessDeliveryPeopleListResponse)
        assertEquals(0, (response as BusinessDeliveryPeopleListResponse).deliveryPeople.size)
    }

    @Test
    fun `GET devuelve repartidores existentes del negocio`() = runBlocking {
        repo.invite("biz", "driver1@test.com")
        repo.invite("biz", "driver2@test.com")
        repo.toggleStatus("biz", "driver1@test.com", DeliveryPersonStatus.ACTIVE)

        val response = function.securedExecute(
            business = "biz",
            function = "business/delivery-people",
            headers = mapOf("X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val listResponse = response as BusinessDeliveryPeopleListResponse
        assertEquals(2, listResponse.deliveryPeople.size)
        val active = listResponse.deliveryPeople.find { it.email == "driver1@test.com" }
        assertEquals("ACTIVE", active?.status)
        val pending = listResponse.deliveryPeople.find { it.email == "driver2@test.com" }
        assertEquals("PENDING", pending?.status)
    }

    @Test
    fun `PUT status cambia estado del repartidor a ACTIVE`() = runBlocking {
        repo.invite("biz", "driver@test.com")

        val body = gson.toJson(ToggleDeliveryPersonStatusRequest(email = "driver@test.com", newStatus = "ACTIVE"))
        val response = function.securedExecute(
            business = "biz",
            function = "business/delivery-people/status",
            headers = mapOf("X-Http-Method" to "PUT"),
            textBody = body
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val toggle = response as ToggleDeliveryPersonStatusResponse
        assertEquals("driver@test.com", toggle.email)
        assertEquals("ACTIVE", toggle.newStatus)
    }

    @Test
    fun `PUT status cambia estado del repartidor a INACTIVE`() = runBlocking {
        repo.invite("biz", "driver@test.com")
        repo.toggleStatus("biz", "driver@test.com", DeliveryPersonStatus.ACTIVE)

        val body = gson.toJson(ToggleDeliveryPersonStatusRequest(email = "driver@test.com", newStatus = "INACTIVE"))
        val response = function.securedExecute(
            business = "biz",
            function = "business/delivery-people/status",
            headers = mapOf("X-Http-Method" to "PUT"),
            textBody = body
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val toggle = response as ToggleDeliveryPersonStatusResponse
        assertEquals("INACTIVE", toggle.newStatus)
    }

    @Test
    fun `PUT status con email vacio devuelve error de validacion`() = runBlocking {
        val body = gson.toJson(ToggleDeliveryPersonStatusRequest(email = "", newStatus = "ACTIVE"))
        val response = function.securedExecute(
            business = "biz",
            function = "business/delivery-people/status",
            headers = mapOf("X-Http-Method" to "PUT"),
            textBody = body
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `PUT status con estado invalido devuelve error de validacion`() = runBlocking {
        val body = gson.toJson(ToggleDeliveryPersonStatusRequest(email = "driver@test.com", newStatus = "INVALID"))
        val response = function.securedExecute(
            business = "biz",
            function = "business/delivery-people/status",
            headers = mapOf("X-Http-Method" to "PUT"),
            textBody = body
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `PUT status PENDING no esta permitido manualmente`() = runBlocking {
        val body = gson.toJson(ToggleDeliveryPersonStatusRequest(email = "driver@test.com", newStatus = "PENDING"))
        val response = function.securedExecute(
            business = "biz",
            function = "business/delivery-people/status",
            headers = mapOf("X-Http-Method" to "PUT"),
            textBody = body
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST invite registra nuevo repartidor como PENDING`() = runBlocking {
        val body = gson.toJson(InviteDeliveryPersonRequest(email = "new@test.com"))
        val response = function.securedExecute(
            business = "biz",
            function = "business/delivery-people/invite",
            headers = mapOf("X-Http-Method" to "POST"),
            textBody = body
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val invite = response as InviteDeliveryPersonResponse
        assertEquals("new@test.com", invite.email)
        assertTrue(invite.message.contains("new@test.com"))
    }

    @Test
    fun `POST invite con email vacio devuelve error de validacion`() = runBlocking {
        val body = gson.toJson(InviteDeliveryPersonRequest(email = ""))
        val response = function.securedExecute(
            business = "biz",
            function = "business/delivery-people/invite",
            headers = mapOf("X-Http-Method" to "POST"),
            textBody = body
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `metodo no soportado devuelve error de validacion`() = runBlocking {
        val response = function.securedExecute(
            business = "biz",
            function = "business/delivery-people",
            headers = mapOf("X-Http-Method" to "DELETE"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `PUT status con body invalido devuelve error de validacion`() = runBlocking {
        val response = function.securedExecute(
            business = "biz",
            function = "business/delivery-people/status",
            headers = mapOf("X-Http-Method" to "PUT"),
            textBody = "invalid json {"
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST invite con body invalido devuelve error de validacion`() = runBlocking {
        val response = function.securedExecute(
            business = "biz",
            function = "business/delivery-people/invite",
            headers = mapOf("X-Http-Method" to "POST"),
            textBody = "not json"
        )

        assertTrue(response is RequestValidationException)
    }
}
