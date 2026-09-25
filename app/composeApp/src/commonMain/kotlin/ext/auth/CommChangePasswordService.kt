// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.auth

import ar.com.intrale.shared.auth.ChangePasswordResponse

interface CommChangePasswordService {
    suspend fun execute(oldPassword: String, newPassword: String, token: String): Result<ChangePasswordResponse>
}
