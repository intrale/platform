package ui.sc

import DIManager
import asdo.ToDoResetLoginCache
import org.kodein.di.instance

class HomeViewModel : ViewModel()  {

    private val toDoResetLoginCache: ToDoResetLoginCache by DIManager.di.instance()

    // data state initialize
    override fun getState(): Any  = Unit

    override fun initInputState() { /* Do nothing */ }

    suspend fun logout(){
        toDoResetLoginCache.execute()
    }
}