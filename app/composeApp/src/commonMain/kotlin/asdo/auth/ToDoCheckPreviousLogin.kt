package asdo.auth

interface ToDoCheckPreviousLogin {
    suspend fun execute():Boolean
}