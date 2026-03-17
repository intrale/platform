package ar.com.intrale

import io.ktor.http.HttpStatusCode

data class ClientProductPayload(
    val id: String,
    val name: String,
    val basePrice: Double,
    val status: String,
    val emoji: String? = null,
    val isAvailable: Boolean,
    val stockQuantity: Int? = null
)

class ClientProductListResponse(
    val products: List<ClientProductPayload>,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

fun ProductRecord.toClientPayload() = ClientProductPayload(
    id = id,
    name = name,
    basePrice = basePrice,
    status = status,
    isAvailable = isAvailable,
    stockQuantity = stockQuantity
)
