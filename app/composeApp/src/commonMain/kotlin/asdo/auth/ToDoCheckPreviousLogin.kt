// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.auth

interface ToDoCheckPreviousLogin {
    suspend fun execute():Boolean
}