// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

interface ToDoListBusinessDeliveryPeople {
    suspend fun execute(businessId: String): Result<List<BusinessDeliveryPerson>>
}
