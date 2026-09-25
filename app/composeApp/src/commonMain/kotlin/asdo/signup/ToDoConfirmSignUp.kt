// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.signup

interface ToDoConfirmSignUp {
    suspend fun execute(email: String, code: String): Result<DoConfirmSignUpResult>
}
