package asdo.business

import ext.business.CommGetBusinessProductsService
import ext.dto.BusinessProductsResponse

class DoGetBusinessProducts(
    private val service: CommGetBusinessProductsService
) : ToGetBusinessProducts {
    override suspend fun execute(
        businessId: String,
        status: String
    ): Result<BusinessProductsResponse> = service.execute(businessId, status)
}
