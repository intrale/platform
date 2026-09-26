// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.business

import ar.com.intrale.shared.business.RegisterBusinessResponse

interface CommRegisterBusinessService {
    suspend fun execute(name: String, emailAdmin: String, description: String): Result<RegisterBusinessResponse>
}
