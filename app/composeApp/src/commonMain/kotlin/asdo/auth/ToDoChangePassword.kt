// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.auth

interface ToDoChangePassword {
    suspend fun execute(oldPassword: String, newPassword: String): Result<DoChangePasswordResult>
}
