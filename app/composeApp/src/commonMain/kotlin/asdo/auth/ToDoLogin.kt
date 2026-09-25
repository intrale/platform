// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.auth

interface ToDoLogin {

    suspend fun execute(
        user: String,
        password: String,
        newPassword: String? = null,
        name: String? = null,
        familyName: String? = null
    ): Result<DoLoginResult>

}