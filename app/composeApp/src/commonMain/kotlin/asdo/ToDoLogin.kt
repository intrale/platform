package asdo

interface ToDoLogin {

    suspend fun execute(
        user: String,
        password: String,
        newPassword: String? = null,
        name: String? = null,
        familyName: String? = null
    ): Result<DoLoginResult>

}