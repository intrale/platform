package asdo

import ext.CommKeyValueStorage

class DoResetLoginCache(val commKeyValueStorage: CommKeyValueStorage) : ToDoResetLoginCache {
    override suspend fun execute() {
        commKeyValueStorage.token = null
    }
}