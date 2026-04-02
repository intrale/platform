package asdo.business

import ar.com.intrale.shared.business.DailySalesMetricsDTO
import ext.business.CommGetSalesMetricsService

class DoGetSalesMetrics(
    private val service: CommGetSalesMetricsService
) : ToGetSalesMetrics {
    override suspend fun execute(businessId: String): Result<DailySalesMetricsDTO> =
        service.execute(businessId)
}
