package ext.business

import ar.com.intrale.shared.business.BannerDTO
import ar.com.intrale.shared.business.BannerRequest

interface CommBannerService {
    suspend fun listBanners(businessId: String): Result<List<BannerDTO>>
    suspend fun createBanner(businessId: String, request: BannerRequest): Result<BannerDTO>
    suspend fun updateBanner(
        businessId: String,
        bannerId: String,
        request: BannerRequest
    ): Result<BannerDTO>

    suspend fun toggleBanner(
        businessId: String,
        bannerId: String,
        active: Boolean
    ): Result<BannerDTO>
}
