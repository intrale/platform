// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

import ar.com.intrale.shared.business.ReviewBusinessRegistrationResponse

interface ToDoReviewBusinessRegistration {
    suspend fun execute(publicId: String, decision: String, twoFactorCode: String): Result<ReviewBusinessRegistrationResponse>
}
