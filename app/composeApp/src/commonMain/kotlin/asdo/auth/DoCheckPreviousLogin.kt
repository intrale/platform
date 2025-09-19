package asdo.auth

import ext.storage.CommKeyValueStorage

class DoCheckPreviousLogin(val commKeyValueStorage: CommKeyValueStorage): ToDoCheckPreviousLogin {
    override suspend fun execute(): Boolean {
        return commKeyValueStorage.token!=null
    }
}