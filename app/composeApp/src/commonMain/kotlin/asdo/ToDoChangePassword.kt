package asdo

interface ToDoChangePassword {
    suspend fun execute(oldPassword: String, newPassword: String): Result<DoChangePasswordResult>
}
