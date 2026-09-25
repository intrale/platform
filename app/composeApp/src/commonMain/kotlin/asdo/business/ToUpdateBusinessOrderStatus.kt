// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

interface ToUpdateBusinessOrderStatus {
    suspend fun execute(
        businessId: String,
        orderId: String,
        newStatus: BusinessOrderStatus,
        reason: String? = null
    ): Result<BusinessOrderStatusUpdateResult>
}
