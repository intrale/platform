package ext.business

import ext.dto.StatusCodeDTO
import kotlinx.serialization.Serializable

val AVAILABLE_FONTS: List<String> = listOf(
    "Intrale-Regular",
    "Intrale-Medium",
    "Intrale-SemiBold",
    "Roboto-Regular",
    "Roboto-Medium",
    "Roboto-Bold",
    "OpenSans-Regular",
    "OpenSans-SemiBold",
    "OpenSans-Bold",
    "Lato-Light",
    "Lato-Regular",
    "Lato-Bold",
    "Montserrat-Regular",
    "Montserrat-Medium",
    "Montserrat-Bold",
    "Poppins-Regular",
    "Poppins-Medium",
    "Poppins-Bold"
)

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
