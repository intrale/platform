package asdo.business

import ar.com.intrale.shared.business.BusinessProductsResponse

interface ToGetBusinessProducts {
    suspend fun execute(
        businessId: String,
        status: String = "ALL"
    ): Result<BusinessProductsResponse>
}
