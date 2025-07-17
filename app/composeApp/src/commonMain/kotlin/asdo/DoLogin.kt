package  asdo

import ext.CommKeyValueStorage
import ext.CommLoginService
import ext.LoginResponse
import kotlin.Result

class DoLogin(val commLogin: CommLoginService, val commKeyValueStorage: CommKeyValueStorage) : ToDoLogin{

    override suspend fun execute(user: String, password: String): Result<String> {

        if (commKeyValueStorage.token==null) {
            val result: Result<LoginResponse> = commLogin.execute(user, password)
            return result.map { response ->
                //TODO: revisar esta forma de retornar el token
                commKeyValueStorage.token = response.accessToken
                response.accessToken!!
            }
        }

        return Result.success(commKeyValueStorage.token!!)
    }
}