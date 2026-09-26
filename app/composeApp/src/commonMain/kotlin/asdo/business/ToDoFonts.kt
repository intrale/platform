// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

import ar.com.intrale.shared.business.FontsDTO
import ar.com.intrale.shared.business.FontsRequest

interface ToDoGetFonts {
    suspend fun execute(businessId: String): Result<FontsDTO>
}

interface ToDoUpdateFonts {
    suspend fun execute(businessId: String, request: FontsRequest): Result<FontsDTO>
}
