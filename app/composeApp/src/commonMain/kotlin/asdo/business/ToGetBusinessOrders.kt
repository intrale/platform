// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

interface ToGetBusinessOrders {
    suspend fun execute(businessId: String): Result<List<BusinessOrder>>
}
