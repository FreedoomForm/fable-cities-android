package com.fablecities.android

/**
 * The site's quality system, mirrored for the native renderer:
 *  - PRESETS  ← src/core/Config.js QUALITY (low/medium/high/ultra), each knob mapped onto the
 *               native renderer's equivalents (render scale instead of pixelRatio, the merged
 *               GroundFX AO term instead of the separate GTAO pass, particle multiplier).
 *  - PerfGuard ← src/modules/perfguard/guard.js createGuard(), a faithful 1:1 port of the
 *               runtime frame-time guard: MEDIAN of a rolling window (a hitch cannot move a
 *               median), spike frames dropped, a DEBT accumulator with two thresholds for
 *               hysteresis, a cooldown after every step, a warm-up after boot, and a hard
 *               limit of 2 automatic downgrades per session.
 *
 * Pure state machine — no GL, no android imports — so it stays unit-testable like the web one.
 */
class QualityPreset(
    val name: String,
    val renderScale: Float,      // scene/post RT scale (the web's pixelRatio vs devicePixelRatio 1)
    val gtao: Boolean,           // the GTAO toggle (settings.js): the GroundFX AO term
    val bloom: Boolean,          // UnrealBloomPass
    val smaa: Boolean,           // SMAAPass
    val reflections: Boolean,    // Water.js renderReflection planar RT
    val drawDistance: Float,     // metres (uFade 0.16/0.26 of it)
    val particles: Float,        // precipitation/spray/smoke multiplier
) {
    val index: Int = PRESET_ORDER.indexOf(name)
    fun nextLower(): QualityPreset? = if (index > 0) PRESETS[index - 1] else null
    companion object {
        val PRESET_ORDER = listOf("low", "medium", "high", "ultra")
        val PRESETS = listOf(
            // Config.js QUALITY.low — no GTAO, no reflections, particles 0.3
            QualityPreset("low", 0.72f, gtao = false, bloom = true, smaa = true,
                reflections = false, drawDistance = 1000f, particles = 0.3f),
            // medium — gtao on, reflections still off, particles 0.6
            QualityPreset("medium", 0.85f, gtao = true, bloom = true, smaa = true,
                reflections = false, drawDistance = 1250f, particles = 0.6f),
            // high (the site's default) — everything on
            QualityPreset("high", 1.0f, gtao = true, bloom = true, smaa = true,
                reflections = true, drawDistance = 1600f, particles = 1.0f),
            // ultra — longest draw distance, heaviest particle load
            QualityPreset("ultra", 1.3f, gtao = true, bloom = true, smaa = true,
                reflections = true, drawDistance = 2000f, particles = 1.3f),
        )
        fun byName(name: String): QualityPreset = PRESETS.firstOrNull { it.name == name } ?: PRESETS[2]
    }
}

/**
 * Port of perfguard/guard.js createGuard() — the same constants, the same state machine:
 * median over ~2 s, spikes (>=400 ms) dropped as hitches not signal, debt grows only while
 * the median is below 45 fps and drains only above 55 (the 45..55 dead-band never fires),
 * 4 s of continuous shortfall to fire, 8 s cooldown after each step, 6 s warm-up, max 2 steps.
 */
class PerfGuard(
    private val targetFps: Double = 45.0,
    private val recoverFps: Double = 55.0,
    private val windowMs: Int = 2000,
    private val sustainMs: Int = 4000,
    private val cooldownMs: Int = 8000,
    private val warmupMs: Int = 6000,
    private val evaluateMs: Int = 250,
    private val spikeMs: Int = 400,
    private val maxSteps: Int = 2,
) {
    private val budgetMs = 1000.0 / targetFps
    private val recoverMs = 1000.0 / recoverFps
    private val maxDebt = sustainMs * 1.5

    private val times = ArrayList<Long>(128)   // timestamps, parallel to frames
    private val frames = ArrayList<Float>(128) // frame durations in ms
    private var debt = 0.0
    private var steps = 0
    private var lastEval = 0L
    private var blockedUntil = warmupMs.toLong() // relative to the first sample
    private var t0 = 0L
    private var started = false
    var lastMedian = 0f
        private set

    /** guard.js sample(): 'stepDown' or null. */
    fun sample(nowMs: Long, frameMs: Float): String? {
        if (!started) { started = true; t0 = nowMs }
        val t = nowMs - t0
        if (frameMs >= spikeMs) return null // an alt-tab is not a performance signal
        times.add(t); frames.add(frameMs)
        while (times.isNotEmpty() && t - times[0] > windowMs) { times.removeAt(0); frames.removeAt(0) }
        if (t < blockedUntil || steps >= maxSteps) return null
        if (t - lastEval < evaluateMs) return null
        lastEval = t
        val med = median(frames)
        lastMedian = med
        if (med < budgetMs) debt = (debt + (evaluateMs.toDouble()) * (1.0 - med / budgetMs)).coerceAtMost(maxDebt)
        else if (med > recoverMs) debt = (debt - evaluateMs.toDouble() * 0.5).coerceAtLeast(0.0)
        return if (debt >= sustainMs) {
            debt = 0.0
            steps++
            blockedUntil = t + cooldownMs
            "stepDown"
        } else null
    }

    private fun median(values: List<Float>): Float {
        if (values.isEmpty()) return 0f
        val s = values.toFloatArray(); s.sort()
        val n = s.size
        return if (n % 2 == 1) s[n / 2] else (s[n / 2 - 1] + s[n / 2]) * 0.5f
    }
}
