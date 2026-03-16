package ext.business

import ar.com.intrale.shared.business.BusinessProductsResponse

interface CommGetBusinessProductsService {
    suspend fun execute(
        businessId: String,
        status: String = "ALL"
    ): Result<BusinessProductsResponse>
}
