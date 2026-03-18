package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class BannerDTO(
    val id: String? = null,
    val businessId: String? = null,
    val title: String = "",
    val text: String = "",
    val imageUrl: String = "",
    val position: String = "home",
    val active: Boolean = true
)

@Serializable
data class BannerRequest(
    val title: String = "",
    val text: String = "",
    val imageUrl: String = "",
    val position: String = "home",
    val active: Boolean = true
)

@Serializable
data class BannerListResponse(
    val statusCode: StatusCodeDTO? = null,
    val banners: List<BannerDTO> = emptyList()
)
