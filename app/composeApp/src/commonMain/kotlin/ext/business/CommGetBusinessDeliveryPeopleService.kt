// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.business

import ar.com.intrale.shared.business.DeliveryPersonSummaryDTO

interface CommGetBusinessDeliveryPeopleService {
    suspend fun listDeliveryPeople(businessId: String): Result<List<DeliveryPersonSummaryDTO>>
}
