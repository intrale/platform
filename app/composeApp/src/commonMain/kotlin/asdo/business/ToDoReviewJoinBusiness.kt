// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

import ar.com.intrale.shared.business.ReviewJoinBusinessResponse

interface ToDoReviewJoinBusiness {
    suspend fun execute(business: String, email: String, decision: String): Result<ReviewJoinBusinessResponse>
}
