// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.auth

import ar.com.intrale.shared.auth.TwoFactorSetupResponse

interface CommTwoFactorSetupService {
    suspend fun execute(token: String): Result<TwoFactorSetupResponse>
}
