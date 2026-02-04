package ext.business

import ext.dto.BusinessDashboardSummaryDTO

interface CommGetBusinessDashboardSummaryService {
    suspend fun execute(businessId: String): Result<BusinessDashboardSummaryDTO>
}
