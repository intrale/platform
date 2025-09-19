package asdo.auth

interface ToDoChangePassword {
    suspend fun execute(oldPassword: String, newPassword: String): Result<DoChangePasswordResult>
}
