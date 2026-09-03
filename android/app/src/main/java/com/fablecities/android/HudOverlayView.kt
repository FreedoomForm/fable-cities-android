package com.fablecities.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.MotionEvent
import android.view.View

/**
 * Touch-first HUD drawn with Canvas on top of the GL surface. All essential actions are large
 * labelled buttons inside the letterboxed 1920x1080 logical surface; nothing depends on hover,
 * right-click, or a keyboard. Playfield touches fall through to the GL view.
 */
class HudOverlayView(context: Context) : View(context) {

    enum class Tool(val label: String) { SELECT("Select"), ROAD("Road"), ZONE("Zone"), SERVICE("Service"), BULLDOZE("Bulldoze") }

    var gameView: FableCitiesView? = null
    var money = 125_000
        private set
    var population = 240
        private set
    var selectedTool = Tool.SELECT
        private set
    private var message = "Welcome to Fable Cities"
    private var messageTime = 5f
    private val savedState = CityState.load(context)

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val logical = RectF(0f, 0f, 1920f, 1080f)
    private val viewport = RectF()
    private var scale = 1f
    private var lastFrameNanos = 0L
    private var running = true

    private val frameCallback = object : Runnable {
        override fun run() {
            val now = System.nanoTime()
            val dt = if (lastFrameNanos == 0L) 0.016f else ((now - lastFrameNanos) / 1_000_000_000f).coerceIn(0f, 0.1f)
            lastFrameNanos = now
            if (running) {
                if (messageTime > 0f) {
                    messageTime = (messageTime - dt).coerceAtLeast(0f)
                    invalidate()
                }
                postOnAnimation(this)
            }
        }
    }

    init {
        money = savedState.money
        population = savedState.population
        selectedTool = Tool.entries.firstOrNull { it.name == savedState.selectedTool } ?: Tool.SELECT
        postOnAnimation(frameCallback)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        val vw = minOf(w.toFloat(), h * 16f / 9f)
        val vh = vw * 9f / 16f
        viewport.set((w - vw) / 2f, (h - vh) / 2f, (w + vw) / 2f, (h + vh) / 2f)
        scale = vw / logical.width()
    }

    fun showMessage(text: String) {
        message = text
        messageTime = 3.5f
        post { invalidate() }
    }

    fun applyToolCost(tool: String, outcome: String) {
        when (tool) {
            "ROAD" -> if (outcome == "Road placed") money -= 900
            "ZONE" -> if (outcome.endsWith("painted")) { money -= 350; population += 24 }
            "SERVICE" -> if (outcome == "Service built") money -= 2_400
            "BULLDOZE" -> if (outcome == "Demolished") money += 400
        }
        if (money < 0) money = 0
        post { invalidate() }
    }

    private fun toLogical(x: Float, y: Float): FloatArray =
        floatArrayOf((x - viewport.left) / scale, (y - viewport.top) / scale)

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked != MotionEvent.ACTION_DOWN) return false
        val p = toLogical(event.x, event.y)
        val x = p[0]
        val y = p[1]
        // pause panel (bottom right)
        if (x in 1550f..1874f && y in 900f..1046f) {
            val gv = gameView ?: return false
            val nowPaused = !gv.isPaused()
            if (nowPaused) gv.pauseGame() else gv.resumeGame()
            showMessage(if (nowPaused) "Simulation paused" else "Simulation resumed")
            invalidate()
            return true
        }
        // tool dock (bottom centre)
        if (x in 420f..1500f && y in 900f..1046f) {
            val index = ((x - 445f) / 208f).toInt().coerceIn(0, 4)
            selectedTool = Tool.entries[index]
            showMessage(
                when (selectedTool) {
                    Tool.ROAD -> "Road tool ready — tap the map"
                    Tool.ZONE -> "Zone tool ready — tap to paint; tap again to change"
                    Tool.SERVICE -> "Service tool ready — tap an empty lot"
                    Tool.BULLDOZE -> "Bulldoze ready — tap a building"
                    else -> "Tap a building to inspect it"
                }
            )
            invalidate()
            return true
        }
        return false // playfield: fall through to the GL view
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.save()
        canvas.clipRect(viewport)
        canvas.translate(viewport.left, viewport.top)
        canvas.scale(scale, scale)
        drawHud(canvas)
        canvas.restore()
    }

    private fun paused(): Boolean = gameView?.isPaused() ?: false

    private fun drawHud(canvas: Canvas) {
        val gv = gameView
        val day = gv?.renderer?.day ?: 1
        val hour = gv?.renderer?.hour ?: 8f
        paint.style = Paint.Style.FILL

        glass(canvas, RectF(34f, 28f, 620f, 106f))
        text(canvas, "FABLE CITIES", 62f, 62f, 22f, Color.WHITE, true)
        text(canvas, "RIVERLIGHT  •  DAY $day  •  ${clock(hour)}", 62f, 88f, 14f, Color.rgb(164, 190, 205), false)

        glass(canvas, RectF(1290f, 28f, 1886f, 106f))
        text(canvas, "$${money / 1000}k", 1320f, 64f, 21f, Color.rgb(255, 218, 126), true)
        text(canvas, "POP $population", 1500f, 64f, 18f, Color.rgb(143, 222, 255), true)
        text(canvas, if (paused()) "PAUSED" else "SIMULATION LIVE", 1320f, 90f, 13f, Color.rgb(210, 220, 226), false)

        glass(canvas, RectF(420f, 900f, 1500f, 1046f))
        Tool.entries.forEachIndexed { i, tool ->
            val left = 445f + i * 208f
            val active = selectedTool.ordinal == i
            paint.color = if (active) Color.rgb(48, 142, 177) else Color.argb(30, 255, 255, 255)
            canvas.drawRoundRect(RectF(left, 918f, left + 188f, 1028f), 16f, 16f, paint)
            text(canvas, tool.label.uppercase(), left + 94f, 966f, 19f, Color.WHITE, true, Paint.Align.CENTER)
            text(canvas, toolHint(i), left + 94f, 998f, 12f, Color.rgb(188, 211, 220), false, Paint.Align.CENTER)
        }
        if (messageTime > 0f) {
            glass(canvas, RectF(46f, 902f, 380f, 1010f))
            text(canvas, message, 68f, 946f, 16f, Color.WHITE, true)
            text(canvas, "Drag map • pinch zoom • twist rotate", 68f, 976f, 12f, Color.rgb(184, 202, 211), false)
        }
        glass(canvas, RectF(1550f, 900f, 1874f, 1046f))
        text(canvas, if (paused()) "RESUME" else "PAUSE", 1712f, 946f, 20f, Color.WHITE, true, Paint.Align.CENTER)
        text(canvas, "TAP TO ${if (paused()) "RESUME" else "PAUSE"}", 1712f, 984f, 13f, Color.rgb(184, 202, 211), false, Paint.Align.CENTER)
    }

    private fun clock(hour: Float): String {
        val h = hour.toInt()
        val m = ((hour - h) * 60f).toInt()
        return String.format("%02d:%02d", h, m)
    }

    private fun toolHint(i: Int) = when (i) {
        0 -> "inspect & select"
        1 -> "tap to place"
        2 -> "paint a district"
        3 -> "place services"
        else -> "remove safely"
    }

    private fun glass(canvas: Canvas, rect: RectF) {
        paint.color = Color.argb(218, 13, 21, 29)
        canvas.drawRoundRect(rect, 18f, 18f, paint)
        paint.color = Color.argb(75, 151, 210, 233)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 2f
        canvas.drawRoundRect(rect, 18f, 18f, paint)
        paint.style = Paint.Style.FILL
    }

    private fun text(canvas: Canvas, value: String, x: Float, y: Float, size: Float, color: Int, bold: Boolean, align: Paint.Align = Paint.Align.LEFT) {
        paint.color = color
        paint.textSize = size
        paint.typeface = if (bold) android.graphics.Typeface.DEFAULT_BOLD else android.graphics.Typeface.DEFAULT
        paint.textAlign = align
        canvas.drawText(value, x, y, paint)
    }

    fun pauseHud() {
        running = false
    }

    fun resumeHud() {
        if (!running) {
            running = true
            lastFrameNanos = 0L
            postOnAnimation(frameCallback)
        }
        invalidate()
    }
}
