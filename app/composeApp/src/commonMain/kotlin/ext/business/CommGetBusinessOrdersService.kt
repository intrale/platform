package ext.business

import ar.com.intrale.shared.business.BusinessOrderDTO

interface CommGetBusinessOrdersService {
    suspend fun listOrders(businessId: String): Result<List<BusinessOrderDTO>>
}
