// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.business

import ar.com.intrale.shared.business.InviteDeliveryPersonResponseDTO

interface CommInviteDeliveryPersonService {
    suspend fun invite(businessId: String, email: String): Result<InviteDeliveryPersonResponseDTO>
}
