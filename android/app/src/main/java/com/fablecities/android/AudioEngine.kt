package com.fablecities.android

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.min
import kotlin.math.sin
import kotlin.random.Random

/**
 * The site's audio system, native port of src/modules/audio (all files) (AudioCore/Mixer/layers/
 * OneShots/UISounds/ZoneEmitters) as one AudioTrack synthesiser.
 *
 * Bus structure mirrors Mixer.js groups: wind, city, traffic, rain, birds, crickets, ui,
 * events — mixed into a master. Layer behaviour follows the web layers:
 *  - wind: low-passed noise with a slow gust random-walk (layers.js wind layer)
 *  - rain: bright band-passed noise scaled by the weather's rain intensity
 *  - birds: daytime FM chirp bursts at randomised intervals (layers.js birds)
 *  - crickets: night-time pulsed 4.2 kHz song (layers.js crickets)
 *  - city: sub-audio rumble scaled by population (the city hum)
 *  - traffic: broadband rumble scaled by the traffic sim's vehicle load
 *  - ui/events: the one-shot voice bank (UISounds + OneShots): tool arm tick, road thump,
 *    zone tick, service chime, bulldoze crumble, milestone chime
 *
 * A hand-rolled synthesis loop (not node-per-node Web Audio) reproduces the audible result;
 * parameters are updated lock-free from the frame thread and read by the synth thread.
 */
class AudioEngine {

    companion object {
        const val SR = 48000
        const val BLOCK = 480 // 10 ms
    }

    @Volatile var enabled = true          // the settings sheet "Sound" switch
    @Volatile var master = 0.85f          // Mixer.js master (the Overlay's 85 % default)
    @Volatile private var running = false
    @Volatile private var track: AudioTrack? = null
    private var thread: Thread? = null

    // --- renderer link (state feeds the bus gains; the UI forwards actions) ---
    var state: (() -> AudioState)? = null

    class AudioState(
        val hour: Float,           // 0..24
        val population: Int,
        val vehicles: Int,
        val rain: Float,           // 0..1 (weather precipitation)
        val wind: Float,           // 0..1 (weather wind)
        val paused: Boolean,
        val speed: Int,
    )

    // ---- per-bus filter state (one-pole low-pass / band-pass) ----
    private var windLp = 0f
    private var windR = 0f
    private var gust = 0.6f
    private var gustTarget = 0.6f
    private var rainLp = 0f
    private var rainHp = 0f
    private var cityLp = 0f
    private var trafficLp = 0f
    private var chirpNext = 1.0
    private var chirpT = -1.0
    private var chirpF0 = 2600.0
    private var chirpF1 = 3900.0
    private var chirpDur = 0.22
    private var cricketT = 0.0
    private var cricketBurst = 0.0
    private var cricketNext = 0.8
    private val rng = Random(1337)

    // ---- one-shot voices (UISounds/OneShots): scheduled into the next blocks ----
    private class Voice(val kind: Int, var t: Double, val dur: Double, val gain: Float)
    private val voices = ArrayList<Voice>(8)

    fun start() {
        if (running) return
        running = true
        thread = Thread {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO)
            synthLoop()
        }.also { it.start() }
    }

    fun stop() {
        running = false
        thread?.interrupt()
        thread = null
        track?.let { it.stop(); it.release() }
        track = null
    }

    // ---------------------------------------------------------------- UI/one-shot voice bank

    private fun voice(kind: Int, t: Double, dur: Double, gain: Float) {
        synchronized(voices) { voices.add(Voice(kind, t, dur, gain)) }
    }

    /** ui/index.js tool:select → the UISounds arm tick. */
    fun toolArmed() = voice(0, 0.0, 0.05, 0.5f)
    fun toolCancelled() = voice(0, 0.0, 0.05, 0.25f)

    /** OneShots.js action bank, keyed by the tool result message (the HUD forwards it). */
    fun action(msg: String) {
        val m = msg.lowercase()
        when {
            "placed" in m || "road" in m && "removed" !in m -> voice(1, 0.0, 0.16, 0.8f)      // thump
            "zone painted" in m -> voice(2, 0.0, 0.06, 0.4f)                                   // soft tick
            "zone cleared" in m -> voice(2, 0.0, 0.08, 0.25f)
            "power plant" in m || "water tower" in m || "sewage" in m || "landfill" in m ||
                "police" in m || "fire" in m || "clinic" in m || "school" in m -> voice(3, 0.0, 0.5, 0.7f) // chime
            "demolished" in m -> voice(4, 0.0, 0.3, 0.7f)                                      // crumble
            "milestone" in m -> voice(5, 0.0, 0.7, 0.6f)                                       // two-note chime
            "removed" in m || "refund" in m -> voice(4, 0.0, 0.18, 0.4f)
        }
    }

    // ---------------------------------------------------------------- synthesis

    private fun buildTrack(): AudioTrack {
        val attr = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
            .build()
        val fmt = AudioFormat.Builder()
            .setSampleRate(SR)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
            .build()
        val minBuf = AudioTrack.getMinBufferSize(SR, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT)
        val t = AudioTrack.Builder()
            .setAudioAttributes(attr)
            .setAudioFormat(fmt)
            .setBufferSizeInBytes(maxOf(minBuf, BLOCK * 8))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        t.play()
        return t
    }

    @SuppressLint("MissingPermission")
    private fun synthLoop() {
        val buf = ShortArray(BLOCK * 2)
        var phase = 0.0
        val t = track ?: buildTrack().also { track = it }
        while (running) {
            val st = state?.invoke() ?: AudioState(14f, 0, 0, 0f, 0.3f, false, 1)
            val night = ((st.hour < 5.5f || st.hour > 20.5f)).let { if (it) 1f else 0f }
            val day = 1f - night
            // Mixer.js bus gains from world state
            val windGain = if (st.paused) 0f else 0.10f + 0.30f * st.wind
            val rainGain = if (st.paused) 0f else 0.0f.coerceAtLeast(0.34f * st.rain)
            val popScale = min(1.0, st.population / 4000.0).toFloat()
            val cityGain = if (st.paused) 0f else 0.05f + 0.16f * popScale
            val vehScale = min(1.0, st.vehicles / 140.0).toFloat()
            val trafficGain = if (st.paused) 0f else 0.04f + 0.20f * vehScale
            val birdsGain = if (st.paused) 0f else day * (1f - st.rain) * 0.5f
            val cricketsGain = if (st.paused) 0f else night * (1f - st.rain) * 0.35f
            val m = if (enabled) master else 0f

            var i = 0
            while (i < BLOCK) {
                val tSec = phase / SR
                // wind: low-passed white noise with the gust random-walk (layers.js wind)
                if (tSec % 2.0 < 0.0000001) {}
                val wn = rng.nextFloat() * 2f - 1f
                windLp += 0.045f * (wn - windLp)
                if (rng.nextDouble() < 1.0 / (SR * 1.5)) gustTarget = 0.25f + rng.nextFloat() * 0.75f
                gust += (gustTarget - gust) * 1e-4f
                val wind = windLp * (0.6f + 0.4f * gust) * windGain

                // rain: bright band-passed noise (dsp.js biquad equivalent, one-pole pair)
                val rn = rng.nextFloat() * 2f - 1f
                rainLp += 0.35f * (rn - rainLp)
                rainHp += 0.06f * (rainLp - rainHp)
                val rain = (rainLp - rainHp) * rainGain

                // city hum: deep low-pass (brown-ish) rumble
                val cn = rng.nextFloat() * 2f - 1f
                cityLp += 0.012f * (cn - cityLp)
                val city = cityLp * 2.2f * cityGain

                // traffic: mid rumble
                val tn = rng.nextFloat() * 2f - 1f
                trafficLp += 0.03f * (tn - trafficLp)
                val traffic = trafficLp * 1.8f * trafficGain

                // birds: FM chirp bursts at randomised intervals (layers.js birds)
                var bird = 0f
                if (birdsGain > 0.01f) {
                    if (chirpT < 0) {
                        chirpNext -= 1.0 / SR
                        if (chirpNext <= 0) {
                            chirpT = 0.0
                            chirpDur = 0.12 + rng.nextDouble() * 0.22
                            chirpF0 = 2200 + rng.nextDouble() * 1400
                            chirpF1 = chirpF0 + 800 + rng.nextDouble() * 900
                            chirpNext = 0.6 + rng.nextDouble() * 5.0
                        }
                    } else {
                        val p = chirpT / chirpDur
                        val env = (sin(PI * p).toFloat())
                        val f = chirpF0 + (chirpF1 - chirpF0) * sin(PI * p)
                        bird = (env * sin(2 * PI * f * tSec)).toFloat() * 0.30f * birdsGain
                        chirpT += 1.0 / SR
                        if (chirpT >= chirpDur) chirpT = -1.0
                    }
                }

                // crickets: pulsed 4.2 kHz (layers.js crickets)
                var cricket = 0f
                if (cricketsGain > 0.01f) {
                    cricketNext -= 1.0 / SR
                    if (cricketNext <= 0 && cricketBurst <= 0) {
                        cricketBurst = 0.35 + rng.nextDouble() * 0.4
                        cricketNext = 0.9 + rng.nextDouble() * 1.6
                    }
                    if (cricketBurst > 0) {
                        cricketBurst -= 1.0 / SR
                        val pulse = if ((tSec * 18.0) % 1.0 < 0.5) 1f else 0f
                        cricket = (0.5f * pulse * sin(2 * PI * 4200.0 * tSec)).toFloat() * cricketsGain
                    }
                }

                // one-shot voices
                var os = 0f
                run {
                    val it = voices.iterator()
                    while (it.hasNext()) {
                        val v = it.next()
                        val p = v.t / v.dur
                        if (p >= 1.0) { it.remove(); continue }
                        val env = exp(-5.0 * p).toFloat()
                        os += when (v.kind) {
                            0 -> env * (rng.nextFloat() * 2f - 1f) * 0.25f * v.gain                       // tick
                            1 -> env * sin(2 * PI * (95.0 - 40.0 * p) * v.t).toFloat() * v.gain           // thump
                            2 -> env * sin(2 * PI * 1500.0 * v.t).toFloat() * 0.4f * v.gain               // soft tick
                            3 -> env * (sin(2 * PI * 880.0 * v.t).toFloat() * 0.6f +
                                    sin(2 * PI * 1320.0 * v.t).toFloat() * 0.4f) * v.gain                 // chime
                            4 -> env * (rng.nextFloat() * 2f - 1f) * 0.5f * v.gain                        // crumble
                            5 -> (if (v.t < 0.25) env * sin(2 * PI * 784.0 * v.t).toFloat() * v.gain
                            else (exp(-5.0 * ((v.t - 0.25) / 0.45)).toFloat() *
                                    sin(2 * PI * 1175.0 * (v.t - 0.25)).toFloat() * v.gain))              // milestone
                            else -> 0f
                        }
                        v.t += 1.0 / SR
                    }
                }

                // master mix (Mixer.js master bus), soft clip
                var l = (wind * 0.9f + rain + city + traffic * 0.9f + bird + cricket * 0.8f + os)
                l *= m
                l = l.coerceIn(-0.98f, 0.98f)
                // slight stereo width: wind/rain lean right, city lean left (the web's panners)
                val r = (wind * 0.75f + rain * 1.1f + city * 1.1f + traffic + bird * 0.9f + cricket + os * 0.95f) * m
                    .coerceIn(-0.98f, 0.98f)
                buf[i * 2] = (l * 32767).toInt().toShort()
                buf[i * 2 + 1] = (r * 32767).toInt().toShort()
                phase++
                i++
            }
            if (android.os.Build.VERSION.SDK_INT >= 23) t.write(buf, 0, buf.size, AudioTrack.WRITE_BLOCKING)
            else @Suppress("DEPRECATION") t.write(buf, 0, buf.size)
        }
    }
}
