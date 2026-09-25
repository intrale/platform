// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.delivery

import ar.com.intrale.shared.delivery.DeliveryStateChangeResponse

interface CommDeliveryStateService {
    suspend fun changeState(orderId: String, newState: String): Result<DeliveryStateChangeResponse>
}
