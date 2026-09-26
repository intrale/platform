// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.auth

interface ToDoPasswordRecovery {
    suspend fun execute(email: String): Result<DoPasswordRecoveryResult>
}
