package asdo.business

import ext.dto.BusinessProductsResponse

interface ToGetBusinessProducts {
    suspend fun execute(
        businessId: String,
        status: String = "ALL"
    ): Result<BusinessProductsResponse>
}
