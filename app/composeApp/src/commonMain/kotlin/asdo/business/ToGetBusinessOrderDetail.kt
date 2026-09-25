// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

interface ToGetBusinessOrderDetail {
    suspend fun execute(businessId: String, orderId: String): Result<BusinessOrderDetail>
}
