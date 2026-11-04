package app.murmur.android.phonemic

import android.content.Context
import android.os.Build
import android.util.Log
import app.murmur.android.cloud.CloudSync
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** What the Phone microphone screen shows. */
data class PhoneMicState(
    /** The desktops that can take this phone, null until listed. */
    val receivers: List<MicReceiverDto>? = null,
    val iceServers: List<MicIceServerDto> = emptyList(),
    val loading: Boolean = false,
    val loadError: String? = null,
    /** The desktop linked or linking, null while choosing. */
    val desktop: MicReceiverDto? = null,
    val phase: LinkPhase? = null,
    /** Why the link ended, or why it could not start. */
    val detail: String? = null,
    val dictation: DictationState = DictationState.IDLE,
    /** When the running dictation started (elapsedRealtime), for the clock. */
    val listeningSince: Long? = null,
    val level: Float = 0f,
    val result: DesktopMessage.Result? = null,
    val error: String? = null
)

/**
 * The phone's one phone-microphone link, kept for the whole process so leaving the screen (or
 * turning the screen off) does not end it. [PhoneMicService] holds the foreground while linked.
 */
object PhoneMic {
    private const val TAG = "MurmurPhoneMic"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val _state = MutableStateFlow(PhoneMicState())
    val state: StateFlow<PhoneMicState> = _state

    private var link: PhoneMicLink? = null
    private var connectJob: Job? = null

    private fun signaling(): PhoneMicSignaling? =
        CloudSync.get()?.authedClient?.let { ConvexPhoneMicSignaling(it) }

    /** Lists the desktops with Phone as microphone on (one query, not a subscription). */
    fun refresh() {
        val s = signaling()
        if (s == null) {
            _state.update { it.copy(loadError = "Connecting to your account…", loading = false) }
            return
        }
        _state.update { it.copy(loading = true, loadError = null) }
        scope.launch {
            runCatching { s.receivers() }
                .onSuccess { r ->
                    _state.update { it.copy(receivers = r.receivers, iceServers = r.iceServers, loading = false) }
                }
                .onFailure { e ->
                    _state.update { it.copy(loading = false, loadError = e.message ?: "Could not list your computers.") }
                }
        }
    }

    fun connect(context: Context, receiver: MicReceiverDto) {
        val app = context.applicationContext
        val s = signaling() ?: run {
            _state.update { it.copy(detail = "Connecting to your account… try again in a moment.") }
            return
        }
        val sync = CloudSync.get() ?: return
        disconnect(app, keepDesktop = true)
        lateinit var l: PhoneMicLink
        l = PhoneMicLink(app, s, sync.deviceId, phoneName(), object : PhoneMicLinkListener {
            override fun onPhase(phase: LinkPhase, detail: String?) = onLinkPhase(app, l, phase, detail)
            override fun onMessage(message: DesktopMessage) {
                if (link === l) onDesktopMessage(message)
            }
        })
        link = l
        _state.update {
            it.copy(
                desktop = receiver,
                phase = LinkPhase.CONNECTING,
                detail = null,
                dictation = DictationState.IDLE,
                listeningSince = null,
                level = 0f,
                result = null,
                error = null
            )
        }
        PhoneMicService.start(app, receiver.name)
        val ice = _state.value.iceServers
        connectJob = scope.launch {
            try {
                l.connect(receiver, ice)
            } catch (e: Exception) {
                Log.i(TAG, "link failed: ${e.message}")
            }
        }
    }

    fun send(command: String) {
        val ok = link?.send(PhoneMicProtocol.command(command)) == true
        if (!ok) _state.update { it.copy(error = "Not connected to the computer right now.") }
    }

    /** Ends the link and goes back to choosing a computer ([keepDesktop] keeps the choice shown). */
    fun disconnect(context: Context, keepDesktop: Boolean = false) {
        connectJob?.cancel()
        connectJob = null
        val l = link
        link = null
        l?.close()
        PhoneMicService.stop(context.applicationContext)
        if (!keepDesktop) {
            _state.update { PhoneMicState(receivers = it.receivers, iceServers = it.iceServers) }
            refresh()
        }
    }

    private fun onLinkPhase(context: Context, from: PhoneMicLink, phase: LinkPhase, detail: String?) {
        if (from !== link) return
        _state.update {
            it.copy(
                phase = phase,
                detail = detail ?: it.detail,
                dictation = if (phase == LinkPhase.CLOSED) DictationState.IDLE else it.dictation,
                listeningSince = if (phase == LinkPhase.CLOSED) null else it.listeningSince
            )
        }
        if (phase == LinkPhase.CLOSED) PhoneMicService.stop(context)
    }

    private fun onDesktopMessage(m: DesktopMessage) {
        val now = android.os.SystemClock.elapsedRealtime()
        _state.update {
            when (m) {
                is DesktopMessage.Welcome -> it.withDictation(m.state, null, now)
                is DesktopMessage.State -> it.withDictation(m.state, m.elapsedSec, now)
                is DesktopMessage.Level -> it.copy(level = m.level)
                is DesktopMessage.Result -> it.copy(result = m, error = null)
                is DesktopMessage.Error -> it.copy(error = m.message)
                DesktopMessage.Pong -> it
            }
        }
    }

    private fun PhoneMicState.withDictation(s: DictationState, elapsedSec: Int?, now: Long) = copy(
        dictation = s,
        error = null,
        level = if (s == DictationState.LISTENING) level else 0f,
        listeningSince = if (s == DictationState.LISTENING) listeningSince ?: (now - (elapsedSec ?: 0) * 1000L) else null
    )

    private fun phoneName(): String {
        val model = Build.MODEL?.trim().orEmpty()
        val maker = Build.MANUFACTURER?.trim().orEmpty()
        val name = when {
            model.isEmpty() -> "Android phone"
            maker.isNotEmpty() && !model.startsWith(maker, ignoreCase = true) && maker.lowercase() != "google" ->
                "${maker.replaceFirstChar { c -> c.uppercase() }} $model"
            else -> model
        }
        return name.take(PhoneMicProtocol.MAX_NAME_LENGTH)
    }
}
