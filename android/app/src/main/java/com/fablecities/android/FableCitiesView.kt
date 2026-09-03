package com.fablecities.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.ScaleGestureDetector
import android.view.MotionEvent
import android.view.View
import kotlin.math.max
import kotlin.math.min

/**
 * Native vertical slice. The logical surface is always 1920x1080 (16:9); devices with another
 * aspect ratio receive bounded letterboxing instead of stretched gameplay or controls.
 */
class FableCitiesView(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val path = Path()
    private val logical = RectF(0f, 0f, 1920f, 1080f)
    private var viewport = RectF()
    private var scale = 1f
    private var panX = 0f
    private var panY = 0f
    private var zoom = 1f
    private var lastX = 0f
    private var lastY = 0f
    private var dragging = false
    private var selectedTool = Tool.SELECT
    private var paused = false
    private var money = 125_000
    private var population = 240
    private var message = "Welcome to Fable Cities"
    private var messageTime = 4f
    private var running = true
    private var lastFrameNanos = System.nanoTime()
    private val savedState = CityState.load(context)
    private val scaleDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean {
            zoom = (zoom * detector.scaleFactor).coerceIn(0.65f, 1.65f)
            invalidate()
            return true
        }
    })
    private val blocks = listOf(
        CityBlock(-390f, -190f, 210f, 145f, 0), CityBlock(-110f, -200f, 190f, 150f, 1),
        CityBlock(170f, -175f, 230f, 135f, 2), CityBlock(-350f, 60f, 230f, 150f, 1),
        CityBlock(-35f, 50f, 220f, 165f, 0), CityBlock(260f, 65f, 180f, 145f, 2),
        CityBlock(-180f, 285f, 230f, 135f, 2), CityBlock(145f, 280f, 250f, 145f, 1)
    )

    private val frameCallback = object : Runnable {
        override fun run() {
            val now = System.nanoTime()
            val dt = ((now - lastFrameNanos) / 1_000_000_000f).coerceIn(0f, 0.1f)
            lastFrameNanos = now
            if (running && !paused) {
                messageTime = max(0f, messageTime - dt)
                savedState.hour = (savedState.hour + dt / 18f) % 24f
                savedState.money = money
                savedState.population = population
                savedState.selectedTool = selectedTool.name
                if (messageTime > 0f || dt > 0f) invalidate()
            }
            postOnAnimation(this)
        }
    }

    init {
        isFocusable = true
        keepScreenOn = true
        money = savedState.money
        population = savedState.population
        selectedTool = Tool.entries.firstOrNull { it.name == savedState.selectedTool } ?: Tool.SELECT
        setBackgroundColor(Color.rgb(9, 14, 20))
        postOnAnimation(frameCallback)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        val viewportWidth = min(w.toFloat(), h * 16f / 9f)
        val viewportHeight = viewportWidth * 9f / 16f
        viewport.set((w - viewportWidth) / 2f, (h - viewportHeight) / 2f, (w + viewportWidth) / 2f, (h + viewportHeight) / 2f)
        scale = viewportWidth / logical.width()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawColor(Color.rgb(8, 12, 18))
        canvas.save()
        canvas.clipRect(viewport)
        canvas.translate(viewport.left, viewport.top)
        canvas.scale(scale, scale)
        drawWorld(canvas)
        drawHud(canvas)
        canvas.restore()
    }

    private fun drawWorld(canvas: Canvas) {
        paint.style = Paint.Style.FILL
        paint.shader = android.graphics.LinearGradient(0f, 0f, 0f, 1080f, Color.rgb(46, 82, 116), Color.rgb(12, 28, 35), android.graphics.Shader.TileMode.CLAMP)
        canvas.drawRect(logical, paint)
        paint.shader = null
        // Playfield and soft horizon.
        paint.color = Color.rgb(61, 92, 70)
        canvas.drawRect(0f, 275f, 1920f, 1080f, paint)
        paint.color = Color.argb(55, 255, 232, 171)
        canvas.drawCircle(1540f, 180f, 85f, paint)
        // Roads form a readable, zoomable city grid.
        paint.color = Color.rgb(48, 53, 57)
        canvas.drawRect(0f, 548f, 1920f, 628f, paint)
        canvas.drawRect(920f, 250f, 1000f, 1080f, paint)
        paint.color = Color.rgb(177, 170, 125)
        paint.strokeWidth = 4f
        paint.style = Paint.Style.STROKE
        for (x in 0..1920 step 64) canvas.drawLine(x.toFloat(), 588f, (x + 30).toFloat(), 588f, paint)
        for (y in 250..1080 step 64) canvas.drawLine(960f, y.toFloat(), 960f, (y + 30).toFloat(), paint)
        paint.style = Paint.Style.FILL
        // Stylised buildings communicate a populated demo city without PC-only detail density.
        for (block in blocks) drawBlock(canvas, block)
        drawTrees(canvas)
    }

    private fun drawBlock(canvas: Canvas, block: CityBlock) {
        val sx = 960f + block.x + panX
        val sy = 590f + block.y + panY
        val w = block.w * zoom
        val d = block.d * zoom
        val h = listOf(42f, 68f, 92f)[block.kind] * zoom
        paint.color = Color.argb(75, 14, 22, 26)
        canvas.drawRoundRect(RectF(sx - w / 2 + 12f, sy - d / 2 + 14f, sx + w / 2 + 12f, sy + d / 2 + 14f), 12f, 12f, paint)
        paint.color = listOf(Color.rgb(116, 143, 151), Color.rgb(164, 131, 96), Color.rgb(91, 119, 127))[block.kind]
        canvas.drawRect(RectF(sx - w / 2, sy - d / 2 - h, sx + w / 2, sy + d / 2 - h), paint)
        paint.color = Color.argb(150, 225, 207, 151)
        for (row in 0 until 3) for (col in 0 until 4) {
            val wx = sx - w / 2 + 25f + col * (w - 50f) / 3f
            val wy = sy - d / 2 - h + 18f + row * max(18f, h / 3f)
            canvas.drawRect(RectF(wx, wy, wx + 12f, wy + 9f), paint)
        }
        paint.color = Color.rgb(41, 61, 46)
        canvas.drawRect(RectF(sx - w / 2, sy + d / 2 - 3f, sx + w / 2, sy + d / 2 + 6f), paint)
    }

    private fun drawTrees(canvas: Canvas) {
        paint.color = Color.rgb(37, 75, 48)
        for (i in 0 until 20) {
            val x = 120f + (i * 173f) % 1640f
            val y = 350f + (i * 97f) % 520f
            if (x in 870f..1050f || y in 520f..650f) continue
            canvas.drawCircle(x, y, 16f, paint)
            paint.color = Color.rgb(76, 100, 59)
            canvas.drawCircle(x - 6f, y - 7f, 9f, paint)
            paint.color = Color.rgb(37, 75, 48)
        }
    }

    private fun drawHud(canvas: Canvas) {
        // Top bar is intentionally compact; labels remain readable at the canonical logical size.
        glass(canvas, RectF(34f, 28f, 588f, 106f))
        text(canvas, "FABLE CITIES", 62f, 62f, 22f, Color.WHITE, true)
        text(canvas, "RIVERLIGHT  •  DAY 1", 62f, 88f, 14f, Color.rgb(164, 190, 205), false)
        glass(canvas, RectF(1330f, 28f, 1886f, 106f))
        text(canvas, "$${money / 1000}k", 1360f, 64f, 21f, Color.rgb(255, 218, 126), true)
        text(canvas, "POP $population", 1535f, 64f, 18f, Color.rgb(143, 222, 255), true)
        text(canvas, pausedLabel(), 1720f, 88f, 13f, Color.rgb(210, 220, 226), false)

        // Bottom dock: all essential actions are labelled and at least 88 logical px tall.
        glass(canvas, RectF(420f, 900f, 1500f, 1046f))
        val tools = listOf("SELECT", "ROAD", "ZONE", "SERVICE", "BULLDOZE")
        tools.forEachIndexed { i, label ->
            val left = 445f + i * 208f
            val active = selectedTool.ordinal == i
            paint.color = if (active) Color.rgb(48, 142, 177) else Color.argb(30, 255, 255, 255)
            canvas.drawRoundRect(RectF(left, 918f, left + 188f, 1028f), 16f, 16f, paint)
            text(canvas, label, left + 94f, 966f, 18f, Color.WHITE, true, Paint.Align.CENTER)
            text(canvas, toolHint(i), left + 94f, 998f, 12f, Color.rgb(188, 211, 220), false, Paint.Align.CENTER)
        }
        if (messageTime > 0f) {
            glass(canvas, RectF(46f, 902f, 360f, 1010f))
            text(canvas, message, 68f, 948f, 16f, Color.WHITE, true)
            text(canvas, "Tap a tool to begin", 68f, 977f, 13f, Color.rgb(184, 202, 211), false)
        }
        glass(canvas, RectF(1550f, 900f, 1874f, 1046f))
        text(canvas, pausedLabel(), 1712f, 942f, 18f, Color.WHITE, true, Paint.Align.CENTER)
        text(canvas, "TAP TO PAUSE", 1712f, 982f, 13f, Color.rgb(184, 202, 211), false, Paint.Align.CENTER)
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

    private fun toolHint(i: Int) = when (i) { 0 -> "inspect & select"; 1 -> "drag to draw"; 2 -> "paint a district"; 3 -> "place services"; else -> "remove safely" }
    private fun pausedLabel() = if (paused) "PAUSED" else "▶ 1×"

    override fun onTouchEvent(event: MotionEvent): Boolean {
        scaleDetector.onTouchEvent(event)
        val x = (event.x - viewport.left) / scale
        val y = (event.y - viewport.top) / scale
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                lastX = x; lastY = y; dragging = false
                if (y >= 900f && y <= 1060f) {
                    if (x >= 1550f) { paused = !paused; message = if (paused) "Simulation paused" else "Simulation resumed"; messageTime = 3f; invalidate(); return true }
                    if (x in 420f..1500f) {
                        val index = ((x - 445f) / 208f).toInt().coerceIn(0, 4)
                        selectedTool = Tool.entries[index]
                        message = when (selectedTool) { Tool.ROAD -> "Road tool ready — drag across the map"; Tool.ZONE -> "Zone tool ready — paint a district"; Tool.SERVICE -> "Service tool ready — tap a block"; Tool.BULLDOZE -> "Bulldoze ready — tap a building"; else -> "Select a building to inspect" }
                        messageTime = 4f; invalidate(); return true
                    }
                }
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = x - lastX; val dy = y - lastY
                if (y < 880f && (dx * dx + dy * dy > 25f)) { panX += dx; panY += dy; dragging = true; invalidate() }
                lastX = x; lastY = y
            }
            MotionEvent.ACTION_UP -> {
                if (!dragging && y in 170f..870f && selectedTool != Tool.SELECT) {
                    if (selectedTool == Tool.BULLDOZE) { money += 500; message = "Building removed • +$500 refund" }
                    else { money -= 250; population += if (selectedTool == Tool.ZONE) 20 else 0; message = "${selectedTool.label} placed" }
                    messageTime = 3f; invalidate()
                }
            }
        }
        return true
    }

    fun pauseGame() {
        running = false
        paused = true
        savedState.money = money
        savedState.population = population
        savedState.selectedTool = selectedTool.name
        savedState.save(context)
        invalidate()
    }

    fun resumeGame() {
        running = true
        paused = false
        lastFrameNanos = System.nanoTime()
        invalidate()
    }

    private data class CityBlock(val x: Float, val y: Float, val w: Float, val d: Float, val kind: Int)
    private enum class Tool(val label: String) { SELECT("Select"), ROAD("Road"), ZONE("Zone"), SERVICE("Service"), BULLDOZE("Bulldoze") }
}
