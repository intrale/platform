// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.delivery

interface ToDoDeliveryStateChange {
    suspend fun execute(orderId: String, newState: DeliveryState): Result<DeliveryStateChangeResult>
}
