// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

interface ToDoToggleDeliveryPersonStatus {
    suspend fun execute(businessId: String, email: String, newStatus: BusinessDeliveryPersonStatus): Result<BusinessDeliveryPerson>
}
