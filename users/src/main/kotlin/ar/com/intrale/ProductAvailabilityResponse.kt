package ar.com.intrale

import ar.com.intrale.shared.client.ProductAvailabilityResponseDTO
import io.ktor.http.HttpStatusCode

class ProductAvailabilityResponse(
    val availability: ProductAvailabilityResponseDTO,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)
