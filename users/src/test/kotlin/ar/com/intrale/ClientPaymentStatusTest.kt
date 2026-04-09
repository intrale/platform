package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ClientPaymentStatusTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val repository = ClientOrderRepository()
    private val validator = LocalJwtValidator()

    @Test
    fun `consultar estado de pago de pedido existente retorna PENDING por defecto`() = runBlocking {
        val function = ClientPaymentStatus(config, logger, repository, validator)
        val email = "client@test.com"

        repository.createOrder("biz", email, ClientOrderPayload(
            id = "order-pay-1",
            status = "PENDING",
            items = listOf(ClientOrderItemPayload(productId = "p1", productName = "Pizza", quantity = 1, unitPrice = 15.0, subtotal = 15.0)),
            total = 15.0
        ))

        val response = function.securedExecute(
            business = "biz",
            function = "client/payment-status/order-pay-1",
            headers = mapOf("Authorization" to validator.generateToken(email)),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is PaymentStatusResponse)
        val paymentResponse = response as PaymentStatusResponse
        assertEquals("order-pay-1", paymentResponse.orderId)
        assertEquals("PENDING", paymentResponse.paymentStatus)
        assertNull(paymentResponse.paymentId)
        assertNull(paymentResponse.paymentMethod)
        assertNull(paymentResponse.paidAmount)
        assertNull(paymentResponse.failureReason)
    }

    @Test
    fun `consultar estado de pago aprobado retorna datos completos`() = runBlocking {
        val function = ClientPaymentStatus(config, logger, repository, validator)
        val email = "client@test.com"

        repository.createOrder("biz", email, ClientOrderPayload(
            id = "order-pay-2",
            status = "CONFIRMED",
            items = listOf(ClientOrderItemPayload(productId = "p1", productName = "Empanadas", quantity = 12, unitPrice = 1.5, subtotal = 18.0)),
            total = 18.0,
            paymentStatus = "APPROVED",
            paymentId = "mp-12345",
            paymentMethod = "MERCADOPAGO",
            paidAmount = 18.0
        ))

        val response = function.securedExecute(
            business = "biz",
            function = "client/payment-status/order-pay-2",
            headers = mapOf("Authorization" to validator.generateToken(email)),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is PaymentStatusResponse)
        val paymentResponse = response as PaymentStatusResponse
        assertEquals("order-pay-2", paymentResponse.orderId)
        assertEquals("APPROVED", paymentResponse.paymentStatus)
        assertEquals("mp-12345", paymentResponse.paymentId)
        assertEquals("MERCADOPAGO", paymentResponse.paymentMethod)
        assertEquals(18.0, paymentResponse.paidAmount)
        assertNull(paymentResponse.failureReason)
    }

    @Test
    fun `consultar estado de pago rechazado retorna motivo`() = runBlocking {
        val function = ClientPaymentStatus(config, logger, repository, validator)
        val email = "client@test.com"

        repository.createOrder("biz", email, ClientOrderPayload(
            id = "order-pay-3",
            status = "PENDING",
            items = listOf(ClientOrderItemPayload(productId = "p1", productName = "Milanesa", quantity = 1, unitPrice = 12.0, subtotal = 12.0)),
            total = 12.0,
            paymentStatus = "REJECTED",
            paymentId = "mp-99999",
            paymentMethod = "CARD",
            failureReason = "cc_rejected_insufficient_amount"
        ))

        val response = function.securedExecute(
            business = "biz",
            function = "client/payment-status/order-pay-3",
            headers = mapOf("Authorization" to validator.generateToken(email)),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is PaymentStatusResponse)
        val paymentResponse = response as PaymentStatusResponse
        assertEquals("REJECTED", paymentResponse.paymentStatus)
        assertEquals("cc_rejected_insufficient_amount", paymentResponse.failureReason)
    }

    @Test
    fun `pedido inexistente retorna not found`() = runBlocking {
        val function = ClientPaymentStatus(config, logger, repository, validator)
        val email = "client@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "client/payment-status/nonexistent",
            headers = mapOf("Authorization" to validator.generateToken(email)),
            textBody = ""
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `sin orderId retorna error de validacion`() = runBlocking {
        val function = ClientPaymentStatus(config, logger, repository, validator)
        val email = "client@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "client/payment-status",
            headers = mapOf("Authorization" to validator.generateToken(email)),
            textBody = ""
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `sin token retorna no autorizado`() = runBlocking {
        val function = ClientPaymentStatus(config, logger, repository, validator)

        val response = function.securedExecute(
            business = "biz",
            function = "client/payment-status/order-pay-1",
            headers = emptyMap(),
            textBody = ""
        )

        assertEquals(HttpStatusCode.Unauthorized, response.statusCode)
    }
}
