// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.signup

import ar.com.intrale.shared.auth.SignUpResponse

interface CommSignUpPlatformAdminService {
    suspend fun execute(email: String): Result<SignUpResponse>
}
