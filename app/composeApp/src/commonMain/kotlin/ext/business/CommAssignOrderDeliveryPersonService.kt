// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.business

import ar.com.intrale.shared.business.BusinessOrderDTO

interface CommAssignOrderDeliveryPersonService {
    suspend fun assignDeliveryPerson(
        businessId: String,
        orderId: String,
        deliveryPersonEmail: String?
    ): Result<BusinessOrderDTO>
}
