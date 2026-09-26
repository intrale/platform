// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.auth

import ext.storage.CommKeyValueStorage

class DoResetLoginCache(val commKeyValueStorage: CommKeyValueStorage) : ToDoResetLoginCache {
    override suspend fun execute() {
        commKeyValueStorage.token = null
        commKeyValueStorage.profileCache = null
        commKeyValueStorage.preferredLanguage = null
    }
}
