package ext.business

import ar.com.intrale.shared.business.BusinessOrderDetailDTO

interface CommGetBusinessOrderDetailService {
    suspend fun getOrderDetail(businessId: String, orderId: String): Result<BusinessOrderDetailDTO>
}
