// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

import ext.business.CommRequestJoinBusinessService
import ar.com.intrale.shared.business.RequestJoinBusinessResponse

class DoRequestJoinBusiness(private val service: CommRequestJoinBusinessService) : ToDoRequestJoinBusiness {
    override suspend fun execute(business: String): Result<RequestJoinBusinessResponse> =
        service.execute(business)
}
