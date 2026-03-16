package asdo.business

import ext.business.CommGetBusinessDashboardSummaryService
import ar.com.intrale.shared.business.BusinessDashboardSummaryDTO

class DoGetBusinessDashboardSummary(
    private val service: CommGetBusinessDashboardSummaryService
) : ToGetBusinessDashboardSummary {
    override suspend fun execute(businessId: String): Result<BusinessDashboardSummaryDTO> =
        service.execute(businessId)
}
