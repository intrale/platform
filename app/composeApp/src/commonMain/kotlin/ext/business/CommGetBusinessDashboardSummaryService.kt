// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.business

import ar.com.intrale.shared.business.BusinessDashboardSummaryDTO

interface CommGetBusinessDashboardSummaryService {
    suspend fun execute(businessId: String): Result<BusinessDashboardSummaryDTO>
}
