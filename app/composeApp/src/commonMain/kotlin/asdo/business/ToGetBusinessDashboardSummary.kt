// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

import ar.com.intrale.shared.business.BusinessDashboardSummaryDTO

interface ToGetBusinessDashboardSummary {
    suspend fun execute(businessId: String): Result<BusinessDashboardSummaryDTO>
}
