// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.business

import ar.com.intrale.shared.business.ReviewBusinessRegistrationResponse

interface CommReviewBusinessRegistrationService {
    suspend fun execute(
        publicId: String,
        decision: String,
        twoFactorCode: String,
        token: String
    ): Result<ReviewBusinessRegistrationResponse>
}
