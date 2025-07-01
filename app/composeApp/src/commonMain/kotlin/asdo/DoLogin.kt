package  asdo

import ext.CommKeyValueStorage
import ext.CommLoginService
import ext.LoginResponse

class DoLogin(val commLogin: CommLoginService, val commKeyValueStorage: CommKeyValueStorage) : ToDoLogin{

    override suspend fun execute(user: String, password: String): String {

        if (commKeyValueStorage.token==null) {
            val response: LoginResponse = commLogin.execute(user, password)
            commKeyValueStorage.token = response.token


            return response.token
        }

        return commKeyValueStorage.token!!
    }
}