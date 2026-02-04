package asdo.business

import ext.business.CommGetBusinessDashboardSummaryService
import ext.dto.BusinessDashboardSummaryDTO

class DoGetBusinessDashboardSummary(
    private val service: CommGetBusinessDashboardSummaryService
) : ToGetBusinessDashboardSummary {
    override suspend fun execute(businessId: String): Result<BusinessDashboardSummaryDTO> =
        service.execute(businessId)
}
