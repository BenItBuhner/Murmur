package app.murmur.android.phonemic

import android.content.Context
import android.media.MediaRecorder
import android.util.Log
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule

private const val TAG = "MurmurPhoneMic"

/** Where a link stands, as the screen shows it. */
enum class LinkPhase { CONNECTING, LINKED, INTERRUPTED, CLOSED }

interface PhoneMicLinkListener {
    fun onPhase(phase: LinkPhase, detail: String?)
    fun onMessage(message: DesktopMessage)
}

class PhoneMicException(message: String) : Exception(message)

/**
 * The Android end of a phone-microphone link (docs/phone-microphone.md): the microphone goes to a
 * desktop of the same account over WebRTC, peer to peer, and start / stop go over a data channel.
 * Convex carries one offer and one answer ([PhoneMicSignaling]); none of the audio.
 *
 * The capture runs in WebRTC's own audio module (VOICE_RECOGNITION source, no echo canceller:
 * nothing plays on the phone), so it keeps running with the screen off while [PhoneMicService]
 * holds the foreground.
 */
class PhoneMicLink(
    private val context: Context,
    private val signaling: PhoneMicSignaling,
    private val deviceId: String,
    private val name: String,
    private val listener: PhoneMicLinkListener
) {
    val linkId: String = UUID.randomUUID().toString().replace("-", "")

    @Volatile var phase: LinkPhase = LinkPhase.CONNECTING
        private set

    @Volatile private var factory: PeerConnectionFactory? = null
    @Volatile private var audioModule: JavaAudioDeviceModule? = null
    @Volatile private var pc: PeerConnection? = null
    @Volatile private var channel: DataChannel? = null
    @Volatile private var track: AudioTrack? = null
    private val gathered = CompletableDeferred<Unit>()

    private fun setPhase(next: LinkPhase, detail: String? = null) {
        if (phase == LinkPhase.CLOSED) return
        phase = next
        listener.onPhase(next, detail)
    }

    /** Offers the link to [receiver] and waits for its answer; the phase follows the connection after that. */
    suspend fun connect(receiver: MicReceiverDto, iceServers: List<MicIceServerDto>) {
        try {
            ensureWebRtc(context)
            val audio = JavaAudioDeviceModule.builder(context)
                .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
                .setUseHardwareAcousticEchoCanceler(false)
                .setUseHardwareNoiseSuppressor(true)
                .setUseStereoInput(false)
                .setAudioRecordErrorCallback(recordErrors)
                .createAudioDeviceModule()
            audioModule = audio
            val f = PeerConnectionFactory.builder().setAudioDeviceModule(audio).createPeerConnectionFactory()
            factory = f
            val config = PeerConnection.RTCConfiguration(
                iceServers.map { s ->
                    PeerConnection.IceServer.builder(s.urlList).apply {
                        s.username?.let { setUsername(it) }
                        s.credential?.let { setPassword(it) }
                    }.createIceServer()
                }
            ).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
            }
            val connection = f.createPeerConnection(config, observer)
                ?: throw PhoneMicException("Could not prepare the connection.")
            pc = connection
            val source = f.createAudioSource(
                MediaConstraints().apply {
                    mandatory += MediaConstraints.KeyValuePair("googEchoCancellation", "false")
                    mandatory += MediaConstraints.KeyValuePair("googNoiseSuppression", "true")
                    mandatory += MediaConstraints.KeyValuePair("googAutoGainControl", "true")
                    mandatory += MediaConstraints.KeyValuePair("googHighpassFilter", "true")
                }
            )
            val mic = f.createAudioTrack("murmur-mic", source)
            track = mic
            connection.addTransceiver(
                mic,
                RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, listOf("murmur"))
            )
            val dc = connection.createDataChannel(PhoneMicProtocol.CONTROL_LABEL, DataChannel.Init().apply { ordered = true })
            channel = dc
            dc.registerObserver(channelObserver(dc))
            // Disconnected (on another thread) while this was being built: release what was made.
            if (phase == LinkPhase.CLOSED) return teardown()

            val offer = connection.awaitCreateOffer()
            connection.awaitSetLocal(SessionDescription(SessionDescription.Type.OFFER, PhoneMicProtocol.tuneOpusSdp(offer.description)))
            withTimeoutOrNull(PhoneMicProtocol.ICE_GATHER_MS) { gathered.await() }
            if (phase == LinkPhase.CLOSED) return teardown()
            val sdp = connection.localDescription?.description
                ?: throw PhoneMicException("Could not prepare the connection.")

            signaling.offer(receiver.deviceId, deviceId, name, linkId, sdp)
            val reply = signaling.awaitAnswer(deviceId, linkId, PhoneMicProtocol.ANSWER_TIMEOUT_MS)
                ?: throw PhoneMicException("${receiver.name} did not answer. Check that Murmur is running there and signed in to this account.")
            runCatching { signaling.take(reply.id) }
            if (phase == LinkPhase.CLOSED) return
            if (reply.kind != "answer" || reply.sdp.isEmpty())
                throw PhoneMicException(reply.reason ?: "${receiver.name} declined the link.")
            connection.awaitSetRemote(SessionDescription(SessionDescription.Type.ANSWER, reply.sdp))
        } catch (e: Throwable) {
            if (phase == LinkPhase.CLOSED) return teardown()
            val message = friendlyError(e, receiver.name)
            close(message)
            throw PhoneMicException(message)
        }
    }

    fun send(json: String): Boolean {
        val dc = channel ?: return false
        if (dc.state() != DataChannel.State.OPEN) return false
        return dc.send(DataChannel.Buffer(ByteBuffer.wrap(json.toByteArray(StandardCharsets.UTF_8)), false))
    }

    fun close(detail: String? = null) {
        if (phase == LinkPhase.CLOSED) return
        setPhase(LinkPhase.CLOSED, detail)
        teardown()
    }

    /** Releases whatever the link holds; also run by [connect] for pieces made after a close. */
    @Synchronized
    private fun teardown() {
        val dc = channel
        val connection = pc
        val f = factory
        val audio = audioModule
        channel = null
        pc = null
        track = null
        factory = null
        audioModule = null
        // close() is often called from a WebRTC callback, and disposing a connection on its own
        // signaling thread deadlocks: tear down on a thread of our own, channel first, then the
        // connection, the factory and the microphone.
        Thread({
            runCatching { dc?.unregisterObserver(); dc?.close(); dc?.dispose() }
            runCatching { connection?.dispose() }
            runCatching { f?.dispose() }
            runCatching { audio?.release() }
        }, "phone-mic-teardown").start()
    }

    private val recordErrors = object : JavaAudioDeviceModule.AudioRecordErrorCallback {
        override fun onWebRtcAudioRecordInitError(errorMessage: String?) = micFailed(errorMessage)
        override fun onWebRtcAudioRecordStartError(
            errorCode: JavaAudioDeviceModule.AudioRecordStartErrorCode?,
            errorMessage: String?
        ) = micFailed(errorMessage)
        override fun onWebRtcAudioRecordError(errorMessage: String?) = micFailed(errorMessage)
    }

    private fun micFailed(message: String?) {
        Log.w(TAG, "microphone error: $message")
        close("The microphone stopped working on this phone${message?.let { ": $it" } ?: ""}.")
    }

    private fun channelObserver(dc: DataChannel) = object : DataChannel.Observer {
        override fun onBufferedAmountChange(previousAmount: Long) {}
        override fun onStateChange() {
            when (dc.state()) {
                DataChannel.State.OPEN -> send(PhoneMicProtocol.hello(name))
                DataChannel.State.CLOSED -> if (phase != LinkPhase.CLOSED) close("The computer closed the link.")
                else -> {}
            }
        }
        override fun onMessage(buffer: DataChannel.Buffer) {
            if (buffer.binary) return
            val bytes = ByteArray(buffer.data.remaining())
            buffer.data.get(bytes)
            PhoneMicProtocol.parseDesktop(String(bytes, StandardCharsets.UTF_8))?.let(listener::onMessage)
        }
    }

    private val observer = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
        override fun onConnectionChange(state: PeerConnection.PeerConnectionState?) {
            when (state) {
                PeerConnection.PeerConnectionState.CONNECTED -> setPhase(LinkPhase.LINKED)
                PeerConnection.PeerConnectionState.DISCONNECTED -> setPhase(LinkPhase.INTERRUPTED)
                PeerConnection.PeerConnectionState.FAILED -> close("The connection to the computer was lost.")
                else -> {}
            }
        }
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {
            if (state == PeerConnection.IceGatheringState.COMPLETE) gathered.complete(Unit)
        }
        override fun onIceCandidate(candidate: IceCandidate?) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
        override fun onAddStream(stream: MediaStream?) {}
        override fun onRemoveStream(stream: MediaStream?) {}
        override fun onDataChannel(dc: DataChannel?) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {}
    }

    companion object {
        @Volatile private var initialized = false

        /** Loads WebRTC once per process. Throws when this device's ABI has no WebRTC library. */
        fun ensureWebRtc(context: Context) {
            if (initialized) return
            synchronized(this) {
                if (initialized) return
                try {
                    PeerConnectionFactory.initialize(
                        PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                            .createInitializationOptions()
                    )
                } catch (e: UnsatisfiedLinkError) {
                    throw PhoneMicException("Phone microphone is not available on this device.")
                }
                initialized = true
            }
        }

        fun friendlyError(e: Throwable, desktopName: String): String {
            val message = e.message ?: e.toString()
            return when {
                e is PhoneMicException -> message
                message.contains("not_listening") ->
                    "$desktopName is not listening for a phone any more. Turn on Phone as microphone in Murmur's Microphone settings there."
                else -> "Could not link to $desktopName: $message"
            }
        }
    }
}

private suspend fun PeerConnection.awaitCreateOffer(): SessionDescription = suspendCancellableCoroutine { cont ->
    createOffer(object : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription) = cont.resume(sdp)
        override fun onCreateFailure(error: String?) = cont.resumeWithException(PhoneMicException(error ?: "Could not prepare the connection."))
        override fun onSetSuccess() {}
        override fun onSetFailure(error: String?) {}
    }, MediaConstraints())
}

private suspend fun PeerConnection.awaitSetLocal(sdp: SessionDescription) = suspendCancellableCoroutine { cont ->
    setLocalDescription(setObserver { error -> if (error == null) cont.resume(Unit) else cont.resumeWithException(PhoneMicException(error)) }, sdp)
}

private suspend fun PeerConnection.awaitSetRemote(sdp: SessionDescription) = suspendCancellableCoroutine { cont ->
    setRemoteDescription(setObserver { error -> if (error == null) cont.resume(Unit) else cont.resumeWithException(PhoneMicException(error)) }, sdp)
}

private fun setObserver(done: (String?) -> Unit) = object : SdpObserver {
    override fun onCreateSuccess(sdp: SessionDescription?) {}
    override fun onCreateFailure(error: String?) {}
    override fun onSetSuccess() = done(null)
    override fun onSetFailure(error: String?) = done(error ?: "Could not set up the connection.")
}
