package asdo

interface ToDoLogin {

    suspend fun execute(user:String, password:String):String

}