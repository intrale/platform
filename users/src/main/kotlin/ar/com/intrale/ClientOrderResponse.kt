package ar.com.intrale

import io.ktor.http.HttpStatusCode

data class ClientOrderListResponse(
    val orders: List<ClientOrderPayload> = emptyList(),
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class ClientOrderDetailResponse(
    val order: ClientOrderPayload? = null,
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)
