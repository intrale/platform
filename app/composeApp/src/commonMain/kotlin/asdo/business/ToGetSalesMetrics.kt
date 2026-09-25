// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

import ar.com.intrale.shared.business.DailySalesMetricsDTO

interface ToGetSalesMetrics {
    suspend fun execute(businessId: String): Result<DailySalesMetricsDTO>
}
