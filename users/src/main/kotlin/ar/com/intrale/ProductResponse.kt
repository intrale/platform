package ar.com.intrale

import io.ktor.http.HttpStatusCode

data class ProductPayload(
    val id: String,
    val businessId: String,
    val name: String,
    val shortDescription: String?,
    val basePrice: Double,
    val unit: String,
    val categoryId: String,
    val status: String,
    val isAvailable: Boolean,
    val stockQuantity: Int?
)

class ProductResponse(
    val product: ProductPayload?,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

class ProductListResponse(
    val products: List<ProductPayload>,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

fun ProductRecord.toPayload() = ProductPayload(
    id = id,
    businessId = businessId,
    name = name,
    shortDescription = shortDescription,
    basePrice = basePrice,
    unit = unit,
    categoryId = categoryId,
    status = status,
    isAvailable = isAvailable,
    stockQuantity = stockQuantity
)
