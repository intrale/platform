package asdo.business

import ar.com.intrale.shared.business.BannerDTO
import ar.com.intrale.shared.business.BannerRequest
import ext.business.CommBannerService

class DoListBanners(
    private val service: CommBannerService
) : ToDoListBanners {
    override suspend fun execute(businessId: String): Result<List<BannerDTO>> =
        service.listBanners(businessId)
}

class DoCreateBanner(
    private val service: CommBannerService
) : ToDoCreateBanner {
    override suspend fun execute(
        businessId: String,
        request: BannerRequest
    ): Result<BannerDTO> = service.createBanner(businessId, request)
}

class DoUpdateBanner(
    private val service: CommBannerService
) : ToDoUpdateBanner {
    override suspend fun execute(
        businessId: String,
        bannerId: String,
        request: BannerRequest
    ): Result<BannerDTO> = service.updateBanner(businessId, bannerId, request)
}

class DoToggleBanner(
    private val service: CommBannerService
) : ToDoToggleBanner {
    override suspend fun execute(
        businessId: String,
        bannerId: String,
        active: Boolean
    ): Result<BannerDTO> = service.toggleBanner(businessId, bannerId, active)
}
