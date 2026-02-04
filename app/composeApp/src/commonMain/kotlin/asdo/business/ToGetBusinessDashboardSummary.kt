package asdo.business

import ext.dto.BusinessDashboardSummaryDTO

interface ToGetBusinessDashboardSummary {
    suspend fun execute(businessId: String): Result<BusinessDashboardSummaryDTO>
}
