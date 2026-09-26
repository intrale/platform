// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

interface ToDoGetBusinessDeliveryPeople {
    suspend fun execute(businessId: String): Result<List<DeliveryPersonSummary>>
}
