package com.fablecities.android

import android.content.Context
import android.opengl.GLSurfaceView
import android.view.MotionEvent
import kotlin.math.atan2
import kotlin.math.hypot

/**
 * Native GL surface hosting the city renderer. The logical game surface is 1920x1080 (16:9);
 * devices with another aspect ratio receive letterboxing handled inside the renderer.
 * Touch gestures: one finger drag pans, pinch zooms, two-finger twist rotates, two-finger
 * vertical drag pitches, single tap applies the active tool.
 */
class FableCitiesView(context: Context) : GLSurfaceView(context) {

    val renderer = GlCityRenderer()
    var hud: HudOverlayView? = null
    private val savedState = CityState.load(context)

    /** The site's audio system (src/modules/audio (all files) port); the HUD drives one-shots. */
    val audio = AudioEngine().also { eng ->
        eng.state = {
            val r = renderer
            AudioEngine.AudioState(
                hour = r.hour,
                population = r.econPopulation(),
                vehicles = r.vehicleCount(),
                rain = r.weatherPrecip().toFloat(),
                wind = r.weatherWind().toFloat(),
                paused = r.paused,
                speed = r.simSpeed,
            )
        }
    }

    // gesture tracking
    private var mode = MODE_IDLE
    private var downX = 0f
    private var downY = 0f
    private var downTime = 0L
    private var lastX = 0f
    private var lastY = 0f
    private var lastSpan = 0f
    private var lastAngle = 0f

    private companion object {
        const val MODE_IDLE = 0
        const val MODE_DRAG = 1
        const val MODE_MULTI = 2
        const val TAP_SLOP = 18f
        const val TAP_MS = 320L
    }

    init {
        renderer.appContext = context.applicationContext // splat layer JPEGs come from the APK assets
        setEGLContextClientVersion(3)
        setEGLConfigChooser(8, 8, 8, 8, 24, 0)
        setRenderer(renderer)
        renderMode = RENDERMODE_CONTINUOUSLY
        preserveEGLContextOnPause = true
        // the menu's world choice (seed + mode) BEFORE the surface builds it (menu/index.js:
        // the start screen runs before the module loop so the seed reaches the generator)
        renderer.worldSeed = savedState.seed
        renderer.startMode = savedState.mode
        // graphics preferences BEFORE the surface exists, so the scene RTs are allocated at the
        // right render scale (the settings.js quality default is 'high')
        context.getSharedPreferences("fable_cities_city", Context.MODE_PRIVATE).let { p ->
            p.getString("qualityName", null)?.let { renderer.setQuality(it) }
            renderer.qualityAuto = p.getBoolean("qualityAuto", true)
            for (k in listOf("gtao", "bloom", "smaa", "post")) {
                when (p.getString("ov_$k", null)) {
                    "on" -> renderer.setPostToggle(k, true)
                    "off" -> renderer.setPostToggle(k, false)
                }
            }
        }
        audio.enabled = context.getSharedPreferences("fable_cities_city", Context.MODE_PRIVATE)
            .getBoolean("soundOn", true)
        renderer.listener = object : GlCityRenderer.Listener {
            override fun onMessage(text: String) {
                hud?.showMessage(text)
                persistSoon()
            }

            override fun onCityEdited() = persistSoon()

            override fun onHourChanged(hour: Float, day: Int) {
                savedState.hour = hour
                savedState.day = day
            }
        }
        // restore persisted world
        savedState.camera?.let { renderer.restoreCamera(it) }
        if (savedState.edits.isNotEmpty()) renderer.restoreEdits(savedState.edits)
        renderer.setHour(savedState.hour)
        renderer.day = savedState.day
        if (savedState.money > 0) renderer.setEconMoney(savedState.money)
        renderer.simSpeed = savedState.speed.coerceIn(0, 4)
        if (savedState.cityName.isNotBlank()) renderer.setCityName(savedState.cityName)
    }

    private var persistPending = false

    private fun persistSoon() {
        if (persistPending) return
        persistPending = true
        postDelayed({
            persistPending = false
            persistNow()
        }, 900)
    }

    /** menu/index.js → main.js: the start screen's New / Demo choice, run on the GL thread. */
    fun regenerate(seed: Int, mode: Int, cityName: String?) {
        queueEvent { renderer.regenerateNow(seed, mode, cityName) }
    }

    fun persistNow() {
        savedState.money = renderer.econMoney()
        savedState.population = renderer.econPopulation()
        hud?.let {
            savedState.selectedTool = it.toolToken
            savedState.speed = renderer.simSpeed
        }
        savedState.cityName = renderer.cityName()
        savedState.edits = renderer.editsState()
        savedState.camera = renderer.cameraState()
        savedState.hour = renderer.hour
        savedState.day = renderer.day
        savedState.seed = renderer.worldSeed
        savedState.mode = renderer.startMode
        savedState.save(context)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.x; downY = event.y
                lastX = event.x; lastY = event.y
                downTime = System.currentTimeMillis()
                mode = MODE_DRAG
                renderer.beginPan(event.x, event.y)
                return true
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                if (event.pointerCount >= 2) {
                    mode = MODE_MULTI
                    lastSpan = span(event)
                    lastAngle = angle(event)
                    return true
                }
            }
            MotionEvent.ACTION_MOVE -> {
                when (mode) {
                    MODE_DRAG -> {
                        lastX = event.x; lastY = event.y
                        renderer.updatePan(event.x, event.y)
                    }
                    MODE_MULTI -> {
                        if (event.pointerCount >= 2) {
                            val s = span(event)
                            if (lastSpan > 0f && s > 0f) renderer.zoomBy(s / lastSpan)
                            lastSpan = s
                            val a = angle(event)
                            renderer.rotateBy(lastAngle - a)
                            lastAngle = a
                            val midY = (event.getY(0) + event.getY(1)) / 2f
                            renderer.pitchBy((midY - lastY) * 0.004f)
                            lastY = midY
                            return true
                        }
                    }
                }
            }
            MotionEvent.ACTION_POINTER_UP -> {
                if (event.pointerCount <= 2) mode = MODE_DRAG
                lastX = event.x; lastY = event.y
                return true
            }
            MotionEvent.ACTION_UP -> {
                val moved = hypot(event.x - downX, event.y - downY)
                val elapsed = System.currentTimeMillis() - downTime
                if (mode == MODE_DRAG && moved <= TAP_SLOP && elapsed <= TAP_MS) {
                    // tool TOKEN: "SELECT" | "BULLDOZE" | "ROAD:<id>" | "ZONE:<id>" | "SERVICE:<id>"
                    val token = hud?.toolToken ?: "SELECT"
                    val parts = token.split(':', limit = 2)
                    val msg = renderer.tapTool(event.x, event.y, parts[0], parts.getOrNull(1))
                    hud?.showMessage(msg)
                    audio.action(msg) // OneShots.js: the action voice bank
                    persistSoon()
                }
                mode = MODE_IDLE
                return true
            }
            MotionEvent.ACTION_CANCEL -> mode = MODE_IDLE
        }
        return true
    }

    private fun span(e: MotionEvent): Float {
        val dx = e.getX(0) - e.getX(1)
        val dy = e.getY(0) - e.getY(1)
        return hypot(dx, dy)
    }

    private fun angle(e: MotionEvent): Float =
        atan2((e.getY(1) - e.getY(0)).toDouble(), (e.getX(1) - e.getX(0)).toDouble()).toFloat()

    fun pauseGame() {
        renderer.paused = true
        persistNow()
        audio.stop()
    }

    fun resumeGame() {
        renderer.paused = false
        if (renderer.paused) return
        audio.start()
    }

    fun isPaused(): Boolean = renderer.paused
}
