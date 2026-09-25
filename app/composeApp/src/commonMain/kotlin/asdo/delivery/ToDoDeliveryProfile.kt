// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.delivery

interface ToDoGetDeliveryProfile {
    suspend fun execute(): Result<DeliveryProfileData>
}

interface ToDoUpdateDeliveryProfile {
    suspend fun execute(profile: DeliveryProfile): Result<DeliveryProfileData>
}
