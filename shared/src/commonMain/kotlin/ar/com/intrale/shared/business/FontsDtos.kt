package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class FontsDTO(
    val fonts: Map<String, String> = emptyMap()
)

@Serializable
data class FontsRequest(
    val fonts: Map<String, String>
)

@Serializable
data class FontsResponse(
    val statusCode: StatusCodeDTO? = null,
    val fonts: Map<String, String> = emptyMap()
)
