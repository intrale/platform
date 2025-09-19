package asdo.auth

import ext.storage.CommKeyValueStorage

class DoResetLoginCache(val commKeyValueStorage: CommKeyValueStorage) : ToDoResetLoginCache {
    override suspend fun execute() {
        commKeyValueStorage.token = null
    }
}