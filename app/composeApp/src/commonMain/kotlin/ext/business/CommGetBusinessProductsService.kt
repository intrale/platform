package ext.business

import ext.dto.BusinessProductsResponse

interface CommGetBusinessProductsService {
    suspend fun execute(
        businessId: String,
        status: String = "ALL"
    ): Result<BusinessProductsResponse>
}
