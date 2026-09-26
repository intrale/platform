// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

import ar.com.intrale.shared.business.RegisterBusinessResponse

interface ToDoRegisterBusiness {
    suspend fun execute(name: String, emailAdmin: String, description: String): Result<RegisterBusinessResponse>
}
