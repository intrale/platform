// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.business

import ar.com.intrale.shared.business.DailySalesMetricsDTO

interface CommGetSalesMetricsService {
    suspend fun execute(businessId: String): Result<DailySalesMetricsDTO>
}
