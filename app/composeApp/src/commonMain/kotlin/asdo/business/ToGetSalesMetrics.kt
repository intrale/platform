package asdo.business

import ar.com.intrale.shared.business.DailySalesMetricsDTO

interface ToGetSalesMetrics {
    suspend fun execute(businessId: String): Result<DailySalesMetricsDTO>
}
