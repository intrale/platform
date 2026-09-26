// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

interface ToDoInviteDeliveryPerson {
    suspend fun execute(businessId: String, email: String): Result<String>
}
