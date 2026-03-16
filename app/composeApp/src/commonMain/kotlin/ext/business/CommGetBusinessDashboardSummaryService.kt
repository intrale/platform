package ext.business

import ar.com.intrale.shared.business.BusinessDashboardSummaryDTO

interface CommGetBusinessDashboardSummaryService {
    suspend fun execute(businessId: String): Result<BusinessDashboardSummaryDTO>
}
