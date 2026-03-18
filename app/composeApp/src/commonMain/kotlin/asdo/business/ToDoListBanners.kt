package asdo.business

import ar.com.intrale.shared.business.BannerDTO
import ar.com.intrale.shared.business.BannerRequest

interface ToDoListBanners {
    suspend fun execute(businessId: String): Result<List<BannerDTO>>
}

interface ToDoCreateBanner {
    suspend fun execute(businessId: String, request: BannerRequest): Result<BannerDTO>
}

interface ToDoUpdateBanner {
    suspend fun execute(
        businessId: String,
        bannerId: String,
        request: BannerRequest
    ): Result<BannerDTO>
}

interface ToDoToggleBanner {
    suspend fun execute(
        businessId: String,
        bannerId: String,
        active: Boolean
    ): Result<BannerDTO>
}
