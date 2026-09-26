// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

interface ToDoAssignOrderDeliveryPerson {
    suspend fun execute(businessId: String, orderId: String, deliveryPersonEmail: String?): Result<BusinessOrder>
}
