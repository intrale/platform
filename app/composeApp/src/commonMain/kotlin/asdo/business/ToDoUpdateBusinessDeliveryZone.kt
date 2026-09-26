// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

import ar.com.intrale.shared.business.BusinessDeliveryZoneDTO
import ar.com.intrale.shared.business.UpdateBusinessDeliveryZoneRequest

interface ToDoUpdateBusinessDeliveryZone {
    suspend fun execute(businessId: String, request: UpdateBusinessDeliveryZoneRequest): Result<BusinessDeliveryZoneDTO>
}
