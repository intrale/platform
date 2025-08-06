package ext

import kotlinx.serialization.Serializable

@Serializable
data class SearchBusinessesResponse(
    val statusCode: StatusCodeDTO,
    val businesses: List<BusinessDTO>,
    val lastKey: String? = null
)
