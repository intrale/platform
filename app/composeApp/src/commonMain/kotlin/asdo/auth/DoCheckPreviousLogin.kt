// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.auth

import ext.storage.CommKeyValueStorage

class DoCheckPreviousLogin(val commKeyValueStorage: CommKeyValueStorage): ToDoCheckPreviousLogin {
    override suspend fun execute(): Boolean {
        return commKeyValueStorage.token!=null
    }
}