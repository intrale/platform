// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.signup

import ar.com.intrale.shared.auth.RegisterSalerResponse

interface CommRegisterSalerService {
    suspend fun execute(email: String, token: String): Result<RegisterSalerResponse>
}
