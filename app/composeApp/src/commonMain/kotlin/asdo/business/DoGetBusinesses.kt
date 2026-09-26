// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

import ext.business.CommSearchBusinessesService
import ar.com.intrale.shared.business.SearchBusinessesResponse

class DoGetBusinesses(private val service: CommSearchBusinessesService) : ToGetBusinesses {
    override suspend fun execute(
        query: String,
        status: String?,
        limit: Int?,
        lastKey: String?
    ): Result<SearchBusinessesResponse> = service.execute(query, status, limit, lastKey)
}
