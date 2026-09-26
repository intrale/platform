// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.business

import ar.com.intrale.shared.business.BusinessOrderDTO

interface CommGetBusinessOrdersService {
    suspend fun listOrders(businessId: String): Result<List<BusinessOrderDTO>>
}
