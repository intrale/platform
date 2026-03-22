package ar.com.intrale

import io.ktor.http.HttpStatusCode

class ClientPaymentMethodsResponse(
    val paymentMethods: List<PaymentMethodRecord> = emptyList(),
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)
