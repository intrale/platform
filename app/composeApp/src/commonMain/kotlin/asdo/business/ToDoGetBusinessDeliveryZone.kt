// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

import ar.com.intrale.shared.business.BusinessDeliveryZoneDTO

interface ToDoGetBusinessDeliveryZone {
    suspend fun execute(businessId: String): Result<BusinessDeliveryZoneDTO>
}
