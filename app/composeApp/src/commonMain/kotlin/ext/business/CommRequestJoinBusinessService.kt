// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.business

import ar.com.intrale.shared.business.RequestJoinBusinessResponse

interface CommRequestJoinBusinessService {
    suspend fun execute(business: String): Result<RequestJoinBusinessResponse>
}
