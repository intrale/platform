// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.delivery

import ar.com.intrale.shared.delivery.DeliveryProfileDTO
import ar.com.intrale.shared.delivery.DeliveryProfileResponse

interface CommDeliveryProfileService {
    suspend fun fetchProfile(): Result<DeliveryProfileResponse>
    suspend fun updateProfile(profile: DeliveryProfileDTO): Result<DeliveryProfileResponse>
}
