package ui.sc.client

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

object AddressEditorStore {
    private val mutableDraft = MutableStateFlow<AddressDraft?>(null)

    val draft: StateFlow<AddressDraft?> = mutableDraft.asStateFlow()

    fun setDraft(draft: AddressDraft?) {
        mutableDraft.value = draft
    }

    fun update(transform: (AddressDraft?) -> AddressDraft?) {
        mutableDraft.update(transform)
    }

    fun clear() {
        mutableDraft.value = null
    }
}
