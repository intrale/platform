// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

import ar.com.intrale.shared.business.BusinessSchedulesDTO
import ext.business.CommBusinessSchedulesService

class DoGetBusinessSchedules(
    private val service: CommBusinessSchedulesService
) : ToDoGetBusinessSchedules {
    override suspend fun execute(businessId: String): Result<BusinessSchedulesDTO> =
        service.getSchedules(businessId)
}
