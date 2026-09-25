// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.auth

interface ToDoConfirmPasswordRecovery {
    suspend fun execute(email: String, code: String, password: String): Result<DoConfirmPasswordRecoveryResult>
}
