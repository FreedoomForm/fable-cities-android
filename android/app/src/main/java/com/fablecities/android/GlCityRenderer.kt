package com.fablecities.android

import android.opengl.GLES30
import android.opengl.GLSurfaceView
import android.opengl.Matrix
import android.util.Log
import com.fablecities.android.worldgen.DemoCity
import com.fablecities.android.worldgen.CloudShadowMap
import com.fablecities.android.worldgen.Clouds
import com.fablecities.android.worldgen.Environment
import com.fablecities.android.worldgen.WeatherPresets
import com.fablecities.android.worldgen.Heightmap
import com.fablecities.android.worldgen.PuddleField
import com.fablecities.android.worldgen.Rng
import com.fablecities.android.worldgen.RoadNetBuilder
import com.fablecities.android.worldgen.SimBuilding
import com.fablecities.android.worldgen.Stars
import com.fablecities.android.worldgen.Traffic
import com.fablecities.android.worldgen.Weather
import com.fablecities.android.worldgen.WaterMath
import com.fablecities.android.worldgen.SimEconomy
import com.fablecities.android.worldgen.SimMilestones
import com.fablecities.android.worldgen.SimServices
import com.fablecities.android.worldgen.SERVICE_TYPES
import com.fablecities.android.worldgen.simHashString
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.Random
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Native OpenGL ES 3.0 city renderer. Deterministic (seeded), 16:9 letterboxed viewport,
 * orbit camera, day/night cycle with emissive windows, moving vehicles, fog and water.
 * All gameplay geometry is drawn inside the letterboxed viewport; the sky fills the surface.
 */
class GlCityRenderer : GLSurfaceView.Renderer {

    interface Listener {
        fun onMessage(text: String)
        fun onCityEdited()
        fun onHourChanged(hour: Float, day: Int)
    }

    var listener: Listener? = null
    var paused = false

    // --- camera ---
    private val camTarget = floatArrayOf(40f, 14f, 0f)
    private var camYaw = 0.6f
    private var camPitch = 0.95f
    private var camDist = 320f
    private val camTargetGoal = floatArrayOf(40f, 14f, 0f)
    private var camYawGoal = 0.6f
    private var camPitchGoal = 0.95f
    private var camDistGoal = 320f

    // --- matrices ---
    private val projM = FloatArray(16)
    private val viewM = FloatArray(16)
    private val vpM = FloatArray(16)
    private val invVpM = FloatArray(16)

    // --- time of day: the site's defaults (Config.js time=14.0, World.js month=5/day=1,
    // secondsPerHour=20) and the site's clock speed ---
    var hour = Environment.DEFAULT_HOUR.toFloat()
        private set
    var day = 1
    private var envHour = Float.NaN
    private var envDoy = -1
    private val envState = Environment.EnvState()
    /** The site's weather model (environment/Weather.js), driven by the game clock. */
    val weather = Weather(1337, "clear")
    /** Lazily-baked cloud ground-shadow map (CloudShadow.js). */
    private val cloudShadowMap: CloudShadowMap by lazy {
        CloudShadowMap(Clouds.buildWeatherTexture(1337), Clouds.buildCloudNoiseTexture(1337), 22000.0)
    }
    private val sun = SunState()

    // --- world constants: the SITE'S real world (2048 m, seed 1337, sea level 0) ---
    private val mapHalf = 1024f
    private val cityHalf = 504f // tool grid + prebuilt content extent (east of the river)
    private val waterY = 0f
    private val cellSize = 24f
    private val gridN = 42
    private lateinit var worldHeight: Heightmap

    // --- shaders ---
    private var progTerrain = 0
    private var progFlat = 0
    private var progBuilding = 0
    private var progWater = 0
    private var progSky = 0
    private var progPrecip = 0
    private var precipVbo = 0
    private var precipTime = 0.0
    /** Precipitation.js: camera-following volume of GPU-wrapped streak/flake seeds. */
    private val PRECIP_N = 2600
    private val PRECIP_VOLUME = floatArrayOf(150f, 80f, 150f)
    // --- planar reflection RT (Water.js renderReflection): half-res colour + depth ---
    private var reflFbo = 0
    private var reflTex = 0
    private var reflDepth = 0
    private var reflW = 0
    private var reflH = 0
    private val reflViewM = FloatArray(16)
    private val reflViewInvM = FloatArray(16)
    private val reflProjM = FloatArray(16)
    private val reflVpM = FloatArray(16)
    private val reflTexM = FloatArray(16)
    private val reflBias = floatArrayOf(
        0.5f, 0f, 0f, 0f,  0f, 0.5f, 0f, 0f,  0f, 0f, 0.5f, 0f,  0.5f, 0.5f, 0.5f, 1f,
    )
    // --- volumetric clouds (CloudLayer + CloudShadowMap): baked CPU textures + raymarch dome ---
    private var progClouds = 0
    private var progPuddle = 0
    private var pudVbo = 0
    private var pudIbo = 0
    private var pudIdxCount = 0
    private var pudTime = 0f
    private var pudDrainXf = FloatArray(4) // originX, originZ, 1/spanMetres, hasMap (PuddleField.js)
    private var texCloudNoise = 0 // 64³ RGBA8 Perlin-Worley (GL_TEXTURE_3D)
    private var texCloudWeather = 0
    private var texCloudCirrus = 0
    private var texCloudShadow = 0
    private var cloudShadowBakedCover = -1.0

    // --- geometry handles ---
    private var terrainVbo = 0
    private var terrainCount = 0
    private var cityGroundVbo = 0
    private var cityGroundCount = 0
    private var waterVbo = 0
    private var waterCount = 0
    private var texHeight = 0
    private var texShore = 0
    private var texNoise = 0
    private var texWNormal = 0
    private var texAlbedoArr = 0
    private var texNormalArr = 0
    private var texControl = 0
    private var texControl2 = 0
    private var texTNormal = 0
    private var texDrainage = 0
    /** application context — needed to decode the splat layer JPEGs from the APK assets */
    @Volatile var appContext: android.content.Context? = null
    private var texStars = 0
    private var texMoon = 0
    private val starRotM = FloatArray(9) // world → celestial frame (uStarRot)
    private var cubeVbo = 0
    private var carVbo = 0
    private var carCount = 0
    private var pedVbo = 0
    private var pedCount = 0
    private var vanVbo = 0
    private var vanCount = 0
    private var truckVbo = 0
    private var truckCount = 0
    private var busVbo = 0
    private var busCount = 0
    private var skyVbo = 0
    private var editRoadVbo = 0
    private var editRoadCount = 0
    private var editZoneVbo = 0
    private var editZoneCount = 0

    private var surfaceW = 1
    private var surfaceH = 1
    private val letterbox = FloatArray(4) // x, y, w, h in pixels

    // --- city data ---
    private class Building(
        val x: Float, val y: Float, val z: Float, val w: Float, val d: Float, val h: Float,
        val kind: Int, val yaw: Float, val seed: Int, val cell: Int, var removed: Boolean = false
    )

    private val buildings = ArrayList<Building>()
    private var selectedBuilding: Building? = null

    private class RoadSeg(val x0: Float, val z0: Float, val x1: Float, val z1: Float, val hw: Float)

    // --- traffic: the site's real IDM car-following sim + full LaneNetwork (junctions, signals,
    //     conflict matrix, A*) — traffic/LaneNetwork.js + TrafficSim.js ports ---
    private var trafficNet: Traffic.LaneNetwork? = null
    private var trafficSim: Traffic.TrafficSim? = null
    private val MAX_VEHICLES = 96
    private val MAX_PEDS = 64
    private val roadSegs = ArrayList<RoadSeg>()
    private var cityYaw = 0f
    private lateinit var demo: DemoCity
    private val roadCells = HashSet<Int>()
    private val zoneCells = HashMap<Int, Int>() // cell -> 0 res, 1 com, 2 ind
    private var editsDirty = false
    private var lastSaveHint = 0L

    private var frameNanos = 0L
    // frame-time instrumentation (perfguard-style): rolling 240-frame window, avg + 1%-low
    private val frameTimes = FloatArray(240)
    private var frameIdx = 0
    private var lastFrameLog = 0L
    private var glErrorLogged = false

    // --- simulation: the site's real economy / services / milestones model (simulation.js port) ---
    private lateinit var simServices: SimServices
    private lateinit var simEconomy: SimEconomy
    private lateinit var simMilestones: SimMilestones
    private val simBuildingList = ArrayList<SimBuilding>()
    private var simMinutesAcc = 0.0
    private var demoRoadCost = 0.0
    private var pendingMoney: Int? = null

    // ---------------------------------------------------------------- lifecycle

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        GLES30.glEnable(GLES30.GL_DEPTH_TEST)
        GLES30.glEnable(GLES30.GL_CULL_FACE)
        GLES30.glCullFace(GLES30.GL_BACK)
        GLES30.glClearColor(0.03f, 0.05f, 0.08f, 1f)

        progTerrain = buildProgram(TerrainShaders.VS_TERRAIN, TerrainShaders.FS_TERRAIN, "terrain")
        progFlat = buildProgram(VS_LIT, TerrainShaders.FS_LIT_WET, "flat")
        progBuilding = buildProgram(VS_BUILDING, FS_BUILDING, "building")
        progWater = buildProgram(VS_WATER, FS_WATER, "water")
        progSky = buildProgram(VS_SKY, FS_SKY, "sky")
        progPrecip = buildProgram(VS_PRECIP, FS_PRECIP, "precip")
        progClouds = buildProgram(VS_SKY, FS_CLOUDS, "clouds")
        progPuddle = buildProgram(TerrainShaders.VS_PUDDLE, TerrainShaders.FS_PUDDLE, "puddle")
        buildPrecipBuffer()
        buildCloudTextures()

        // The real world: the site's 2048 m heightmap (seed 1337), then THE SITE'S demo city:
        // the shoreline-fitted site picker, block grading and the full street network
        // (motorway + trumpet interchange, downtown grid, boulevards, crescents, industry).
        worldHeight = Heightmap(size = 2048, spacing = 4, seed = 1337).generate()
        demo = DemoCity(worldHeight, 1337)
        demo.buildStreets()
        demo.gradeBlocks()
        conformRoads()
        demo.buildRoutes()
        demo.generateBlocks()
        buildRoadNet()
        cityYaw = atan2(-demo.site.uz, demo.site.ux).toFloat()
        val cc = demo.L(0.0, demo.COAST_V + demo.ROWS[2])
        val camY = worldHeight.getHeight(cc[0], cc[1]).toFloat() + 12f
        camTarget[0] = cc[0].toFloat(); camTarget[1] = camY; camTarget[2] = cc[1].toFloat()
        camTargetGoal[0] = camTarget[0]; camTargetGoal[1] = camY; camTargetGoal[2] = camTarget[2]
        camYaw = atan2(-demo.site.ux, -demo.site.uz).toFloat()
        camYawGoal = camYaw
        camPitch = 0.85f; camPitchGoal = 0.85f
        camDist = 430f; camDistGoal = 430f
        buildTerrainSplat()
        buildTerrain()
        buildRoadMesh()
        buildPuddles()
        loadBuildings()
        buildWater()
        buildStars()
        buildCube()
        buildCar()
        buildPed()
        buildVan()
        buildTruck()
        buildBus()
        buildSky()
        rebuildEditMeshes()
        generateVehicles()
        initSimulation()
        glReady = true
        pendingCamera?.let { restoreCamera(it) }
        pendingEdits?.let { applyEdits(it) }
        pendingEdits = null
        pendingCamera = null
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        surfaceW = max(1, width)
        surfaceH = max(1, height)
        computeLetterbox()
        setupReflectionFbo()
    }

    /** The site's baked cloud textures (worldgen Clouds.kt = the web's Clouds.js CPU bakes). */
    private fun buildCloudTextures() {
        if (texCloudNoise != 0) return
        val noise = Clouds.buildCloudNoiseTexture(1337)
        val weather = Clouds.buildWeatherTexture(1337)
        val cirrus = Clouds.buildCirrusTexture(1337)
        texCloudNoise = uploadTex3D(Clouds.NOISE_SIZE, Clouds.NOISE_SIZE, Clouds.NOISE_SIZE, noise)
        texCloudWeather = uploadTex2D(
            Clouds.WEATHER_SIZE, Clouds.WEATHER_SIZE, GLES30.GL_RGBA8, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE,
            wrapBytes(weather), repeat = true, mipmaps = false)
        texCloudCirrus = uploadTex2D(
            256, 256, GLES30.GL_RGBA8, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE,
            wrapBytes(cirrus), repeat = true, mipmaps = false)
        // R8 ground-shadow texture (CloudShadowMap), re-baked from updateCloudShadows()
        texCloudShadow = uploadTex2D(
            CloudShadowMap.SIZE, CloudShadowMap.SIZE, GLES30.GL_R8, GLES30.GL_RED, GLES30.GL_UNSIGNED_BYTE,
            wrapBytes(ByteArray(CloudShadowMap.SIZE * CloudShadowMap.SIZE) { 255.toByte() }), repeat = true, mipmaps = false)
    }

    private fun wrapBytes(b: ByteArray): java.nio.Buffer =
        java.nio.ByteBuffer.allocateDirect(b.size).order(java.nio.ByteOrder.nativeOrder()).put(b).apply { flip() }

    private fun uploadTex3D(w: Int, h: Int, d: Int, data: ByteArray): Int {
        val ids = IntArray(1)
        GLES30.glGenTextures(1, ids, 0)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_3D, ids[0])
        GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 1)
        GLES30.glTexImage3D(GLES30.GL_TEXTURE_3D, 0, GLES30.GL_RGBA8, w, h, d, 0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, wrapBytes(data))
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR_MIPMAP_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_REPEAT)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_REPEAT)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_WRAP_R, GLES30.GL_REPEAT)
        GLES30.glGenerateMipmap(GLES30.GL_TEXTURE_3D)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_3D, 0)
        return ids[0]
    }

    /** CloudShadowMap.update + re-upload when coverage crossed the re-bake threshold. */
    private fun updateCloudShadows(cover: Double, strength: Double) {
        if (texCloudShadow == 0) return
        val shadow = cloudShadowMap
        if (!shadow.update(cover, strength)) return
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texCloudShadow)
        GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 1)
        GLES30.glTexSubImage2D(GLES30.GL_TEXTURE_2D, 0, 0, 0, CloudShadowMap.SIZE, CloudShadowMap.SIZE,
            GLES30.GL_RED, GLES30.GL_UNSIGNED_BYTE, wrapBytes(shadow.data))
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, 0)
        cloudShadowBakedCover = cover
    }

    /** Water.js reflection target: RGBA8 + depth at reflectionScale 0.5 of the viewport. */
    private fun setupReflectionFbo() {
        val w = max(256, floor(letterbox[2] * 0.5f).toInt())
        val h = max(256, floor(letterbox[3] * 0.5f).toInt())
        if (reflFbo != 0 && w == reflW && h == reflH) return
        if (reflFbo != 0) {
            GLES30.glDeleteFramebuffers(1, intArrayOf(reflFbo), 0)
            GLES30.glDeleteTextures(1, intArrayOf(reflTex), 0)
            GLES30.glDeleteRenderbuffers(1, intArrayOf(reflDepth), 0)
            reflFbo = 0
        }
        val genTex = IntArray(1); val genRb = IntArray(1); val genFb = IntArray(1)
        GLES30.glGenTextures(1, genTex, 0)
        GLES30.glGenRenderbuffers(1, genRb, 0)
        GLES30.glGenFramebuffers(1, genFb, 0)
        reflTex = genTex[0]; reflDepth = genRb[0]; reflFbo = genFb[0]
        reflW = w; reflH = h
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, reflTex)
        GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA8, w, h, 0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, null)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glBindRenderbuffer(GLES30.GL_RENDERBUFFER, reflDepth)
        GLES30.glRenderbufferStorage(GLES30.GL_RENDERBUFFER, GLES30.GL_DEPTH_COMPONENT24, w, h)
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, reflFbo)
        GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0, GLES30.GL_TEXTURE_2D, reflTex, 0)
        GLES30.glFramebufferRenderbuffer(GLES30.GL_FRAMEBUFFER, GLES30.GL_DEPTH_ATTACHMENT, GLES30.GL_RENDERBUFFER, reflDepth)
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, 0)
        GLES30.glBindRenderbuffer(GLES30.GL_RENDERBUFFER, 0)
    }

    /** Water.js renderReflection: mirror the camera across the water plane, oblique-clip the
     *  near plane at it, render the reflectables into the RT (alpha 0 elsewhere). */
    private fun renderReflection(sun: SunState) {
        if (reflFbo == 0) { sun.reflectionStrength = 0f; return }
        val wl = 0f // the site's water level
        val cx = camTarget[0] + camDist * cos(camPitch) * sin(camYaw)
        val cy = camTarget[1] + camDist * sin(camPitch)
        val cz = camTarget[2] + camDist * cos(camPitch) * cos(camYaw)
        if (cy < wl) { sun.reflectionStrength = 0f; return }
        // mirror eye and look target across y = wl; up flips with them (three Reflector)
        Matrix.setLookAtM(reflViewM, 0, cx, 2f * wl - cy, cz,
            camTarget[0], 2f * wl - camTarget[1], camTarget[2], 0f, -1f, 0f)
        // texture matrix = bias x proj x viewInv (computed BEFORE the oblique modification)
        Matrix.invertM(reflViewInvM, 0, reflViewM, 0)
        Matrix.multiplyMM(reflTexM, 0, reflBias, 0, projM, 0)
        Matrix.multiplyMM(reflTexM, 0, reflTexM, 0, reflViewInvM, 0)
        // oblique near plane (Lengyel) so nothing below the water is reflected
        System.arraycopy(projM, 0, reflProjM, 0, 16)
        // world plane (n = (0,1,0), constant = -wl) into view space with the rigid view matrix
        val nvx = reflViewM[1]; val nvy = reflViewM[5]; val nvz = reflViewM[9]
        val ndotT = nvx * reflViewM[12] + nvy * reflViewM[13] + nvz * reflViewM[14]
        val clipX = nvx; val clipY = nvy; val clipZ = nvz; val clipW = -wl - ndotT
        run {
            val sx = if (clipX >= 0f) 1f else -1f
            val sy = if (clipY >= 0f) 1f else -1f
            val qx = (sx + reflProjM[8]) / reflProjM[0]
            val qy = (sy + reflProjM[9]) / reflProjM[5]
            val qw = (1f + reflProjM[10]) / reflProjM[14]
            val k = 2f / (clipX * qx + clipY * qy + clipZ * (-1f) + clipW * qw)
            reflProjM[2] = clipX * k
            reflProjM[6] = clipY * k
            reflProjM[10] = clipZ * k + 1f - 0.0005f
            reflProjM[14] = clipW * k
        }
        Matrix.multiplyMM(reflVpM, 0, reflProjM, 0, reflViewM, 0)

        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, reflFbo)
        GLES30.glViewport(0, 0, reflW, reflH)
        GLES30.glClearColor(0f, 0f, 0f, 0f) // alpha 0 where nothing is reflected → sky probe fallback
        GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT or GLES30.GL_DEPTH_BUFFER_BIT)
        val savedVp = vpM.copyOf()
        System.arraycopy(reflVpM, 0, vpM, 0, 16)
        GLES30.glCullFace(GLES30.GL_FRONT) // mirrored view flips winding
        drawTerrain(sun)
        drawCityGround(sun)
        drawEditQuads(sun)
        drawBuildings(sun)
        drawVehicles(sun)
        GLES30.glCullFace(GLES30.GL_BACK)
        System.arraycopy(savedVp, 0, vpM, 0, 16)
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
        GLES30.glClearColor(0.03f, 0.05f, 0.08f, 1f)
        sun.reflectionStrength = 1f
    }

    private fun computeLetterbox() {
        val vw = min(surfaceW.toFloat(), surfaceH * 16f / 9f)
        val vh = vw * 9f / 16f
        letterbox[0] = (surfaceW - vw) / 2f
        letterbox[1] = (surfaceH - vh) / 2f
        letterbox[2] = vw
        letterbox[3] = vh
    }

    override fun onDrawFrame(gl: GL10?) {
        val now = System.nanoTime()
        val dt = if (frameNanos == 0L) 0.016f else ((now - frameNanos) / 1_000_000_000f).coerceIn(0.001f, 0.1f)
        frameNanos = now
        frameTimes[frameIdx] = dt * 1000f
        frameIdx = (frameIdx + 1) % frameTimes.size
        if (now - lastFrameLog > 10_000_000_000L) {
            lastFrameLog = now
            val fs = frameStats()
            Log.d("GlCityRenderer", "frame avg %.2f ms (p99 %.2f ms, ~%.0f fps)".format(fs[0], fs[1], 1000f / fs[0]))
        }

        pudTime += dt
        if (!paused) {
            hour += dt / 20f // World.js: secondsPerHour = 20 at speed 1
            if (hour >= 24f) {
                hour -= 24f
                day++
                listener?.onHourChanged(hour, day)
            }
            // the site drives weather off the game clock (deterministic per seed + time)
            weather.update(dt.toDouble(), ((day * 24.0 + hour) * 3600.0))
            updateVehicles(dt)
            stepSimulation(dt)
        }
        updateCamera(dt)
        if (editsDirty && now - lastSaveHint > 900_000_000L) {
            editsDirty = false
            lastSaveHint = now
            listener?.onCityEdited()
        }

        // camera matrices
        val aspect = letterbox[2] / max(1f, letterbox[3])
        Matrix.perspectiveM(projM, 0, 50f, aspect, 5f, 2600f)
        val cx = camTarget[0] + camDist * cos(camPitch) * sin(camYaw)
        val cy = camTarget[1] + camDist * sin(camPitch)
        val cz = camTarget[2] + camDist * cos(camPitch) * cos(camYaw)
        Matrix.setLookAtM(viewM, 0, cx, cy, cz, camTarget[0], camTarget[1], camTarget[2], 0f, 1f, 0f)
        Matrix.multiplyMM(vpM, 0, projM, 0, viewM, 0)
        Matrix.invertM(invVpM, 0, vpM, 0)

        val sun = updateSunState()
        renderReflection(sun) // Water.js renderReflection — before the main render
        GLES30.glViewport(letterbox[0].toInt(), letterbox[1].toInt(), letterbox[2].toInt(), letterbox[3].toInt())
        GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT or GLES30.GL_DEPTH_BUFFER_BIT)

        // sky fills the letterboxed viewport (depth off)
        GLES30.glDisable(GLES30.GL_DEPTH_TEST)
        drawSky(sun)
        GLES30.glEnable(GLES30.GL_DEPTH_TEST)

        drawTerrain(sun)
        drawCityGround(sun)
        drawEditQuads(sun)
        drawBuildings(sun)
        drawVehicles(sun)
        drawPuddles(sun)
        drawWater(sun)
        drawClouds(sun)
        drawPrecipitation(sun)

        if (!glErrorLogged) {
            val err = GLES30.glGetError()
            if (err != GLES30.GL_NO_ERROR) {
                Log.e(TAG, "GL error 0x${Integer.toHexString(err)}")
                glErrorLogged = true
            }
        }
    }

    // ---------------------------------------------------------------- environment (the site's real sky)

    private class SunState {
        var dir = FloatArray(3)      // direction TOWARD the shadow-casting light (sun or moon, elev-clamped)
        var skySun = FloatArray(3)   // direction TOWARD the true sun (unclamped) for sky glow / water specular
        var color = FloatArray(3)    // display-referred light colour (intensity x exposure folded in)
        var ambient = FloatArray(3)  // display-referred hemisphere sky fill
        var dayFactor = 1f           // 1 by day, 0 at night (drives window lights)
        var zenith = FloatArray(3)   // CPU sky-model zenith radiance (display-referred)
        var horizon = FloatArray(3)  // CPU sky-model horizon radiance (display-referred)
        var fog = FloatArray(3)      // aerial-perspective colour (display-referred)
        var glow = FloatArray(3)     // sky-dome sun glow tint (unit colour x sunUp)
        var ambKey = 1f              // display ambient key for the water shader
        // --- water uniforms (the site's Water.js update() bridge) ---
        var moonDir = FloatArray(3)  // toward the moon (real ephemeris)
        var waterSun = FloatArray(3) // uSunColor * uSunIntensity, display-referred (sun glitter)
        var waterMoon = FloatArray(3)// uMoonColor * uMoonIntensity, display-referred (moon glitter)
        var skyColor = FloatArray(3) // env.skyColor (hemiCol x hemiIntensity/0.8, floored), display-referred
        var hemiRaw = 1.0            // env.ambientIntensity (unitless, NOT display-scaled) — uAmbient
        var nightFactor = 0f         // env.nightFactor — foam damping, night sheen, sky floor
        var waterFloor = FloatArray(3) // uSkyFloor, display-referred (computed like the web update())
        var waterSheen = FloatArray(3) // uNightSheen, display-referred (luminance-normalised night sheen)
        // --- sky: stars / Milky Way / moon disc / sun disc (environment shaders.js port) ---
        var starIntensity = 0f    // lerp(0.55, 1.45, nightAmount) x moon wash
        var milkyWay = 0f         // 3.6 x moon wash x (1-0.75*cover) x nightAmount
        var moonBright = 0f       // 2.0 x (1 - 0.4*clamp01(cover*1.1))
        var starSeed = 124.69f    // (seed % 1000) * 0.37
        var nightAmount = 0f      // st.nightAmount (star intensity driver)
        var nightKey = 1f         // exposure x K_SKY: radiance → display for the star/disc radiance
        var sunDisc = 0f          // ATMOS.sunDiscRadiance x elevation lerp, display-referred
        val sunTint = FloatArray(3) // white lerp (1, 0.52, 0.20) at golden hour
        // --- weather (environment/Weather.js + computeFrame weather branch) ---
        var fogDensity = 0.00056f // weather.state.fog (exp2 fog density, 1/m)
        var skyFog = 0f           // dome dissolve into the luminous fog colour (0 clear .. 0.92 fog)
        var fogSunGlow = 0f       // forward-scatter sun glow through the medium (uFogSun.w = x0.8)
        var wetness = 0f          // weather.wetness * (1 - snowCover) — wet-surface darkening
        var snowCover = 0f        // snow accumulation — ground whitening
        var precip = 0f           // smoothed rain|snow — particle system alpha
        var precipMode = 0f       // 0 rain, 1 snow (by the dominant type)
        var starFade = 0.82f      // 1 - 0.6 x cloudCover — star wash under the deck
        var reflectionStrength = 0f // 1 after a successful planar reflection pass (Water.js)
        var fogSkyCol = FloatArray(3) // st.fogColor x sK — the dome's fog-dissolve colour (milk)
        // --- volumetric cloud uniforms (index.js 484-522 feed), display-referred via K_LIGHT ---
        var cloudLight = FloatArray(3)
        var cloudAmbTop = FloatArray(3)
        var cloudAmbBottom = FloatArray(3)
        var cloudAmbSunSide = FloatArray(3)
        var cloudHaze = FloatArray(3)
        var cloudHazeDensity = 0f
        var cloudScatter = 2.9f
        var cloudShadowStrength = 0f
        val cloudLightToward = FloatArray(3)
    }

    /** Display key scales: the web multiplies radiance by exposure and tone-maps (AgX); the native
     *  pipeline clips, so radiance x exposure is folded into the uniforms through one constant. */
    private val K_LIGHT = 0.25
    private val K_SKY = 0.32

    /** Rebuild the lighting key from the ported site model. Refreshed at the web's cadence
     *  (0.15 s or on time jumps); between refreshes the last key is reused — the sun moves
     *  imperceptibly within 0.02 h of game time. */
    private fun updateSunState(): SunState {
        val doy = Environment.dayOfYear(Environment.DEFAULT_MONTH, Environment.DEFAULT_DAY) + (day - 1)
        val eyeY = camTarget[1] + camDist * sin(camPitch)
        val camAlt = max(1.0, eyeY.toDouble())
        // camera forward (horizontal), as the web's horizon weighting uses
        val fwdX = -cos(camPitch) * sin(camYaw)
        val fwdZ = -cos(camPitch) * cos(camYaw)
        val jumped = java.lang.Float.isNaN(envHour) || envDoy != doy ||
            abs(hour - envHour) > 0.02f || abs(camAlt.toFloat() - envCamAlt) > 4f
        if (jumped) {
            envHour = hour
            envDoy = doy
            envCamAlt = camAlt.toFloat()
            Environment.compute(hour.toDouble(), doy, Environment.LATITUDE, camAlt, fwdX.toDouble(), fwdZ.toDouble(), envState, weather.state)
            val st = envState
            // shadow-casting light: toward-light direction, display key = intensity x exposure x K
            val iK = st.sunIntensity >= st.moonIntensity
            sun.dir[0] = -st.lightDir[0].toFloat(); sun.dir[1] = -st.lightDir[1].toFloat(); sun.dir[2] = -st.lightDir[2].toFloat()
            sun.skySun[0] = st.sunDir[0].toFloat(); sun.skySun[1] = st.sunDir[1].toFloat(); sun.skySun[2] = st.sunDir[2].toFloat()
            val lc = if (iK) st.sunColor else st.moonColor
            val li = (if (iK) st.sunIntensity else st.moonIntensity) * st.exposure * K_LIGHT
            sun.color[0] = (lc[0] * li).toFloat(); sun.color[1] = (lc[1] * li).toFloat(); sun.color[2] = (lc[2] * li).toFloat()
            val aK = st.hemiIntensity * st.exposure * K_LIGHT
            sun.ambient[0] = (st.hemiCol[0] * aK).toFloat(); sun.ambient[1] = (st.hemiCol[1] * aK).toFloat(); sun.ambient[2] = (st.hemiCol[2] * aK).toFloat()
            sun.dayFactor = (1.0 - st.nightFactor).toFloat()
            val sK = st.exposure * K_SKY
            sun.zenith[0] = (st.skyAvg[0] * sK).toFloat(); sun.zenith[1] = (st.skyAvg[1] * sK).toFloat(); sun.zenith[2] = (st.skyAvg[2] * sK).toFloat()
            sun.horizon[0] = (st.horizonAvg[0] * sK).toFloat(); sun.horizon[1] = (st.horizonAvg[1] * sK).toFloat(); sun.horizon[2] = (st.horizonAvg[2] * sK).toFloat()
            sun.fog[0] = (st.fogColor[0] * sK).toFloat(); sun.fog[1] = (st.fogColor[1] * sK).toFloat(); sun.fog[2] = (st.fogColor[2] * sK).toFloat()
            // sky-dome glow: unit sun colour x sunUp (refraction keeps the disc visible to about -0.8 deg)
            val sunUp = Environment.smoothstep(-1.8, 1.2, st.sunAltDeg)
            val gMax = max(st.sunColor[0], max(st.sunColor[1], st.sunColor[2])).coerceAtLeast(1e-4)
            sun.glow[0] = (st.sunColor[0] / gMax * sunUp).toFloat()
            sun.glow[1] = (st.sunColor[1] / gMax * sunUp).toFloat()
            sun.glow[2] = (st.sunColor[2] / gMax * sunUp).toFloat()
            sun.ambKey = (st.hemiIntensity * st.exposure * K_LIGHT).toFloat()

            // --- water bridge (Water.js update() semantics, display-referred) ---
            sun.moonDir[0] = st.moonDir[0].toFloat(); sun.moonDir[1] = st.moonDir[1].toFloat(); sun.moonDir[2] = st.moonDir[2].toFloat()
            val wK = st.exposure * K_LIGHT
            sun.waterSun[0] = (st.sunColor[0] * st.sunIntensity * wK).toFloat()
            sun.waterSun[1] = (st.sunColor[1] * st.sunIntensity * wK).toFloat()
            sun.waterSun[2] = (st.sunColor[2] * st.sunIntensity * wK).toFloat()
            sun.waterMoon[0] = (st.moonColor[0] * st.moonIntensity * wK).toFloat()
            sun.waterMoon[1] = (st.moonColor[1] * st.moonIntensity * wK).toFloat()
            sun.waterMoon[2] = (st.moonColor[2] * st.moonIntensity * wK).toFloat()
            // env.skyColor = hemiCol * max(hemiIntensity, 0.02) / 0.8, floored, then display key
            val amb = max(st.hemiIntensity, 0.02)
            var sr = st.hemiCol[0] * amb / 0.8
            var sg = st.hemiCol[1] * amb / 0.8
            var sb = st.hemiCol[2] * amb / 0.8
            sr = max(sr, 0.004); sg = max(sg, 0.006); sb = max(sb, 0.012)
            sun.skyColor[0] = (sr * wK).toFloat(); sun.skyColor[1] = (sg * wK).toFloat(); sun.skyColor[2] = (sb * wK).toFloat()
            sun.hemiRaw = st.hemiIntensity
            val night = st.nightFactor
            sun.nightFactor = night.toFloat()
            // uSkyFloor: sky*amb*0.055 + night offsets, pulled 0.45/0.55 to its own luminance
            var fr = sr * st.hemiIntensity * 0.055 + 0.0055 * night
            var fg = sg * st.hemiIntensity * 0.055 + 0.0068 * night
            var fb = sb * st.hemiIntensity * 0.055 + 0.0105 * night
            val fy = 0.2126 * fr + 0.7152 * fg + 0.0722 * fb
            fr = fr * 0.45 + fy * 0.55; fg = fg * 0.45 + fy * 0.55; fb = fb * 0.45 + fy * 0.55
            sun.waterFloor[0] = (fr * wK).toFloat(); sun.waterFloor[1] = (fg * wK).toFloat(); sun.waterFloor[2] = (fb * wK).toFloat()
            // uNightSheen: sky * night^2 * 0.024 / lum(sky) (luminance-normalised, scale-invariant)
            val skyLum = max(1e-4, 0.2126 * sr + 0.7152 * sg + 0.0722 * sb)
            val sheen = night * night * 0.024 / skyLum
            sun.waterSheen[0] = (sr * sheen * wK).toFloat()
            sun.waterSheen[1] = (sg * sheen * wK).toFloat()
            sun.waterSheen[2] = (sb * sheen * wK).toFloat()

            // --- stars / Milky Way / moon disc / sun disc (index.js computeFrame sky uniforms) ---
            val na = st.nightAmount
            val cover = st.cloudCover
            sun.nightAmount = na.toFloat()
            val moonWashStar = Environment.lerp(1.0, 0.55, min(1.0, st.moonIntensity / 0.14))
            sun.starIntensity = (Environment.lerp(0.55, 1.45, na) * moonWashStar).toFloat()
            val moonWashMw = Environment.lerp(1.0, 0.30, min(1.0, st.moonIntensity / 0.12))
            sun.milkyWay = (3.6 * moonWashMw * (1.0 - 0.75 * cover) * na).toFloat()
            sun.moonBright = (2.0 * Environment.lerp(1.0, 0.4, min(1.0, cover * 1.1))).toFloat()
            sun.nightKey = (st.exposure * K_SKY).toFloat()
            sun.starSeed = ((1337 % 1000) * 0.37).toFloat()
            // weather outputs: fog medium, wetness/snow, precipitation particles
            sun.fogDensity = st.fogDensity.toFloat()
            sun.skyFog = st.skyFog.toFloat()
            sun.fogSunGlow = (st.fogSunGlow * 0.8).toFloat()
            sun.wetness = st.wetness.toFloat()
            sun.snowCover = st.snowCover.toFloat()
            sun.precip = weather.precipitation.toFloat()
            sun.precipMode = if (weather.snowCover >= weather.wetness && weather.snowCover > 0.02) 1f else 0f
            sun.starFade = (1.0 - 0.6 * cover).toFloat()
            sun.fogSkyCol[0] = (st.fogColor[0] * sK).toFloat()
            sun.fogSkyCol[1] = (st.fogColor[1] * sK).toFloat()
            sun.fogSkyCol[2] = (st.fogColor[2] * sK).toFloat()

            // sun disc: ATMOS.sunDiscRadiance x elevation lerp, tinted at golden hour (index.js)
            val lowSun = 1.0 - Environment.smoothstep(4.0, 20.0, st.sunAltDeg)
            val discLerp = Environment.lerp(0.34, 1.0, Environment.smoothstep(1.0, 16.0, st.sunAltDeg))
            sun.sunDisc = (Stars.SUN_DISC_RADIANCE * discLerp * st.exposure * K_SKY).toFloat()
            val tintMix = 0.85 * lowSun * sunUp
            sun.sunTint[0] = Environment.lerp(1.0, 1.0, tintMix).toFloat()
            sun.sunTint[1] = Environment.lerp(1.0, 0.52, tintMix).toFloat()
            sun.sunTint[2] = Environment.lerp(1.0, 0.20, tintMix).toFloat()
            // --- cloud uniform feed (index.js 484-522), folded into the display key ---
            val ck = st.exposure * K_LIGHT
            val isSunLight = st.sunIntensity >= st.moonIntensity
            sun.cloudLightToward[0] = (-st.lightDir[0]).toFloat()
            sun.cloudLightToward[1] = (-st.lightDir[1]).toFloat()
            sun.cloudLightToward[2] = (-st.lightDir[2]).toFloat()
            val moonUpC = Environment.smoothstep(-1.0, 6.0, st.moonAltDeg)
            if (isSunLight) {
                // lc = sunTHigh grey-lerped, low-sun falloff lifted like the ground key
                var lr = st.sunTHigh[0]; var lg = st.sunTHigh[1]; var lb = st.sunTHigh[2]
                val ll0 = Environment.luminance(doubleArrayOf(lr, lg, lb))
                // lerp toward the grey of its own luminance (the web's S.grey trick)
                lr += (ll0 - lr) * 0.18; lg += (ll0 - lg) * 0.18; lb += (ll0 - lb) * 0.18
                val lcMax = max(lr, max(lg, max(lb, 1e-4)))
                val lift = Math.pow(lcMax, Environment.lerp(1.0, 0.7, lowSun)) / lcMax * Environment.SUN_E *
                    Environment.lerp(1.0, 0.5, lowSun) * Environment.smoothstep(-3.5, 0.2, st.sunAltDeg)
                sun.cloudLight[0] = (lr * lift * ck).toFloat()
                sun.cloudLight[1] = (lg * lift * ck).toFloat()
                sun.cloudLight[2] = (lb * lift * ck).toFloat()
            } else {
                sun.cloudLight[0] = (st.moonColor[0] * Environment.MOON_LIGHT * st.moonIllum * moonUpC * 0.85 * ck).toFloat()
                sun.cloudLight[1] = (st.moonColor[1] * Environment.MOON_LIGHT * st.moonIllum * moonUpC * 0.85 * ck).toFloat()
                sun.cloudLight[2] = (st.moonColor[2] * Environment.MOON_LIGHT * st.moonIllum * moonUpC * 0.85 * ck).toFloat()
            }
            val moonAmbR = st.moonColor[0] * st.moonIntensity * 0.16
            val moonAmbG = st.moonColor[1] * st.moonIntensity * 0.16
            val moonAmbB = st.moonColor[2] * st.moonIntensity * 0.16
            val skyAvgL = st.skyAvg; val horL = st.horizonAvg; val ssL = st.sunSideAvg
            val ambTopK = Environment.lerp(0.35, 0.12, lowSun)
            sun.cloudAmbTop[0] = ((skyAvgL[0] * 0.7 + Environment.NIGHT_GLOW[0] * na * 3.0 + moonAmbR) * ck).toFloat()
            sun.cloudAmbTop[1] = ((skyAvgL[1] * 0.7 + Environment.NIGHT_GLOW[1] * na * 3.0 + moonAmbG) * ck).toFloat()
            sun.cloudAmbTop[2] = ((skyAvgL[2] * 0.7 + Environment.NIGHT_GLOW[2] * na * 3.0 + moonAmbB) * ck).toFloat()
            sun.cloudAmbBottom[0] = ((skyAvgL[0] + (horL[0] - skyAvgL[0]) * ambTopK) * 0.66 + st.groundRad[0] * Environment.lerp(0.10, 0.03, lowSun) + Environment.NIGHT_GLOW[0] * na * 1.3 + moonAmbR * 0.45).let { (it * ck).toFloat() }
            sun.cloudAmbBottom[1] = ((skyAvgL[1] + (horL[1] - skyAvgL[1]) * ambTopK) * 0.66 + st.groundRad[1] * Environment.lerp(0.10, 0.03, lowSun) + Environment.NIGHT_GLOW[1] * na * 1.3 + moonAmbG * 0.45).let { (it * ck).toFloat() }
            sun.cloudAmbBottom[2] = ((skyAvgL[2] + (horL[2] - skyAvgL[2]) * ambTopK) * 0.66 + st.groundRad[2] * Environment.lerp(0.10, 0.03, lowSun) + Environment.NIGHT_GLOW[2] * na * 1.3 + moonAmbB * 0.45).let { (it * ck).toFloat() }
            val sunSideK = 1.25 * lowSun * sunUp * (1.0 - 0.6 * cover)
            sun.cloudAmbSunSide[0] = (ssL[0] * sunSideK * ck).toFloat()
            sun.cloudAmbSunSide[1] = (ssL[1] * sunSideK * ck).toFloat()
            sun.cloudAmbSunSide[2] = (ssL[2] * sunSideK * ck).toFloat()
            val hazeK = 0.35
            sun.cloudHaze[0] = ((st.fogColor[0] + (skyAvgL[0] - st.fogColor[0]) * hazeK) * ck).toFloat()
            sun.cloudHaze[1] = ((st.fogColor[1] + (skyAvgL[1] - st.fogColor[1]) * hazeK) * ck).toFloat()
            sun.cloudHaze[2] = ((st.fogColor[2] + (skyAvgL[2] - st.fogColor[2]) * hazeK) * ck).toFloat()
            sun.cloudHazeDensity = (st.fogDensity * 0.3).toFloat()
            sun.cloudScatter = Environment.lerp(2.9, 1.5, na).toFloat()
            // shadow strength: fair-weather cumulus keep light in the shade; low sun fades the projection
            sun.cloudShadowStrength = ((0.62 + 0.26 * Environment.smoothstep(0.3, 0.9, cover)) *
                Environment.lerp(0.35, 1.0, Environment.smoothstep(4.0, 15.0, st.sunAltDeg))).toFloat()
            // star rotation: world → celestial frame (SkyDome.setStarRotation)
            setStarRotation(Environment.LATITUDE * PI / 180.0, st.siderealAngle)
        }
        return sun
    }

    /** SkyDome.setStarRotation: celestial pole = north (-Z) tilted up by latitude; the cube spins
     *  with sidereal time. Fills starRotM (column-major 3x3, as GL expects). */
    private fun setStarRotation(latRad: Double, siderealAngle: Double) {
        val px = 0.0; val py = sin(latRad); val pz = -cos(latRad)
        // qSpin: axis (px,py,pz), angle -siderealAngle
        val spinHalf = -siderealAngle / 2.0
        val sx = px * sin(spinHalf); val sy = py * sin(spinHalf); val sz = pz * sin(spinHalf)
        val sw = cos(spinHalf)
        // qTilt: rotation from pole to +Y (three setFromUnitVectors, a != -b)
        val d = max(-1.0, min(1.0, py))
        val tx: Double; val ty: Double; val tz: Double; val tw: Double
        if (d < -1.0 + 1e-6) { tx = 1.0; ty = 0.0; tz = 0.0; tw = 0.0 } // opposite: 180 deg about X
        else {
            // v = a x b, w = 1 + a.b (a = pole, b = +Y)
            tx = py * 0.0 - pz * 1.0
            ty = pz * 0.0 - px * 0.0
            tz = px * 1.0 - py * 0.0
            tw = 1.0 + d
        }
        val tl = sqrt(tx * tx + ty * ty + tz * tz + tw * tw)
        val qx = tx / tl; val qy = ty / tl; val qz = tz / tl; val qw = tw / tl
        // q = qTilt * qSpin (three Quaternion.multiply: this x q)
        val rx = qw * sx + qx * sw + qy * sz - qz * sy
        val ry = qw * sy - qx * sz + qy * sw + qz * sx
        val rz = qw * sz + qx * sy - qy * sx + qz * sw
        val rw = qw * sw - qx * sx - qy * sy - qz * sz
        // rotation matrix from q (three Matrix4.makeRotationFromQuaternion, upper-left 3x3, column-major)
        val x2 = rx + rx; val y2 = ry + ry; val z2 = rz + rz
        val xx = rx * x2; val xy = rx * y2; val xz = rx * z2
        val yy = ry * y2; val yz = ry * z2; val zz = rz * z2
        val wx = rw * x2; val wy = rw * y2; val wz = rw * z2
        // three stores m[column]; the 3x3 rows for a world->celestial rotation:
        starRotM[0] = (1.0 - (yy + zz)).toFloat(); starRotM[1] = (xy - wz).toFloat(); starRotM[2] = (xz + wy).toFloat()
        starRotM[3] = (xy + wz).toFloat(); starRotM[4] = (1.0 - (xx + zz)).toFloat(); starRotM[5] = (yz - wx).toFloat()
        starRotM[6] = (xz - wy).toFloat(); starRotM[7] = (yz + wx).toFloat(); starRotM[8] = (1.0 - (xx + yy)).toFloat()
    }

    private var envCamAlt = Float.NaN

    // ---------------------------------------------------------------- terrain / noise

    private fun hash2(ix: Int, iz: Int): Float {
        var h = ix * 374761393 + iz * 668265263 + 1442695041
        h = (h xor (h shr 13)) * 1274126177
        h = h xor (h shr 16)
        return (h and 0x7fffffff) / 0x7fffffff.toFloat()
    }

    private fun valueNoise(x: Float, z: Float): Float {
        val ix = kotlin.math.floor(x)
        val iz = kotlin.math.floor(z)
        val fx = x - ix
        val fz = z - iz
        val sx = fx * fx * (3 - 2 * fx)
        val sz = fz * fz * (3 - 2 * fz)
        val a = hash2(ix.toInt(), iz.toInt())
        val b = hash2(ix.toInt() + 1, iz.toInt())
        val c = hash2(ix.toInt(), iz.toInt() + 1)
        val d = hash2(ix.toInt() + 1, iz.toInt() + 1)
        return a * (1 - sx) * (1 - sz) + b * sx * (1 - sz) + c * (1 - sx) * sz + d * sx * sz
    }

    private fun fbm(x: Float, z: Float): Float {
        var v = 0f
        var amp = 0.5f
        var fx = x
        var fz = z
        for (i in 0 until 4) {
            v += valueNoise(fx, fz) * amp
            amp *= 0.5f
            fx *= 2.03f
            fz *= 1.97f
        }
        return v
    }

    private fun roadDistance(x: Float, z: Float): Float {
        // signed distance to the prebuilt road network (negative = on a road)
        var best = Float.MAX_VALUE
        for (s in roadSegs) {
            val dx = s.x1 - s.x0
            val dz = s.z1 - s.z0
            val len2 = dx * dx + dz * dz
            var t = if (len2 > 0f) ((x - s.x0) * dx + (z - s.z0) * dz) / len2 else 0f
            t = t.coerceIn(0f, 1f)
            val px = s.x0 + dx * t - x
            val pz = s.z0 + dz * t - z
            val d = sqrt(px * px + pz * pz) - s.hw
            if (d < best) best = d
        }
        return best
    }

    /** Conform every demo street corridor into the heightmap (the site's road mechanism). */
    private fun conformRoads() {
        for (road in demo.roads) {
            if (road.world.size < 2) continue
            val pts = ArrayList<Heightmap.PathPoint>(road.world.size)
            for (p in road.world) {
                pts.add(Heightmap.PathPoint(p[0], worldHeight.getHeight(p[0], p[1]) + 0.4, p[1]))
            }
            worldHeight.conformPath(pts, (DemoCity.halfWidth(road.type) * 2).toDouble(), 20.0)
        }
    }

    private fun buildRoadNet() {
        roadSegs.clear()
        for (road in demo.roads) {
            val hw = DemoCity.halfWidth(road.type)
            val w = road.world
            for (i in 0 until w.size - 1) {
                roadSegs.add(RoadSeg(w[i][0].toFloat(), w[i][1].toFloat(), w[i + 1][0].toFloat(), w[i + 1][1].toFloat(), hw))
            }
        }
    }

    private fun terrainHeight(x: Float, z: Float): Float = worldHeight.getHeight(x.toDouble(), z.toDouble()).toFloat()

    private fun buildTerrain() {
        val n = 224
        val step = mapHalf * 2f / n
        val data = FloatArray(n * n * 48) // 2 tris x 3 verts x 8 floats per cell
        var o = 0
        for (j in 0 until n) {
            for (i in 0 until n) {
                val x0 = -mapHalf + i * step
                val z0 = -mapHalf + j * step
                val x1 = x0 + step
                val z1 = z0 + step
                // two triangles; the 8-layer splat fragment shader owns the colour now
                // (the CPU terrainColor() approximation was retired with the splat port)
                o = emitQuad(data, o,
                    x0, terrainHeight(x0, z0), z0, x1, terrainHeight(x1, z0), z0,
                    x1, terrainHeight(x1, z1), z1, x0, terrainHeight(x0, z1), z1)
            }
        }
        terrainCount = o / 8
        terrainVbo = upload(data)
    }

    private fun smooth01(v: Float): Float {
        val t = v.coerceIn(0f, 1f)
        return t * t * (3f - 2f * t)
    }

    private fun lerpF(a: Float, b: Float, t: Float): Float = a + (b - a) * t

    private fun emitQuad(data: FloatArray, o0: Int,
                         ax: Float, ay: Float, az: Float, bx: Float, by: Float, bz: Float,
                         cx: Float, cy: Float, cz: Float, dx: Float, dy: Float, dz: Float): Int {
        var o = o0
        val tris = arrayOf(
            floatArrayOf(ax, ay, az, bx, by, bz, cx, cy, cz),
            floatArrayOf(ax, ay, az, cx, cy, cz, dx, dy, dz)
        )
        for (t in tris) {
            for (k in 0 until 3) {
                data[o] = t[k * 3]; data[o + 1] = t[k * 3 + 1]; data[o + 2] = t[k * 3 + 2]
                data[o + 3] = 1f; data[o + 4] = 1f; data[o + 5] = 1f
                data[o + 6] = 1f; data[o + 7] = 0f
                o += 8
            }
        }
        return o
    }

    // ---------------------------------------------------------------- prebuilt city ground

    private fun buildRoadMesh() {
        // every demo street as a conformed ribbon + centre dashes (paths get a lighter tone)
        val quads = ArrayList<Float>(1 shl 17)
        for (road in demo.roads) {
            val hw = DemoCity.halfWidth(road.type)
            val isPath = road.type == "path"
            val cr = if (isPath) 0.46f else 0.115f
            val cg = if (isPath) 0.43f else 0.12f
            val cb = if (isPath) 0.38f else 0.135f
            val w = road.world
            for (i in 0 until w.size - 1) {
                val x0 = w[i][0].toFloat(); val z0 = w[i][1].toFloat()
                val x1 = w[i + 1][0].toFloat(); val z1 = w[i + 1][1].toFloat()
                val dx = x1 - x0; val dz = z1 - z0
                val len = sqrt(dx * dx + dz * dz)
                if (len < 0.5f) continue
                val px = -dz / len * hw
                val pz = dx / len * hw
                val y00 = terrainHeight(x0 - px, z0 - pz) + 0.06f
                val y10 = terrainHeight(x0 + px, z0 + pz) + 0.06f
                val y01 = terrainHeight(x1 - px, z1 - pz) + 0.06f
                val y11 = terrainHeight(x1 + px, z1 + pz) + 0.06f
                quads.addAll(listOf(
                    x0 - px, y00, z0 - pz, cr, cg, cb, 1f, 0f,
                    x0 + px, y10, z0 + pz, cr, cg, cb, 1f, 0f,
                    x1 + px, y11, z1 + pz, cr, cg, cb, 1f, 0f,
                    x0 - px, y00, z0 - pz, cr, cg, cb, 1f, 0f,
                    x1 + px, y11, z1 + pz, cr, cg, cb, 1f, 0f,
                    x1 - px, y01, z1 - pz, cr, cg, cb, 1f, 0f
                ))
            }
            if (!isPath) {
                // centre dashes: 9 m dash / 9 m gap along the polyline
                var stepIdx = 0
                for (i in 0 until w.size - 1) {
                    val x0 = w[i][0].toFloat(); val z0 = w[i][1].toFloat()
                    val x1 = w[i + 1][0].toFloat(); val z1 = w[i + 1][1].toFloat()
                    val dx = x1 - x0; val dz = z1 - z0
                    val len = sqrt(dx * dx + dz * dz)
                    if (len < 0.01f) continue
                    val ux = dx / len; val uz = dz / len
                    var t = 0f
                    while (t < len - 0.01f) {
                        val stepLen = min(9f, len - t)
                        if (stepIdx % 2 == 0) {
                            val ax = x0 + ux * t; val az = z0 + uz * t
                            val bx = ax + ux * stepLen; val bz = az + uz * stepLen
                            val px = -uz * 0.35f; val pz = ux * 0.35f
                            val y00 = terrainHeight(ax - px, az - pz) + 0.075f
                            val y10 = terrainHeight(ax + px, az + pz) + 0.075f
                            val y01 = terrainHeight(bx - px, bz - pz) + 0.075f
                            val y11 = terrainHeight(bx + px, bz + pz) + 0.075f
                            quads.addAll(listOf(
                                ax - px, y00, az - pz, 0.72f, 0.70f, 0.52f, 1f, 0f,
                                ax + px, y10, az + pz, 0.72f, 0.70f, 0.52f, 1f, 0f,
                                bx + px, y11, bz + pz, 0.72f, 0.70f, 0.52f, 1f, 0f,
                                ax - px, y00, az - pz, 0.72f, 0.70f, 0.52f, 1f, 0f,
                                bx + px, y11, bz + pz, 0.72f, 0.70f, 0.52f, 1f, 0f,
                                bx - px, y01, bz - pz, 0.72f, 0.70f, 0.52f, 1f, 0f
                            ))
                        }
                        stepIdx++
                        t += stepLen
                    }
                }
            }
        }
        val arr = FloatArray(quads.size)
        for (i in arr.indices) arr[i] = quads[i]
        cityGroundCount = arr.size / 8
        cityGroundVbo = upload(arr)
    }

    // ---------------------------------------------------------------- city generation

    /** The demo city's preview blocks (web block plan + zoneFor mix) become renderable buildings. */
    private fun loadBuildings() {
        buildings.clear()
        val kindMap = intArrayOf(0, 0, 1, 1, 2, 3, 2) // DemoCity zone id -> renderer palette kind
        for (b in demo.blocks) {
            val gx = ((b.x + cityHalf) / cellSize).toInt().coerceIn(0, gridN - 1)
            val gz = ((b.z + cityHalf) / cellSize).toInt().coerceIn(0, gridN - 1)
            buildings.add(Building(b.x, b.y, b.z, b.w, b.d, b.h, kindMap[b.kind], b.yaw, b.seed, gz * gridN + gx))
        }
    }

    private fun generateVehicles() {
        // the demo street polylines become the site's full lane network (nodes at every meeting
        // and crossing, per-direction lanes, the site's classify() connection rules) — junctions,
        // signals, the conflict matrix and A* routing then come from the bit-exact LaneNetwork port
        val net = Traffic.LaneNetwork()
        net.rebuild(RoadNetBuilder.build(demo.roads))
        trafficNet = net
        val sim = Traffic.TrafficSim(net, 1337, simHashString("traffic"))
        sim.onNetwork()
        sim.spawn(minOf(40, targetVehicleCount() + 6))
        trafficSim = sim
    }

    /** traffic/index.js targetCounts(): byNetwork vs byCity, rush-hour + night curves (density 1). */
    private fun targetVehicleCount(): Int {
        val net = trafficNet ?: return 0
        val laneLen = net.totalLength
        if (laneLen <= 0.0) return 0
        val byNetwork = laneLen / 24.0
        val pop = if (simReady()) simEconomy.e.population else 0
        val jobs = if (simReady()) simEconomy.e.jobs else 0
        val byCity = 70.0 + pop * 0.075 + jobs * 0.050
        val h = hour.toDouble()
        val rush = 0.50 + 0.50 * maxOf(
            exp(-Math.pow((h - 8.2) / 2.8, 2.0)),
            maxOf(exp(-Math.pow((h - 17.6) / 3.6, 2.0)), exp(-Math.pow((h - 12.5) / 3.4, 2.0)) * 0.85),
        )
        val night = if (h < 5.2 || h > 22.6) 0.42 else 1.0
        // native cap: the GLES renderer draws one box body per agent (no instancing yet), so the
        // fleet is capped below the web's ~900 for frame time; the sim formula itself is the web's
        val v = minOf(byNetwork, maxOf(byCity, byNetwork * 0.92)) * rush * night
        return maxOf(0, minOf(MAX_VEHICLES, v.roundToInt()))
    }

    private fun updateVehicles(dt: Float) {
        val sim = trafficSim ?: return
        val t = targetVehicleCount()
        sim.target = t
        val dv = t - sim.vehicles.size
        if (dv > 0) sim.spawn(minOf(26, dv))
        else if (dv < -3) sim.despawnFar(minOf(6, -dv))
        // pedestrian fleet: the web's targetCounts() p-curve, capped for the native renderer
        val p = targetPedCount()
        sim.pedTarget = p
        val dp = p - sim.peds.size
        if (dp > 0) sim.spawnPeds(minOf(34, dp))
        else if (dp < -4) { val kill = minOf(8, -dp); repeat(kill) { if (sim.peds.isNotEmpty()) sim.peds.removeAt(sim.peds.size - 1) } }
        // web passes the camera position; the native camera orbits 300+ m out, so the look-at
        // target is the despawn anchor (vehicles stay alive where the player is actually looking)
        sim.update(min(0.05, dt.toDouble()), camTarget[0].toDouble(), camTarget[2].toDouble())
    }

    /** traffic/index.js targetCounts() pedestrian branch (density 1). */
    private fun targetPedCount(): Int {
        val net = trafficNet ?: return 0
        val pedLen = net.pedTotal
        if (pedLen <= 0.0) return 0
        val byWalk = pedLen / 26.0
        val pop = if (simReady()) simEconomy.e.population else 0
        val h = hour.toDouble()
        val rush = 0.50 + 0.50 * maxOf(
            exp(-Math.pow((h - 8.2) / 2.8, 2.0)),
            maxOf(exp(-Math.pow((h - 17.6) / 3.6, 2.0)), exp(-Math.pow((h - 12.5) / 3.4, 2.0)) * 0.85),
        )
        val night = if (h < 5.2 || h > 22.6) 0.42 else 1.0
        val p = minOf(byWalk, maxOf(45.0 + pop * 0.085, byWalk * 0.80)) * (night * 0.7 + 0.3) * (0.55 + 0.45 * rush)
        return maxOf(0, minOf(MAX_PEDS, Math.round(p).toInt()))
    }

    private fun vehiclePaint(paint: Int, out: FloatArray) {
        val hue = (paint % 1000) / 1000.0
        when {
            hue < 0.22 -> { out[0] = 0.75f; out[1] = 0.16f; out[2] = 0.14f }
            hue < 0.45 -> { out[0] = 0.16f; out[1] = 0.32f; out[2] = 0.62f }
            hue < 0.72 -> { out[0] = 0.88f; out[1] = 0.86f; out[2] = 0.84f }
            hue < 0.88 -> { out[0] = 0.22f; out[1] = 0.22f; out[2] = 0.24f }
            else -> { out[0] = 0.80f; out[1] = 0.55f; out[2] = 0.12f }
        }
    }

    // ---------------------------------------------------------------- simulation bridge

    /** DemoCity zone id -> the web's economic type string (zoneClass semantics; park/landmark excluded). */
    private fun zoneToType(z: Int): String? = when (z) {
        DemoCity.Z_RES_LOW -> "res_low"
        DemoCity.Z_RES_HIGH -> "res_high"
        DemoCity.Z_COM_LOW, DemoCity.Z_COM_HIGH -> "com"
        DemoCity.Z_OFFICE -> "office"
        else -> null
    }

    /** Web ROAD_COST table (economy.js): ¤ per metre per week. */
    private fun roadCostPerMetre(type: String): Double = when (type) {
        "highway" -> 1.01
        "avenue" -> 0.64
        "path" -> 0.07
        else -> 0.30
    }

    private fun initSimulation() {
        simServices = SimServices(mapHalf.toDouble(), mapHalf * 2.0)
        // exactly like simulation/index.js: world.rng.fork(hashString('simulation'))
        val simSeed = com.fablecities.android.worldgen.hash2Signed(1337, simHashString("simulation"))
        simEconomy = SimEconomy(simBuildingList, simServices, Rng(simSeed))
        simMilestones = SimMilestones(simEconomy)
        syncSimBuildings()
        demoRoadCost = 0.0
        for (road in demo.roads) {
            val w = road.world
            for (i in 0 until w.size - 1) {
                val dx = w[i + 1][0] - w[i][0]
                val dz = w[i + 1][1] - w[i][1]
                demoRoadCost += sqrt(dx * dx + dz * dz).toDouble() * roadCostPerMetre(road.type)
            }
        }
        simEconomy.extraRoadCost = demoRoadCost
        simEconomy.trafficCongestion = null // no traffic module yet → roads-segments branch (0 segs → 0)
        pendingMoney?.let { simEconomy.e.money = it.toDouble(); pendingMoney = null }
        simEconomy.recomputeRates()
    }

    /** Restore the persisted budget before the first sim tick (called from the view init). */
    fun setEconMoney(v: Int) {
        if (this::simEconomy.isInitialized) simEconomy.e.money = v.toDouble() else pendingMoney = v
    }

    /** Rebuild the sim's building list from the renderer's world state (called after any edit). */
    private fun syncSimBuildings() {
        simBuildingList.clear()
        for (b in demo.blocks) {
            val t = zoneToType(b.kind) ?: continue // parks / landmarks are not economy buildings (web zoneClass null)
            simBuildingList.add(SimBuilding("demo${simBuildingList.size}", t, b.x.toDouble(), b.z.toDouble(),
                b.w.toDouble(), b.d.toDouble(), b.h.toDouble()))
        }
        for ((idx, kind) in zoneCells) {
            val t = when (kind) {
                0 -> "res_low"; 1 -> "com"; 2 -> "ind"; else -> null
            } ?: continue
            val c = cellCenter(idx)
            simBuildingList.add(SimBuilding("zone$idx", t, c[0].toDouble(), c[1].toDouble(),
                cellSize.toDouble(), cellSize.toDouble(), 9.0))
        }
        simEconomy.buildingsVersion++
    }

    /** Advance the site's simulation: 3 game minutes per real second (World.js secondsPerHour=20). */
    private fun stepSimulation(dt: Float) {
        simMinutesAcc += dt * 3.0
        // per-segment congestion stats (traffic/index.js sim:tick → sim.writeSegmentLoads())
        trafficSim?.writeSegmentLoads()
        var guard = 0
        while (simMinutesAcc >= 1.0 && guard < 240) {
            simMinutesAcc -= 1.0
            guard++
            val ranHour = simEconomy.minute()
            if (ranHour) {
                simEconomy.totalDays = day - 1
                simEconomy.timeDay = day
                simMilestones.tick()
                for (n in simMilestones.notifications) {
                    if (n.second.startsWith("Milestone:")) {
                        listener?.onMessage(n.second + " • reward paid")
                    }
                }
                simMilestones.notifications.clear()
            }
        }
    }

    // economy accessors for the HUD (the HUD draws before the GL surface is ready — guard lateinit)
    private fun simReady(): Boolean = this::simEconomy.isInitialized
    fun econMoney(): Int = if (simReady()) simEconomy.e.money.toInt() else 0
    fun econPopulation(): Int = if (simReady()) simEconomy.e.population else 0
    fun econIncome(): Int = if (simReady()) simEconomy.e.income else 0
    fun econExpenses(): Int = if (simReady()) simEconomy.e.expenses else 0
    fun econMilestone(): String = if (simReady()) simEconomy.e.milestone.name else "Founding"
    fun econHappiness(): Double = if (simReady()) simEconomy.e.happiness else 0.0
    fun econDemandResidential(): Double = if (simReady()) simEconomy.e.demand["residential"] ?: 0.0 else 0.0
    fun econDemandCommercial(): Double = if (simReady()) simEconomy.e.demand["commercial"] ?: 0.0 else 0.0
    fun econDemandIndustrial(): Double = if (simReady()) simEconomy.e.demand["industrial"] ?: 0.0 else 0.0

    // ---------------------------------------------------------------- static meshes

    /** Upload a 2D texture (byte or short payload) with repeat wrap + mipmaps. */
    private fun uploadTex2D(
        w: Int, h: Int, internalFormat: Int, format: Int, type: Int,
        data: java.nio.Buffer?, repeat: Boolean, mipmaps: Boolean
    ): Int {
        val handles = IntArray(1)
        GLES30.glGenTextures(1, handles, 0)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, handles[0])
        GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 1)
        GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, data)
        val wrap = if (repeat) GLES30.GL_REPEAT else GLES30.GL_CLAMP_TO_EDGE
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, wrap)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, wrap)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER,
            if (mipmaps) GLES30.GL_LINEAR_MIPMAP_LINEAR else GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
        if (mipmaps) GLES30.glGenerateMipmap(GLES30.GL_TEXTURE_2D)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, 0)
        return handles[0]
    }

    private fun uploadShortTex(w: Int, h: Int, internalFormat: Int, format: Int, type: Int, data: ShortArray): Int {
        val buf = ByteBuffer.allocateDirect(data.size * 2).order(ByteOrder.nativeOrder()).asShortBuffer()
        buf.put(data).position(0)
        return uploadTex2D(w, h, internalFormat, format, type, buf, false, false)
    }

    /**
     * The site's real water surface (Water.js port):
     *  - geometry: every 128 m chunk whose lowest heightmap sample dips below waterLevel + 0.8,
     *    plus the 4 horizon-ring quads out to half*3 — not one giant plane
     *  - per-pixel depth from an R16F half-float height texture (seamless across the map edge)
     *  - the shore SDF (128 + 4·sd) for the foam lace and the dithered waterline dissolve
     *  - the site's deterministic tileable RGBA noise + 18-wave ripple normal map
     */
    private fun buildWater() {
        val quads = WaterMath.buildWaterQuads(worldHeight, 128, mapHalf * 3.0)
        val nQuads = quads.size / 4
        val data = FloatArray(nQuads * 6 * 8)
        var o = 0
        for (q in 0 until nQuads) {
            val x0 = quads[q * 4 + 0].toFloat(); val z0 = quads[q * 4 + 1].toFloat()
            val x1 = quads[q * 4 + 2].toFloat(); val z1 = quads[q * 4 + 3].toFloat()
            // the web's index order [v, v+2, v+1,  v, v+3, v+2] over (x0,z0)(x1,z0)(x1,z1)(x0,z1)
            val vs = floatArrayOf(x0, waterY, z0, x1, waterY, z1, x1, waterY, z0,  x0, waterY, z0, x0, waterY, z1, x1, waterY, z1)
            for (v in 0 until 6) {
                data[o++] = vs[v * 3 + 0]; data[o++] = vs[v * 3 + 1]; data[o++] = vs[v * 3 + 2]
                data[o++] = 1f; data[o++] = 1f; data[o++] = 1f // unused colour slot
                data[o++] = 0f; data[o++] = 0f                 // unused extra slot
            }
        }
        waterVbo = upload(data)
        waterCount = nQuads * 6

        // R16F height texture (per-pixel water depth, like the web's heightFine)
        val n = worldHeight.N
        val halfData = ShortArray(n * n)
        for (i in 0 until n * n) halfData[i] = WaterMath.toHalfFloat(worldHeight.data[i].toDouble()).toShort()
        texHeight = uploadShortTex(n, n, GLES30.GL_R16F, GLES30.GL_RED, GLES30.GL_HALF_FLOAT, halfData)

        // R8 shore SDF payload (128 + 4·sd, ±32 m at 0.25 m) — the web's shoreTex
        val shore = WaterMath.computeShoreDistance(worldHeight)
        texShore = uploadTex2D(n, n, GLES30.GL_R8, GLES30.GL_RED, GLES30.GL_UNSIGNED_BYTE,
            ByteBuffer.allocateDirect(shore.size).put(shore).position(0), false, false)

        // the site's deterministic procedural textures (bit-exact, pinned by WaterParityTest)
        val noiseData = WaterMath.makeNoiseTexture(256, 1337)
        texNoise = uploadTex2D(256, 256, GLES30.GL_RGBA8, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE,
            ByteBuffer.allocateDirect(noiseData.size).put(noiseData).position(0), true, true)
        val wnData = WaterMath.makeWaterNormalTexture(256, 3)
        texWNormal = uploadTex2D(256, 256, GLES30.GL_RGBA8, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE,
            ByteBuffer.allocateDirect(wnData.size).put(wnData).position(0), true, true)
    }

    /** The site's baked celestial textures (environment/StarField.js, seed 1337): a cube map with
     *  the Milky Way band and the equirect moon albedo map. Individual stars are procedural. */
    private fun buildStars() {
        val faces = Stars.buildStarCubeTexture(1337)
        val handles = IntArray(1)
        GLES30.glGenTextures(1, handles, 0)
        texStars = handles[0]
        GLES30.glBindTexture(GLES30.GL_TEXTURE_CUBE_MAP, texStars)
        GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 1)
        val targets = intArrayOf(
            0x8515, 0x8516, 0x8517, 0x8518, 0x8519, 0x851A) // +X -X +Y -Y +Z -Z
        for (f in 0 until 6) {
            val buf = ByteBuffer.allocateDirect(faces[f].size).put(faces[f]).position(0)
            GLES30.glTexImage2D(targets[f], 0, GLES30.GL_RGBA8, 256, 256, 0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, buf)
        }
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_CUBE_MAP, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_CUBE_MAP, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_CUBE_MAP, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_CUBE_MAP, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_CUBE_MAP, 0)

        val moonData = Stars.buildMoonTexture(1337)
        texMoon = uploadTex2D(512, 256, GLES30.GL_RGBA8, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE,
            ByteBuffer.allocateDirect(moonData.size).put(moonData).position(0), true, true)
    }

    private fun pushBox(data: FloatArray, o0: Int, cx: Float, cy: Float, cz: Float, sx: Float, sy: Float, sz: Float, part: Float): Int {
        // unit cube faces scaled; normals per face; 8 floats per vertex: pos3 normal3 part1 pad1
        var o = o0
        val hx = sx / 2f
        val hy = sy / 2f
        val hz = sz / 2f
        val faces = arrayOf(
            // normal, then 4 corners (two tris)
            floatArrayOf(0f, 0f, 1f, cx - hx, cy - hy, cz + hz, cx + hx, cy - hy, cz + hz, cx + hx, cy + hy, cz + hz, cx - hx, cy + hy, cz + hz),
            floatArrayOf(0f, 0f, -1f, cx + hx, cy - hy, cz - hz, cx - hx, cy - hy, cz - hz, cx - hx, cy + hy, cz - hz, cx + hx, cy + hy, cz - hz),
            floatArrayOf(1f, 0f, 0f, cx + hx, cy - hy, cz + hz, cx + hx, cy - hy, cz - hz, cx + hx, cy + hy, cz - hz, cx + hx, cy + hy, cz + hz),
            floatArrayOf(-1f, 0f, 0f, cx - hx, cy - hy, cz - hz, cx - hx, cy - hy, cz + hz, cx - hx, cy + hy, cz + hz, cx - hx, cy + hy, cz - hz),
            floatArrayOf(0f, 1f, 0f, cx - hx, cy + hy, cz + hz, cx + hx, cy + hy, cz + hz, cx + hx, cy + hy, cz - hz, cx - hx, cy + hy, cz - hz),
            floatArrayOf(0f, -1f, 0f, cx - hx, cy - hy, cz - hz, cx + hx, cy - hy, cz - hz, cx + hx, cy - hy, cz + hz, cx - hx, cy - hy, cz + hz)
        )
        for (f in faces) {
            val idx = intArrayOf(0, 1, 2, 0, 2, 3)
            for (i in idx) {
                data[o] = f[3 + i * 3]; data[o + 1] = f[4 + i * 3]; data[o + 2] = f[5 + i * 3]
                data[o + 3] = f[0]; data[o + 4] = f[1]; data[o + 5] = f[2]
                data[o + 6] = part; data[o + 7] = 0f
                o += 8
            }
        }
        return o
    }

    private fun buildCube() {
        val data = FloatArray(36 * 8)
        pushBox(data, 0, 0f, 0f, 0f, 1f, 1f, 1f, 0f)
        cubeVbo = upload(data)
    }

    private fun buildCar() {
        // body + cabin in one buffer; part 0 = body, 1 = cabin/glass, 2 = wheels strip
        val data = FloatArray(36 * 8 * 2 + 36 * 8)
        var o = 0
        o = pushBox(data, o, 0f, 0.55f, 0f, 4.4f, 1.1f, 1.9f, 0f) // body
        o = pushBox(data, o, -0.25f, 1.32f, 0f, 2.3f, 0.62f, 1.72f, 1f) // cabin
        o = pushBox(data, o, 0f, 0.28f, 0f, 4.5f, 0.36f, 2.0f, 2f) // chassis/wheels hint
        carCount = o / 8
        carVbo = upload(data.copyOf(o))
    }

    private fun buildPed() {
        // two-box pedestrian: torso + head (vehicle-shader vertex layout, part 1 = head tint)
        val data = FloatArray(36 * 8 * 2)
        var o = 0
        o = pushBox(data, o, 0f, 0.55f, 0f, 0.38f, 1.1f, 0.26f, 0f) // torso
        o = pushBox(data, o, 0f, 1.32f, 0f, 0.24f, 0.24f, 0.22f, 1f) // head
        pedCount = o / 8
        pedVbo = upload(data.copyOf(o))
    }

    private fun buildVan() {
        // van (VehicleModels.js: len 5.35, wid 2.02, roof 2.30, cabEnd 0.62): one tall volume,
        // short dropped nose, windscreen band, bumpers
        val data = FloatArray(36 * 8 * 4)
        var o = 0
        o = pushBox(data, o, 0f, 1.32f, -0.15f, 2.02f, 2.30f, 4.7f, 0f) // cargo body
        o = pushBox(data, o, 0f, 1.02f, 2.4f, 1.98f, 1.72f, 1.1f, 0f) // nose
        o = pushBox(data, o, 0f, 1.86f, 2.62f, 1.86f, 0.72f, 0.5f, 1f) // windscreen
        o = pushBox(data, o, 0f, 0.42f, 2.62f, 1.96f, 0.36f, 0.28f, 2f) // front bumper
        vanCount = o / 8
        vanVbo = upload(data.copyOf(o))
    }

    private fun buildTruck() {
        // truck (len 8.6, wid 2.48, cabZ [1.05,4.30] roof 3.05, boxZ [-4.30,0.72] top 3.62)
        val data = FloatArray(36 * 8 * 5)
        var o = 0
        o = pushBox(data, o, 0f, 0.86f, 0.2f, 2.44f, 0.9f, 8.4f, 2f) // chassis
        o = pushBox(data, o, 0f, 2.0f, 2.72f, 2.4f, 2.85f, 3.1f, 0f) // cab
        o = pushBox(data, o, 0f, 2.72f, 3.85f, 2.2f, 0.75f, 0.75f, 1f) // cab glass
        o = pushBox(data, o, 0f, 2.38f, -1.8f, 2.46f, 2.48f, 4.9f, 0f) // cargo box
        o = pushBox(data, o, 0f, 0.5f, 4.25f, 2.2f, 0.4f, 0.3f, 2f) // front bumper
        truckCount = o / 8
        truckVbo = upload(data.copyOf(o))
    }

    private fun buildBus() {
        // bus (len 11.8, wid 2.55, roof 3.12, floor 0.60, windows 1.44..2.42)
        val data = FloatArray(36 * 8 * 5)
        var o = 0
        o = pushBox(data, o, 0f, 1.08f, 0f, 2.55f, 1.56f, 11.6f, 0f) // lower body (floor 0.30..1.86)
        o = pushBox(data, o, 0f, 2.79f, 0f, 2.53f, 0.66f, 11.6f, 0f) // roof
        o = pushBox(data, o, 0f, 1.93f, -0.4f, 2.58f, 0.98f, 9.6f, 1f) // window band
        o = pushBox(data, o, 0f, 1.93f, 5.45f, 2.54f, 0.98f, 0.5f, 1f) // windscreen
        o = pushBox(data, o, 0f, 0.5f, 5.75f, 2.3f, 0.42f, 0.3f, 2f) // front bumper
        busCount = o / 8
        busVbo = upload(data.copyOf(o))
    }

    private fun buildSky() {
        val data = floatArrayOf(-1f, -1f, 0f, 1f, -1f, 0f, 1f, 1f, 0f)
        skyVbo = upload(data)
    }

    // ---------------------------------------------------------------- edits

    fun cellIndexAt(worldX: Float, worldZ: Float): Int {
        val gx = ((worldX + cityHalf) / cellSize).toInt().coerceIn(0, gridN - 1)
        val gz = ((worldZ + cityHalf) / cellSize).toInt().coerceIn(0, gridN - 1)
        return gz * gridN + gx
    }

    private fun cellCenter(idx: Int): FloatArray {
        val gx = idx / gridN
        val gz = idx % gridN
        return floatArrayOf(-cityHalf + gx * cellSize + cellSize / 2f, -cityHalf + gz * cellSize + cellSize / 2f)
    }

    /** @return 1 = placed, -1 = removed, 0 = blocked (prebuilt road) */
    fun toggleRoadCell(idx: Int): Int {
        if (!simReady()) return 0
        val center = cellCenter(idx)
        if (roadDistance(center[0], center[1]) < 1f) return 0
        val removed = roadCells.remove(idx)
        if (!removed) roadCells.add(idx)
        selectedBuilding = null
        rebuildEditMeshes()
        // player roads are local streets: 24 m cell x ¤0.30/m/week (economy.js ROAD_COST.local)
        simEconomy.extraRoadCost = demoRoadCost + roadCells.size * cellSize * 0.30
        editsDirty = true
        return if (removed) -1 else 1
    }

    fun cycleZoneCell(idx: Int): Int {
        if (!simReady()) return -1
        val cur = zoneCells[idx] ?: -1
        selectedBuilding = null
        if (cur >= 2) zoneCells.remove(idx) else zoneCells[idx] = cur + 1
        syncSimBuildings()
        rebuildEditMeshes()
        editsDirty = true
        return zoneCells[idx] ?: -1
    }

    /** The site's 8 service types in SERVICE_IDS order; the SERVICE tool cycles through them. */
    private val serviceOrder = listOf("power", "water", "sewage", "garbage", "police", "fire", "health", "education")
    private var serviceTypeIdx = 0

    fun placeService(idx: Int): String {
        if (!simReady()) return "Still loading — try again in a second"
        val type = serviceOrder[serviceTypeIdx % serviceOrder.size]
        val def = SERVICE_TYPES[type]!!
        val center = cellCenter(idx)
        if (roadDistance(center[0], center[1]) < 1f) return "Too close to a road"
        for (b in buildings) if (!b.removed && b.cell == idx) return "Blocked — pick an empty lot"
        if (simEconomy.e.money < def.cost) {
            serviceTypeIdx = (serviceTypeIdx + 1) % serviceOrder.size // let the player reach an affordable type
            return "Not enough money for the ${def.name} (¤${def.cost})"
        }
        val rng = Random(idx * 31L + 7)
        val y = terrainHeight(center[0], center[1])
        simServices.place(type, center[0].toDouble(), center[1].toDouble(), y.toDouble(), true, doubleArrayOf(0.0))
        simEconomy.e.money -= def.cost // web place(): economy.money -= def.cost (we passed free to skip double-deduction)
        buildings.add(Building(center[0], y, center[1], def.w.toFloat(), def.d.toFloat(), def.height.toFloat(), 3, cityYaw, rng.nextInt(10000), idx))
        val label = def.name
        val next = SERVICE_TYPES[serviceOrder[(serviceTypeIdx + 1) % serviceOrder.size]]!!.name
        serviceTypeIdx = (serviceTypeIdx + 1) % serviceOrder.size
        selectedBuilding = null
        rebuildEditMeshes()
        editsDirty = true
        return "$label built • ¤${def.cost} — next tap: $next"
    }

    /** Remove a service building on `idx` if one is there (bulldoze). */
    private fun removeServiceAt(idx: Int): Boolean {
        val c = cellCenter(idx)
        val hit = simServices.list.firstOrNull { s ->
            kotlin.math.abs(s.x - c[0]) <= s.w / 2 + 2 && kotlin.math.abs(s.z - c[1]) <= s.d / 2 + 2
        } ?: return false
        simServices.remove(hit)
        return true
    }

    private fun rebuildEditMeshes() {
        // roads: cell quad + centre line; zones: tinted translucent quad
        val roads = FloatArray(roadCells.size * 2 * 6 * 8)
        var o = 0
        for (idx in roadCells) {
            val c = cellCenter(idx)
            val x0 = c[0] - cellSize / 2 + 1.5f
            val x1 = c[0] + cellSize / 2 - 1.5f
            val z0 = c[1] - cellSize / 2 + 1.5f
            val z1 = c[1] + cellSize / 2 - 1.5f
            val y = terrainHeight(c[0], c[1]) + 0.05f
            val asphalt = floatArrayOf(0.115f, 0.12f, 0.135f)
            o = putQuad(roads, o, x0, z0, x1, z1, y, asphalt)
            o = putQuad(roads, o, c[0] - 0.3f, z0, c[0] + 0.3f, z1, y + 0.01f, floatArrayOf(0.72f, 0.70f, 0.52f))
        }
        editRoadCount = o / 8
        if (editRoadVbo != 0) GLES30.glDeleteBuffers(1, intArrayOf(editRoadVbo), 0)
        editRoadVbo = upload(roads.copyOf(o))

        val zones = FloatArray(zoneCells.size * 6 * 8)
        o = 0
        for ((idx, kind) in zoneCells) {
            val c = cellCenter(idx)
            val col = when (kind) {
                0 -> floatArrayOf(0.20f, 0.65f, 0.30f)
                1 -> floatArrayOf(0.20f, 0.45f, 0.80f)
                else -> floatArrayOf(0.85f, 0.65f, 0.15f)
            }
            o = putQuad(zones, o, c[0] - cellSize / 2 + 2f, c[1] - cellSize / 2 + 2f,
                c[0] + cellSize / 2 - 2f, c[1] + cellSize / 2 - 2f, terrainHeight(c[0], c[1]) + 0.04f, col)
        }
        editZoneCount = o / 8
        if (editZoneVbo != 0) GLES30.glDeleteBuffers(1, intArrayOf(editZoneVbo), 0)
        editZoneVbo = upload(zones.copyOf(o))
    }

    private fun putQuad(data: FloatArray, o0: Int, x0: Float, z0: Float, x1: Float, z1: Float, y: Float, col: FloatArray): Int {
        var o = o0
        val seq = floatArrayOf(x0, z0, x1, z0, x1, z1, x0, z0, x1, z1, x0, z1)
        for (i in 0 until 6) {
            data[o] = seq[i * 2]; data[o + 1] = y; data[o + 2] = seq[i * 2 + 1]
            data[o + 3] = col[0]; data[o + 4] = col[1]; data[o + 5] = col[2]
            data[o + 6] = 1f; data[o + 7] = 0f
            o += 8
        }
        return o
    }

    // ---------------------------------------------------------------- picking & tools

    private fun rayFromScreen(sx: Float, sy: Float): FloatArray {
        val ndcX = (sx - letterbox[0]) / letterbox[2] * 2f - 1f
        val ndcY = 1f - (sy - letterbox[1]) / letterbox[3] * 2f
        val near = unproject(ndcX, ndcY, -1f)
        val far = unproject(ndcX, ndcY, 1f)
        return floatArrayOf(near[0], near[1], near[2], far[0] - near[0], far[1] - near[1], far[2] - near[2])
    }

    private fun unproject(nx: Float, ny: Float, nz: Float): FloatArray {
        val vIn = floatArrayOf(nx, ny, nz, 1f)
        val vOut = FloatArray(4)
        Matrix.multiplyMV(vOut, 0, invVpM, 0, vIn, 0)
        val w = vOut[3]
        return floatArrayOf(vOut[0] / w, vOut[1] / w, vOut[2] / w)
    }

    private fun groundPoint(ray: FloatArray): FloatArray? {
        // ray-march the real terrain (adaptive step + bisection refine)
        val ox = ray[0]; val oy = ray[1]; val oz = ray[2]
        val dx = ray[3]; val dy = ray[4]; val dz = ray[5]
        if (dy >= 0f && oy > 280f) return null
        var t = 0f
        var prevT = 0f
        var prevDiff = oy - terrainHeight(ox, oz)
        if (prevDiff < 0f) return floatArrayOf(ox, oz)
        while (t < 8000f) {
            t += (prevDiff * 0.6f).coerceIn(8f, 60f)
            val px = ox + dx * t
            val py = oy + dy * t
            val pz = oz + dz * t
            if (abs(px) > mapHalf || abs(pz) > mapHalf) return null
            val diff = py - terrainHeight(px, pz)
            if (diff <= 0f) {
                var a = prevT
                var b = t
                for (k in 0 until 8) {
                    val m = 0.5f * (a + b)
                    val mx = ox + dx * m
                    val mz = oz + dz * m
                    if (oy + dy * m - terrainHeight(mx, mz) > 0f) a = m else b = m
                }
                val tt = 0.5f * (a + b)
                return floatArrayOf(ox + dx * tt, oz + dz * tt)
            }
            prevT = t
            prevDiff = diff
        }
        return null
    }

    private fun buildingAt(ray: FloatArray): Building? {
        var best: Building? = null
        var bestT = Float.MAX_VALUE
        for (b in buildings) {
            if (b.removed) continue
            // yaw-rotated box → conservative axis-aligned bounds for picking
            val c = abs(cos(b.yaw))
            val s2 = abs(sin(b.yaw))
            val ew = b.w / 2f * c + b.d / 2f * s2
            val ed = b.w / 2f * s2 + b.d / 2f * c
            val t = rayBox(ray, b.x, b.y, b.z, ew * 2f, b.h, ed * 2f)
            if (t in 0f..bestT) {
                bestT = t
                best = b
            }
        }
        return best
    }

    private fun rayBox(ray: FloatArray, cx: Float, cy: Float, cz: Float, w: Float, h: Float, d: Float): Float {
        val min = floatArrayOf(cx - w / 2, cy, cz - d / 2)
        val max = floatArrayOf(cx + w / 2, cy + h, cz + d / 2)
        var t0 = 0f
        var t1 = 1e9f
        val ro = floatArrayOf(ray[0], ray[1], ray[2])
        val rd = floatArrayOf(ray[3], ray[4], ray[5])
        for (i in 0..2) {
            if (abs(rd[i]) < 1e-6f) {
                if (ro[i] < min[i] || ro[i] > max[i]) return -1f
            } else {
                var ta = (min[i] - ro[i]) / rd[i]
                var tb = (max[i] - ro[i]) / rd[i]
                if (ta > tb) { val tmp = ta; ta = tb; tb = tmp }
                t0 = max(t0, ta)
                t1 = min(t1, tb)
                if (t0 > t1) return -1f
            }
        }
        return t0
    }

    /** Applies the active tool at the tapped screen position; returns a status message. */
    fun tapTool(sx: Float, sy: Float, tool: String): String {
        if (!simReady()) return "Still loading — try again in a second"
        val ray = rayFromScreen(sx, sy)
        return when (tool) {
            "ROAD" -> {
                val p = groundPoint(ray) ?: return "Aim inside the map"
                when (toggleRoadCell(cellIndexAt(p[0], p[1]))) {
                    1 -> "Road placed"
                    -1 -> "Road removed • +$300 refund"
                    else -> "Blocked by a road"
                }
            }
            "ZONE" -> {
                val p = groundPoint(ray) ?: return "Aim inside the map"
                when (cycleZoneCell(cellIndexAt(p[0], p[1]))) {
                    0 -> "Residential zone painted"
                    1 -> "Commercial zone painted"
                    2 -> "Industrial zone painted"
                    else -> "Zone cleared"
                }
            }
            "SERVICE" -> {
                val p = groundPoint(ray) ?: return "Aim inside the map"
                placeService(cellIndexAt(p[0], p[1]))
            }
            "BULLDOZE" -> {
                val b = buildingAt(ray)
                if (b != null) {
                    b.removed = true
                    removeServiceAt(b.cell)
                    simEconomy.buildingsVersion++
                    selectedBuilding = null
                    editsDirty = true
                    "Demolished"
                } else "Nothing to demolish here"
            }
            else -> {
                val b = buildingAt(ray)
                selectedBuilding = b
                b?.let {
                    val name = when (it.kind) {
                        0 -> "Residences"
                        1 -> "Commercial block"
                        2 -> "Office tower"
                        else -> "City service"
                    }
                    "$name • ${it.h.toInt()} m tall"
                } ?: "No building selected"
            }
        }
    }

    // ---------------------------------------------------------------- camera control

    private var panLast = FloatArray(2)

    fun beginPan(x: Float, y: Float) {
        panLast[0] = x
        panLast[1] = y
    }

    fun updatePan(x: Float, y: Float) {
        val dx = x - panLast[0]
        val dy = y - panLast[1]
        panLast[0] = x
        panLast[1] = y
        val scaleF = camDist * 0.0016f
        val sy = sin(camYaw)
        val cy = cos(camYaw)
        camTargetGoal[0] -= (dx * cy + dy * sy) * scaleF
        camTargetGoal[2] -= (-dx * sy + dy * cy) * scaleF
        camTargetGoal[0] = camTargetGoal[0].coerceIn(-mapHalf, mapHalf)
        camTargetGoal[2] = camTargetGoal[2].coerceIn(-mapHalf, mapHalf)
    }

    fun zoomBy(factor: Float) {
        camDistGoal = (camDistGoal / factor).coerceIn(60f, 900f)
    }

    fun rotateBy(delta: Float) {
        camYawGoal += delta
    }

    fun pitchBy(delta: Float) {
        camPitchGoal = (camPitchGoal + delta).coerceIn(0.35f, 1.45f)
    }

    private fun updateCamera(dt: Float) {
        val k = (dt * 8f).coerceIn(0f, 1f)
        camTarget[0] += (camTargetGoal[0] - camTarget[0]) * k
        camTarget[1] += (camTargetGoal[1] - camTarget[1]) * k
        camTarget[2] += (camTargetGoal[2] - camTarget[2]) * k
        camYaw += (camYawGoal - camYaw) * k
        camPitch += (camPitchGoal - camPitch) * k
        camDist += (camDistGoal - camDist) * k
    }

    fun cameraState(): FloatArray =
        floatArrayOf(camTarget[0], camTarget[1], camTarget[2], camYawGoal, camPitchGoal, camDistGoal, hour)

    fun restoreCamera(state: FloatArray) {
        if (state.size < 7) return
        if (!glReady) {
            pendingCamera = state.copyOf()
            return
        }
        camTargetGoal[0] = state[0]; camTarget[0] = state[0]
        camTargetGoal[1] = state[1]; camTarget[1] = state[1]
        camTargetGoal[2] = state[2]; camTarget[2] = state[2]
        camYawGoal = state[3]; camYaw = state[3]
        camPitchGoal = state[4]; camPitch = state[4]
        camDistGoal = state[5]; camDist = state[5]
        hour = state[6]
    }

    fun setHour(h: Float) {
        hour = h.coerceIn(0f, 23.99f)
    }

    /** environment.api.setWeather(w, false): smooth ~10 s transition like the site's UI switch. */
    fun setWeather(name: String): Boolean = weather.set(name, false)

    fun weatherName(): String = weather.name

    /** Frame-time instrumentation: [avg ms, 99th-percentile ms (the 1% low), fps estimate]. */
    fun frameStats(): FloatArray {
        val sample = frameTimes.copyOf()
        sample.sort()
        var sum = 0f
        for (v in sample) sum += v
        val avg = sum / sample.size
        val p99 = sample[(sample.size * 99) / 100]
        return floatArrayOf(avg, p99, 1000f / avg)
    }

    /** traffic.stats().congestion for the HUD (0..1, the site's global congestion figure). */
    fun trafficCongestion(): Double = trafficSim?.congestion ?: 0.0

    // ---------------------------------------------------------------- persistence

    fun editsState(): String {
        val sb = StringBuilder()
        for (r in roadCells) {
            sb.append('r').append(r).append(';')
        }
        for ((k, v) in zoneCells) {
            sb.append('z').append(k).append(':').append(v).append(';')
        }
        return sb.toString()
    }

    fun restoreEdits(state: String) {
        pendingEdits = state
        if (glReady) applyEdits(state)
    }

    private var pendingEdits: String? = null
    private var pendingCamera: FloatArray? = null

    private fun applyEdits(state: String) {
        roadCells.clear()
        zoneCells.clear()
        for (token in state.split(';')) {
            if (token.isEmpty()) continue
            if (token[0] == 'r') {
                token.substring(1).toIntOrNull()?.let { roadCells.add(it) }
            } else if (token[0] == 'z') {
                val parts = token.substring(1).split(':')
                if (parts.size == 2) {
                    val k = parts[0].toIntOrNull()
                    val v = parts[1].toIntOrNull()
                    if (k != null && v != null) zoneCells[k] = v
                }
            }
        }
        rebuildEditMeshes()
        if (glReady) {
            syncSimBuildings()
            simEconomy.extraRoadCost = demoRoadCost + roadCells.size * cellSize * 0.30
        }
    }

    private var glReady = false

    // ---------------------------------------------------------------- GL helpers & draws

    private fun upload(data: FloatArray): Int {
        val buf = ByteBuffer.allocateDirect(data.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
        buf.put(data).position(0)
        val handles = IntArray(1)
        GLES30.glGenBuffers(1, handles, 0)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, handles[0])
        GLES30.glBufferData(GLES30.GL_ARRAY_BUFFER, buf.capacity() * 4, buf, GLES30.GL_STATIC_DRAW)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
        return handles[0]
    }

    private fun compileShader(type: Int, src: String, label: String): Int {
        val sh = GLES30.glCreateShader(type)
        GLES30.glShaderSource(sh, src)
        GLES30.glCompileShader(sh)
        val ok = IntArray(1)
        GLES30.glGetShaderiv(sh, GLES30.GL_COMPILE_STATUS, ok, 0)
        if (ok[0] == 0) {
            val log = GLES30.glGetShaderInfoLog(sh)
            Log.e(TAG, "shader $label: $log")
            GLES30.glDeleteShader(sh)
            return 0
        }
        return sh
    }

    private fun buildProgram(vsSrc: String, fsSrc: String, label: String): Int {
        val vs = compileShader(GLES30.GL_VERTEX_SHADER, vsSrc, "$label.vs")
        val fs = compileShader(GLES30.GL_FRAGMENT_SHADER, fsSrc, "$label.fs")
        if (vs == 0 || fs == 0) return 0
        val p = GLES30.glCreateProgram()
        GLES30.glAttachShader(p, vs)
        GLES30.glAttachShader(p, fs)
        GLES30.glLinkProgram(p)
        val ok = IntArray(1)
        GLES30.glGetProgramiv(p, GLES30.GL_LINK_STATUS, ok, 0)
        if (ok[0] == 0) {
            Log.e(TAG, "link $label: ${GLES30.glGetProgramInfoLog(p)}")
            return 0
        }
        return p
    }

    private fun bindAttribs(stride: Int) {
        GLES30.glVertexAttribPointer(0, 3, GLES30.GL_FLOAT, false, stride, 0)
        GLES30.glEnableVertexAttribArray(0)
        GLES30.glVertexAttribPointer(1, 3, GLES30.GL_FLOAT, false, stride, 12)
        GLES30.glEnableVertexAttribArray(1)
        GLES30.glVertexAttribPointer(2, 2, GLES30.GL_FLOAT, false, stride, 24)
        GLES30.glEnableVertexAttribArray(2)
    }

    /** Precipitation.js: one seed quad per drop (rx, ry, rz, speed in [0,1)), deterministic. */
    private fun buildPrecipBuffer() {
        if (precipVbo != 0) return
        val seeds = FloatArray(PRECIP_N * 4)
        for (i in 0 until PRECIP_N) {
            var h = i * 374761393 + 1442695041
            h = (h xor (h shr 13)) * 1274126177
            h = h xor (h shr 16)
            val f1 = (h and 0x7fffffff) / 0x7fffffff.toFloat()
            h = (h xor (h shr 13)) * 1274126177
            h = h xor (h shr 16)
            val f2 = (h and 0x7fffffff) / 0x7fffffff.toFloat()
            h = (h xor (h shr 13)) * 1274126177
            h = h xor (h shr 16)
            val f3 = (h and 0x7fffffff) / 0x7fffffff.toFloat()
            h = (h xor (h shr 13)) * 1274126177
            h = h xor (h shr 16)
            val f4 = (h and 0x7fffffff) / 0x7fffffff.toFloat()
            seeds[i * 4] = f1; seeds[i * 4 + 1] = f2; seeds[i * 4 + 2] = f3; seeds[i * 4 + 3] = f4
        }
        val buf = java.nio.ByteBuffer.allocateDirect(seeds.size * 4).order(java.nio.ByteOrder.nativeOrder())
        buf.asFloatBuffer().put(seeds)
        val ids = IntArray(1)
        GLES30.glGenBuffers(1, ids, 0)
        precipVbo = ids[0]
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, precipVbo)
        GLES30.glBufferData(GLES30.GL_ARRAY_BUFFER, seeds.size * 4, buf, GLES30.GL_STATIC_DRAW)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
    }

    /** The site's ray-marched cloud deck (CloudLayer composite): depth-tested against the opaque
     *  pass, premultiplied over-blend, uniforms from the index.js feed. */
    private fun drawClouds(sun: SunState) {
        if (progClouds == 0 || skyVbo == 0) return
        val cover = weather.cloudCover
        val cirrus = weather.state.keys[WeatherPresets.I_CIRRUS]
        if (!(cover > 0.005 || cirrus > 0.005)) return
        // ground shadows drift with the same field (re-baked inside when the threshold is crossed)
        updateCloudShadows(cover.toDouble(), sun.cloudShadowStrength.toDouble())
        GLES30.glEnable(GLES30.GL_BLEND)
        GLES30.glBlendFunc(GLES30.GL_ONE, GLES30.GL_ONE_MINUS_SRC_ALPHA) // premultiplied output
        GLES30.glDepthMask(false)
        GLES30.glDisable(GLES30.GL_CULL_FACE)
        GLES30.glUseProgram(progClouds)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, skyVbo)
        GLES30.glVertexAttribPointer(0, 3, GLES30.GL_FLOAT, false, 12, 0)
        GLES30.glEnableVertexAttribArray(0)
        GLES30.glUniformMatrix4fv(u(progClouds, "uInvVP"), 1, false, invVpM, 0)
        val camX = camTarget[0] + camDist * cos(camPitch) * sin(camYaw)
        val camY = camTarget[1] + camDist * sin(camPitch)
        val camZ = camTarget[2] + camDist * cos(camPitch) * cos(camYaw)
        GLES30.glUniform3f(u(progClouds, "uCamPos"), camX, camY, camZ)
        GLES30.glUniform3f(u(progClouds, "uLightDir"), sun.cloudLightToward[0], sun.cloudLightToward[1], sun.cloudLightToward[2])
        GLES30.glUniform3f(u(progClouds, "uLightColor"), sun.cloudLight[0], sun.cloudLight[1], sun.cloudLight[2])
        GLES30.glUniform3f(u(progClouds, "uAmbientTop"), sun.cloudAmbTop[0], sun.cloudAmbTop[1], sun.cloudAmbTop[2])
        GLES30.glUniform3f(u(progClouds, "uAmbientBottom"), sun.cloudAmbBottom[0], sun.cloudAmbBottom[1], sun.cloudAmbBottom[2])
        GLES30.glUniform3f(u(progClouds, "uAmbientSunSide"), sun.cloudAmbSunSide[0], sun.cloudAmbSunSide[1], sun.cloudAmbSunSide[2])
        GLES30.glUniform3f(u(progClouds, "uHazeColor"), sun.cloudHaze[0], sun.cloudHaze[1], sun.cloudHaze[2])
        GLES30.glUniform1f(u(progClouds, "uHazeDensity"), sun.cloudHazeDensity)
        GLES30.glUniform1f(u(progClouds, "uCoverage"), cover.toFloat())
        GLES30.glUniform1f(u(progClouds, "uCloudType"), weather.state.keys[WeatherPresets.I_TYPE].toFloat())
        GLES30.glUniform1f(u(progClouds, "uDensity"), weather.state.keys[WeatherPresets.I_DENSITY].toFloat())
        GLES30.glUniform1f(u(progClouds, "uPrecip"), weather.precipitation.toFloat())
        GLES30.glUniform1f(u(progClouds, "uCloudBase"), 1000f)
        GLES30.glUniform1f(u(progClouds, "uCloudTop"), 3350f)
        GLES30.glUniform1f(u(progClouds, "uCurvatureRadius"), 2.4e6f)
        // cloud drift: 0.075 m per game-second along the preset wind, wrapped on the 22 km tile
        val gameSeconds = (day * 24.0 + hour) * 3600.0
        val drift = 0.075 * weather.driftWind * gameSeconds
        val tile = 22000.0 * 4
        val wx = weather.state.windX; val wz = weather.state.windZ
        val wrapV = { v: Double -> v - kotlin.math.floor(v / tile) * tile }
        GLES30.glUniform3f(u(progClouds, "uWindOffset"), wrapV(wx * drift).toFloat(), 0f, wrapV(wz * drift).toFloat())
        GLES30.glUniform2f(u(progClouds, "uWindDir"), wx.toFloat(), wz.toFloat())
        GLES30.glUniform1f(u(progClouds, "uTime"), frameNanos / 1_000_000_000f)
        GLES30.glUniform1f(u(progClouds, "uCirrusCover"), cirrus.toFloat())
        GLES30.glUniform1f(u(progClouds, "uCirrusAlt"), 7200f)
        GLES30.glUniform1f(u(progClouds, "uCirrusScale"), 30000f)
        GLES30.glUniform1f(u(progClouds, "uWeatherScale"), 22000f)
        GLES30.glUniform1f(u(progClouds, "uBaseScale"), 5600f)
        GLES30.glUniform1f(u(progClouds, "uDetailScale"), 1050f)
        GLES30.glUniform1f(u(progClouds, "uScatterGain"), sun.cloudScatter)
        GLES30.glUniform1f(u(progClouds, "uBaseJitter"), 0.24f)
        GLES30.glUniform1f(u(progClouds, "uPixelAngle"), 0.0015f)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_3D, texCloudNoise)
        GLES30.glUniform1i(u(progClouds, "uNoise"), 0)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE1)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texCloudWeather)
        GLES30.glUniform1i(u(progClouds, "uWeather"), 1)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE2)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texCloudCirrus)
        GLES30.glUniform1i(u(progClouds, "uCirrus"), 2)
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
        GLES30.glEnable(GLES30.GL_CULL_FACE)
        GLES30.glDepthMask(true)
        GLES30.glDisable(GLES30.GL_BLEND)
    }

    /** Rain / snow particles: camera-following volume, alpha from the weather precipitation. */
    private fun drawPrecipitation(sun: SunState) {
        if (progPrecip == 0 || precipVbo == 0 || sun.precip <= 0.005f) return
        precipTime += 1.0 / 60.0
        GLES30.glEnable(GLES30.GL_BLEND)
        GLES30.glBlendFunc(GLES30.GL_SRC_ALPHA, GLES30.GL_ONE_MINUS_SRC_ALPHA)
        GLES30.glDepthMask(false)
        GLES30.glUseProgram(progPrecip)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, precipVbo)
        GLES30.glVertexAttribPointer(0, 4, GLES30.GL_FLOAT, false, 16, 0)
        GLES30.glEnableVertexAttribArray(0)
        GLES30.glUniformMatrix4fv(u(progPrecip, "uVP"), 1, false, vpM, 0)
        GLES30.glUniform3f(u(progPrecip, "uCenter"), camTarget[0], camTarget[1] + 10f, camTarget[2])
        GLES30.glUniform3f(u(progPrecip, "uVolume"), PRECIP_VOLUME[0], PRECIP_VOLUME[1], PRECIP_VOLUME[2])
        val wind = weather.windStrength.toFloat()
        val wx = weather.state.windX.toFloat() * wind * 2.2f
        val wz = weather.state.windZ.toFloat() * wind * 2.2f
        val snow = sun.precipMode > 0.5f
        val fall = if (snow) 1.3f else 9.2f
        GLES30.glUniform3f(u(progPrecip, "uVel"), wx, -fall, wz)
        GLES30.glUniform1f(u(progPrecip, "uTime"), precipTime.toFloat())
        GLES30.glUniform1f(u(progPrecip, "uMode"), sun.precipMode)
        GLES30.glUniform1f(u(progPrecip, "uSway"), if (snow) 0.9f else 0.0f)
        GLES30.glUniform1f(u(progPrecip, "uSize"), if (snow) 4.2f else 1.8f)
        // lit by the sky (brighter than the dark ground behind a drop), never brighter than day sky
        val tint = if (snow) sun.zenith else floatArrayOf(
            sun.zenith[0] * 0.6f + 0.35f, sun.zenith[1] * 0.6f + 0.38f, sun.zenith[2] * 0.6f + 0.42f)
        GLES30.glUniform3f(u(progPrecip, "uTint"), tint[0], tint[1], tint[2])
        GLES30.glUniform1f(u(progPrecip, "uAlpha"), if (snow) 0.62f * sun.precip else 0.34f * sun.precip)
        GLES30.glDrawArrays(GLES30.GL_POINTS, 0, PRECIP_N)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
        GLES30.glDepthMask(true)
        GLES30.glDisable(GLES30.GL_BLEND)
    }

    private fun drawLit(
        program: Int, vbo: Int, count: Int, sun: SunState, tintR: Float, tintG: Float, tintB: Float,
        puddles: Boolean = false, tracks: Boolean = false
    ) {
        if (program == 0 || vbo == 0) return
        GLES30.glUseProgram(program)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, vbo)
        bindAttribs(32)
        val eye = FloatArray(3)
        camEye(eye)
        GLES30.glUniformMatrix4fv(u(program, "uVP"), 1, false, vpM, 0)
        GLES30.glUniform3f(u(program, "uSunDir"), sun.dir[0], sun.dir[1], sun.dir[2])
        GLES30.glUniform3f(u(program, "uSunColor"), sun.color[0], sun.color[1], sun.color[2])
        GLES30.glUniform3f(u(program, "uAmbient"), sun.ambient[0], sun.ambient[1], sun.ambient[2])
        GLES30.glUniform3f(u(program, "uFogColor"), sun.horizon[0], sun.horizon[1], sun.horizon[2])
        GLES30.glUniform1f(u(program, "uFogDensity"), sun.fogDensity)
        GLES30.glUniform3f(u(program, "uCamPos"), eye[0], eye[1], eye[2])
        GLES30.glUniform3f(u(program, "uTint"), tintR, tintG, tintB)
        // WetSurfaces.js global wet/snow + cloud shadow — these were declared but never fed before
        GLES30.glUniform1f(u(program, "uWetness"), sun.wetness)
        GLES30.glUniform1f(u(program, "uSnow"), sun.snowCover)
        GLES30.glUniform1f(u(program, "uShadowStrength"), sun.cloudShadowStrength)
        GLES30.glUniform3f(u(program, "uLightToward"), sun.cloudLightToward[0], sun.cloudLightToward[1], sun.cloudLightToward[2])
        // the PuddleField.js drainage map: R pool, G ploughed tyre band, B road corridor
        GLES30.glActiveTexture(GLES30.GL_TEXTURE5)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texDrainage)
        GLES30.glUniform1i(u(program, "uFxPoolMap"), 5)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE6)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texCloudShadow)
        GLES30.glUniform1i(u(program, "uCloudShadow"), 6)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glUniform4f(u(program, "uFxPoolXf"), pudDrainXf[0], pudDrainXf[1], pudDrainXf[2], pudDrainXf[3])
        GLES30.glUniform1f(u(program, "uFxTime"), pudTime)
        GLES30.glUniform1f(u(program, "uFxPuddle"), if (puddles) 1f else 0f)
        GLES30.glUniform1f(u(program, "uFxTrack"), if (tracks) 1f else 0f)
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, count)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
    }

    // ---------------------------------------------------------------- terrain splat + puddles ----

    private fun uploadTexArray(size: Int, layers: Int, data: ByteArray): Int {
        val handles = IntArray(1)
        GLES30.glGenTextures(1, handles, 0)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D_ARRAY, handles[0])
        GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 1)
        GLES30.glTexImage3D(GLES30.GL_TEXTURE_2D_ARRAY, 0, GLES30.GL_RGBA8, size, size, layers, 0,
            GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE,
            ByteBuffer.allocateDirect(data.size).put(data).position(0))
        GLES30.glGenerateMipmap(GLES30.GL_TEXTURE_2D_ARRAY)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D_ARRAY, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR_MIPMAP_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D_ARRAY, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D_ARRAY, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_REPEAT)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D_ARRAY, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_REPEAT)
        // anisotropy is worth a lot on grazing ground views; guarded by the extension string
        val ext = GLES30.glGetString(GLES30.GL_EXTENSIONS) ?: ""
        if (ext.contains("texture_filter_anisotropic")) {
            GLES30.glTexParameterf(GLES30.GL_TEXTURE_2D_ARRAY, 0x84FE, 4f) // GL_TEXTURE_MAX_ANISOTROPY_EXT
        }
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D_ARRAY, 0)
        return handles[0]
    }

    /** The site's 8-layer PBR arrays + control/normal maps (terrain/textures.js + terrain/index.js). */
    private fun buildTerrainSplat() {
        val ctx = appContext
        if (ctx != null) {
            try {
                val (alb, nor) = TerrainGfx.loadLayerArrays(ctx.assets)
                texAlbedoArr = uploadTexArray(TerrainGfx.LAYER_SIZE, TerrainGfx.LAYERS.size, alb)
                texNormalArr = uploadTexArray(TerrainGfx.LAYER_SIZE, TerrainGfx.LAYERS.size, nor)
            } catch (e: Exception) {
                Log.e(TAG, "splat layer arrays failed", e)
            }
        } else {
            Log.w(TAG, "no appContext — splat layers unavailable")
        }
        val (ctrl, ctrl2) = TerrainGfx.bakeControlMaps(worldHeight, 1337)
        texControl = uploadTex2D(TerrainGfx.CONTROL_RES, TerrainGfx.CONTROL_RES, GLES30.GL_RGBA8,
            GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE,
            ByteBuffer.allocateDirect(ctrl.size).put(ctrl).position(0), false, false)
        texControl2 = uploadTex2D(TerrainGfx.CONTROL_RES, TerrainGfx.CONTROL_RES, GLES30.GL_RGBA8,
            GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE,
            ByteBuffer.allocateDirect(ctrl2.size).put(ctrl2).position(0), false, false)
        val nrm = TerrainGfx.bakeNormalMap(worldHeight)
        texTNormal = uploadTex2D(worldHeight.N - 1, worldHeight.N - 1, GLES30.GL_RGBA8,
            GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE,
            ByteBuffer.allocateDirect(nrm.size).put(nrm).position(0), true, true)
    }

    /** effects/PuddleField.js: drainage raster + merged feathered pool discs from the demo roads. */
    private fun buildPuddles() {
        val segs = demo.roads.mapIndexed { i, r ->
            PuddleField.SegIn(
                "d$i", r.type, DemoCity.halfWidth(r.type).toDouble() * 2.0,
                DoubleArray(r.world.size * 2) { k ->
                    if (k % 2 == 0) r.world[k / 2][0] else r.world[k / 2][1]
                }
            )
        }
        // the roads are conformed into the heightmap, so the terrain height IS the road bed;
        // pools get LIFT 0.022 over it (web fallback path, +0.05 → just over the +0.06 ribbons)
        val res = PuddleField.build(segs, 1337, null, { x, z -> worldHeight.getHeight(x, z) })
        if (res == null || res.pools.isEmpty()) {
            Log.d(TAG, "puddles: empty field")
            return
        }
        pudVbo = upload(res.verts)
        val idxBuf = ByteBuffer.allocateDirect(res.indices.size * 4).order(ByteOrder.nativeOrder())
        for (v in res.indices) idxBuf.putInt(v)
        idxBuf.position(0)
        val ibo = IntArray(1)
        GLES30.glGenBuffers(1, ibo, 0)
        GLES30.glBindBuffer(GLES30.GL_ELEMENT_ARRAY_BUFFER, ibo[0])
        GLES30.glBufferData(GLES30.GL_ELEMENT_ARRAY_BUFFER, res.indices.size * 4, idxBuf, GLES30.GL_STATIC_DRAW)
        GLES30.glBindBuffer(GLES30.GL_ELEMENT_ARRAY_BUFFER, 0)
        pudIbo = ibo[0]
        pudIdxCount = res.indices.size
        texDrainage = uploadTex2D(res.mapSize, res.mapSize, GLES30.GL_RGBA8,
            GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE,
            ByteBuffer.allocateDirect(res.mapData.size).put(res.mapData).position(0), false, false)
        pudDrainXf[0] = res.mapX0.toFloat()
        pudDrainXf[1] = res.mapZ0.toFloat()
        pudDrainXf[2] = (1.0 / res.mapSpan).toFloat()
        pudDrainXf[3] = 1f
        Log.d(TAG, "puddles: ${res.pools.size} pools, map ${res.mapSize}, ${res.buildMs} ms")
    }

    private fun camEye(out: FloatArray) {
        out[0] = camTarget[0] + camDist * cos(camPitch) * sin(camYaw)
        out[1] = camTarget[1] + camDist * sin(camPitch)
        out[2] = camTarget[2] + camDist * cos(camPitch) * cos(camYaw)
    }

    /** the full 8-layer splat terrain (TerrainMaterial.js port) */
    private fun drawSplat(sun: SunState) {
        if (progTerrain == 0 || terrainVbo == 0) return
        GLES30.glUseProgram(progTerrain)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, terrainVbo)
        bindAttribs(32)
        val eye = FloatArray(3)
        camEye(eye)
        GLES30.glUniformMatrix4fv(u(progTerrain, "uVP"), 1, false, vpM, 0)
        GLES30.glUniform3f(u(progTerrain, "uSunDir"), sun.dir[0], sun.dir[1], sun.dir[2])
        GLES30.glUniform3f(u(progTerrain, "uSunColor"), sun.color[0], sun.color[1], sun.color[2])
        GLES30.glUniform3f(u(progTerrain, "uAmbient"), sun.ambient[0], sun.ambient[1], sun.ambient[2])
        GLES30.glUniform3f(u(progTerrain, "uFogColor"), sun.horizon[0], sun.horizon[1], sun.horizon[2])
        GLES30.glUniform1f(u(progTerrain, "uFogDensity"), sun.fogDensity)
        GLES30.glUniform3f(u(progTerrain, "uCamPos"), eye[0], eye[1], eye[2])
        GLES30.glUniform3f(u(progTerrain, "uTint"), 1f, 1f, 1f)
        GLES30.glUniform1f(u(progTerrain, "uShadowStrength"), sun.cloudShadowStrength)
        GLES30.glUniform3f(u(progTerrain, "uLightToward"), sun.cloudLightToward[0], sun.cloudLightToward[1], sun.cloudLightToward[2])
        GLES30.glUniform1f(u(progTerrain, "uWetness"), sun.wetness)
        GLES30.glUniform1f(u(progTerrain, "uSnow"), sun.snowCover)
        GLES30.glUniform1f(u(progTerrain, "uNight"), sun.nightFactor)
        GLES30.glUniform3f(u(progTerrain, "uMoonDir"), sun.moonDir[0], sun.moonDir[1], sun.moonDir[2])
        GLES30.glUniform1f(u(progTerrain, "uSpacing"), worldHeight.spacing.toFloat())
        GLES30.glUniform1f(u(progTerrain, "uHalf"), mapHalf)
        GLES30.glUniform1f(u(progTerrain, "uSize"), worldHeight.size.toFloat())
        GLES30.glUniform1f(u(progTerrain, "uShoreN"), worldHeight.N.toFloat())
        GLES30.glUniform1f(u(progTerrain, "uWaterLevel"), 0f)
        GLES30.glUniform1f(u(progTerrain, "uSnowLine"), 172f)
        GLES30.glUniform2f(u(progTerrain, "uDetailFade"), 480f, 2200f)
        GLES30.glUniform2f(u(progTerrain, "uNearFade"), 70f, 300f)
        val scales = FloatArray(8)
        for (i in 0 until 8) scales[i] = TerrainGfx.LAYERS[i].second
        GLES30.glUniform1fv(u(progTerrain, "uScales[0]"), 8, scales, 0)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D_ARRAY, texAlbedoArr)
        GLES30.glUniform1i(u(progTerrain, "uAlbedo"), 0)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE1)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D_ARRAY, texNormalArr)
        GLES30.glUniform1i(u(progTerrain, "uNormalArr"), 1)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE2)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texControl)
        GLES30.glUniform1i(u(progTerrain, "uControl"), 2)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE3)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texControl2)
        GLES30.glUniform1i(u(progTerrain, "uControl2"), 3)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE4)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texTNormal)
        GLES30.glUniform1i(u(progTerrain, "uTerrainNormal"), 4)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE5)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texNoise)
        GLES30.glUniform1i(u(progTerrain, "uNoise"), 5)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE6)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texShore)
        GLES30.glUniform1i(u(progTerrain, "uShore"), 6)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE7)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texCloudShadow)
        GLES30.glUniform1i(u(progTerrain, "uCloudShadow"), 7)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, terrainCount)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
    }

    /** effects/PuddleField.js draw: feathered pool discs with wobble + rain rings + sky mirror */
    private fun drawPuddles(sun: SunState) {
        if (progPuddle == 0 || pudVbo == 0 || pudIbo == 0) return
        val wet = ((sun.wetness - 0.12f) / 0.35f).coerceIn(0f, 1f)
        if (wet <= 0.004f) return // pools appear once the ground is properly wet (PuddleField.update)
        val eye = FloatArray(3)
        camEye(eye)
        GLES30.glEnable(GLES30.GL_BLEND)
        GLES30.glBlendFunc(GLES30.GL_SRC_ALPHA, GLES30.GL_ONE_MINUS_SRC_ALPHA)
        GLES30.glDepthMask(false)
        GLES30.glEnable(GLES30.GL_POLYGON_OFFSET_FILL)
        GLES30.glPolygonOffset(-4f, -6f)
        GLES30.glUseProgram(progPuddle)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, pudVbo)
        GLES30.glEnableVertexAttribArray(0)
        GLES30.glVertexAttribPointer(0, 3, GLES30.GL_FLOAT, false, 16, 0)
        GLES30.glEnableVertexAttribArray(1)
        GLES30.glVertexAttribPointer(1, 1, GLES30.GL_FLOAT, false, 16, 12)
        GLES30.glUniformMatrix4fv(u(progPuddle, "uVP"), 1, false, vpM, 0)
        GLES30.glUniform3f(u(progPuddle, "uCamPos"), eye[0], eye[1], eye[2])
        GLES30.glUniform1f(u(progPuddle, "uPudTime"), pudTime)
        GLES30.glUniform1f(u(progPuddle, "uPudRain"), if (sun.precipMode < 0.5f) sun.precip else 0f)
        GLES30.glUniform1f(u(progPuddle, "uPudWet"), wet)
        GLES30.glUniform1f(u(progPuddle, "uPudFade"), (camDist * 0.6f).coerceIn(120f, 420f))
        GLES30.glUniform3f(u(progPuddle, "uAmbient"), sun.ambient[0], sun.ambient[1], sun.ambient[2])
        GLES30.glUniform3f(u(progPuddle, "uSunColor"), sun.color[0], sun.color[1], sun.color[2])
        GLES30.glUniform3f(u(progPuddle, "uSunDir"), sun.dir[0], sun.dir[1], sun.dir[2])
        GLES30.glUniform3f(u(progPuddle, "uFogColor"), sun.horizon[0], sun.horizon[1], sun.horizon[2])
        GLES30.glUniform1f(u(progPuddle, "uFogDensity"), sun.fogDensity)
        GLES30.glBindBuffer(GLES30.GL_ELEMENT_ARRAY_BUFFER, pudIbo)
        GLES30.glDrawElements(GLES30.GL_TRIANGLES, pudIdxCount, GLES30.GL_UNSIGNED_INT, 0)
        GLES30.glBindBuffer(GLES30.GL_ELEMENT_ARRAY_BUFFER, 0)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
        GLES30.glDisable(GLES30.GL_POLYGON_OFFSET_FILL)
        GLES30.glDepthMask(true)
        GLES30.glDisable(GLES30.GL_BLEND)
    }

    private fun drawTerrain(sun: SunState) = drawSplat(sun)
    private fun drawCityGround(sun: SunState) = drawLit(progFlat, cityGroundVbo, cityGroundCount, sun, 1f, 1f, 1f, puddles = true, tracks = true)

    private fun drawEditQuads(sun: SunState) {
        GLES30.glEnable(GLES30.GL_BLEND)
        GLES30.glBlendFunc(GLES30.GL_SRC_ALPHA, GLES30.GL_ONE_MINUS_SRC_ALPHA)
        drawLit(progFlat, editRoadVbo, editRoadCount, sun, 1f, 1f, 1f)
        drawLit(progFlat, editZoneVbo, editZoneCount, sun, 0.55f, 0.55f, 0.55f, puddles = false, tracks = false)
        GLES30.glDisable(GLES30.GL_BLEND)
    }

    private val uniCache = HashMap<Int, HashMap<String, Int>>()

    private fun u(program: Int, name: String): Int {
        var map = uniCache[program]
        if (map == null) {
            map = HashMap()
            uniCache[program] = map
        }
        val cached = map[name]
        if (cached != null) return cached
        val loc = GLES30.glGetUniformLocation(program, name)
        map[name] = loc
        return loc
    }

    private fun drawBuildings(sun: SunState) {
        if (progBuilding == 0 || cubeVbo == 0) return
        GLES30.glUseProgram(progBuilding)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, cubeVbo)
        bindAttribs(32)
        GLES30.glUniformMatrix4fv(u(progBuilding, "uVP"), 1, false, vpM, 0)
        GLES30.glUniform3f(u(progBuilding, "uSunDir"), sun.dir[0], sun.dir[1], sun.dir[2])
        GLES30.glUniform3f(u(progBuilding, "uSunColor"), sun.color[0], sun.color[1], sun.color[2])
        GLES30.glUniform3f(u(progBuilding, "uAmbient"), sun.ambient[0], sun.ambient[1], sun.ambient[2])
        GLES30.glUniform3f(u(progBuilding, "uFogColor"), sun.horizon[0], sun.horizon[1], sun.horizon[2])
        GLES30.glUniform3f(u(progBuilding, "uCamPos"),
            camTarget[0] + camDist * cos(camPitch) * sin(camYaw),
            camTarget[1] + camDist * sin(camPitch),
            camTarget[2] + camDist * cos(camPitch) * cos(camYaw))
        GLES30.glUniform1f(u(progBuilding, "uDayFactor"), sun.dayFactor)
        GLES30.glUniform1f(u(progBuilding, "uFogDensity"), sun.fogDensity)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE4)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texCloudShadow)
        GLES30.glUniform1i(u(progBuilding, "uCloudShadow"), 4)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glUniform1f(u(progBuilding, "uShadowStrength"), sun.cloudShadowStrength)
        GLES30.glUniform3f(u(progBuilding, "uLightToward"), sun.cloudLightToward[0], sun.cloudLightToward[1], sun.cloudLightToward[2])
        for (b in buildings) {
            if (b.removed) continue
            val selected = selectedBuilding === b
            GLES30.glUniform3f(u(progBuilding, "uPos"), b.x, b.y, b.z)
            GLES30.glUniform3f(u(progBuilding, "uScale"), b.w, b.h, b.d)
            GLES30.glUniform1f(u(progBuilding, "uYaw"), b.yaw)
            val pal = when (b.kind) {
                0 -> floatArrayOf(0.74f, 0.62f, 0.50f)
                1 -> floatArrayOf(0.62f, 0.64f, 0.68f)
                2 -> floatArrayOf(0.42f, 0.50f, 0.60f)
                else -> floatArrayOf(0.80f, 0.78f, 0.72f)
            }
            GLES30.glUniform3f(u(progBuilding, "uColor"), pal[0], pal[1], pal[2])
            GLES30.glUniform1f(u(progBuilding, "uSeed"), b.seed.toFloat())
            GLES30.glUniform1f(u(progBuilding, "uKind"), b.kind.toFloat())
            GLES30.glUniform1f(u(progBuilding, "uSelected"), if (selected) 1f else 0f)
            GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 36)
        }
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
    }

    private fun drawVehicles(sun: SunState) {
        if (progBuilding == 0 || carVbo == 0) return
        GLES30.glUseProgram(progBuilding)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, carVbo)
        bindAttribs(32)
        GLES30.glUniformMatrix4fv(u(progBuilding, "uVP"), 1, false, vpM, 0)
        GLES30.glUniform3f(u(progBuilding, "uSunDir"), sun.dir[0], sun.dir[1], sun.dir[2])
        GLES30.glUniform3f(u(progBuilding, "uSunColor"), sun.color[0], sun.color[1], sun.color[2])
        GLES30.glUniform3f(u(progBuilding, "uAmbient"), sun.ambient[0], sun.ambient[1], sun.ambient[2])
        GLES30.glUniform3f(u(progBuilding, "uFogColor"), sun.horizon[0], sun.horizon[1], sun.horizon[2])
        GLES30.glUniform3f(u(progBuilding, "uCamPos"),
            camTarget[0] + camDist * cos(camPitch) * sin(camYaw),
            camTarget[1] + camDist * sin(camPitch),
            camTarget[2] + camDist * cos(camPitch) * cos(camYaw))
        GLES30.glUniform1f(u(progBuilding, "uDayFactor"), sun.dayFactor)
        GLES30.glUniform1f(u(progBuilding, "uFogDensity"), sun.fogDensity)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE4)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texCloudShadow)
        GLES30.glUniform1i(u(progBuilding, "uCloudShadow"), 4)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glUniform1f(u(progBuilding, "uShadowStrength"), sun.cloudShadowStrength)
        GLES30.glUniform3f(u(progBuilding, "uLightToward"), sun.cloudLightToward[0], sun.cloudLightToward[1], sun.cloudLightToward[2])
        GLES30.glUniform1f(u(progBuilding, "uSelected"), 0f)
        GLES30.glUniform1f(u(progBuilding, "uKind"), 9f) // vehicle mode
        val sim = trafficSim
        if (sim != null) {
            val hueF = FloatArray(3)
            var lastVbo = carVbo
            for (v in sim.vehicles) {
                // per-kind mesh (VehicleModels.js profiles): cars get the 3-box shell scaled by
                // the spec, van/truck/bus have their own absolute-dims compositions
                val spec = v.spec
                val vbo: Int
                val count: Int
                var sx = 1f
                var sy = 1f
                var sz = 1f
                when (spec.kind) {
                    "truck" -> { vbo = truckVbo; count = truckCount }
                    "bus" -> { vbo = busVbo; count = busCount }
                    "box" -> { vbo = vanVbo; count = vanCount }
                    else -> {
                        vbo = carVbo; count = carCount
                        sx = (spec.len / 4.62).toFloat()
                        sy = (if (spec.id == "suv") 1.22f else if (spec.id == "hatchback") 1.03f else 1f)
                        sz = (spec.wid / 1.9).toFloat()
                    }
                }
                if (vbo == 0) continue
                // deterministic paint from the sim's per-vehicle paint int (web palette spirit)
                vehiclePaint(v.paint, hueF)
                GLES30.glUniform3f(u(progBuilding, "uPos"), v.x.toFloat(), terrainHeight(v.x.toFloat(), v.z.toFloat()) + 0.05f, v.z.toFloat())
                GLES30.glUniform3f(u(progBuilding, "uScale"), sx * v.sl.toFloat(), sy, sz * v.sw.toFloat())
                GLES30.glUniform1f(u(progBuilding, "uYaw"), v.yaw.toFloat())
                GLES30.glUniform3f(u(progBuilding, "uColor"), hueF[0], hueF[1], hueF[2])
                GLES30.glUniform1f(u(progBuilding, "uSeed"), v.seed.toFloat())
                if (lastVbo != vbo) {
                    GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, vbo)
                    bindAttribs(32)
                    lastVbo = vbo
                }
                GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, count)
            }
            // pedestrians: the sim's sidewalk agents (spawnPeds/_stepPed port) as two-box walkers
            if (pedVbo != 0) {
                GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, pedVbo)
                bindAttribs(32)
                for (p in sim.peds) {
                    val hue = (p.shirt % 1000) / 1000.0
                    when {
                        hue < 0.25 -> { hueF[0] = 0.72f; hueF[1] = 0.20f; hueF[2] = 0.18f }
                        hue < 0.5 -> { hueF[0] = 0.22f; hueF[1] = 0.36f; hueF[2] = 0.60f }
                        hue < 0.75 -> { hueF[0] = 0.85f; hueF[1] = 0.83f; hueF[2] = 0.78f }
                        else -> { hueF[0] = 0.30f; hueF[1] = 0.28f; hueF[2] = 0.26f }
                    }
                    GLES30.glUniform3f(u(progBuilding, "uPos"), p.x.toFloat(), terrainHeight(p.x.toFloat(), p.z.toFloat()) + 0.05f, p.z.toFloat())
                    GLES30.glUniform3f(u(progBuilding, "uScale"), 1f, 1f, 1f)
                    GLES30.glUniform1f(u(progBuilding, "uYaw"), p.yaw.toFloat())
                    GLES30.glUniform3f(u(progBuilding, "uColor"), hueF[0], hueF[1], hueF[2])
                    GLES30.glUniform1f(u(progBuilding, "uSeed"), p.seed.toFloat())
                    GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, pedCount)
                }
            }
        }
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
    }

    private fun drawWater(sun: SunState) {
        if (progWater == 0 || waterVbo == 0) return
        GLES30.glEnable(GLES30.GL_BLEND)
        GLES30.glBlendFunc(GLES30.GL_SRC_ALPHA, GLES30.GL_ONE_MINUS_SRC_ALPHA)
        GLES30.glDepthMask(false) // the web's depthWrite: false — water never occludes itself
        GLES30.glUseProgram(progWater)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, waterVbo)
        bindAttribs(32)
        val camX = camTarget[0] + camDist * cos(camPitch) * sin(camYaw)
        val camY = camTarget[1] + camDist * sin(camPitch)
        val camZ = camTarget[2] + camDist * cos(camPitch) * cos(camYaw)
        GLES30.glUniformMatrix4fv(u(progWater, "uVP"), 1, false, vpM, 0)
        GLES30.glUniform3f(u(progWater, "uCamPos"), camX, camY, camZ)
        GLES30.glUniform1f(u(progWater, "uTime"), frameNanos / 1_000_000_000f)
        GLES30.glUniform1f(u(progWater, "uHalf"), mapHalf)
        GLES30.glUniform1f(u(progWater, "uSpacing"), worldHeight.spacing.toFloat())
        GLES30.glUniform1f(u(progWater, "uHeightN"), worldHeight.N.toFloat())
        GLES30.glUniform1f(u(progWater, "uShoreN"), worldHeight.N.toFloat())
        GLES30.glUniform1f(u(progWater, "uWaterLevel"), waterY)
        GLES30.glUniformMatrix4fv(u(progWater, "uReflTex"), 1, false, reflTexM, 0)
        GLES30.glUniform1f(u(progWater, "uReflectionStrength"), sun.reflectionStrength)
        GLES30.glUniform3f(u(progWater, "uZenith"), sun.zenith[0], sun.zenith[1], sun.zenith[2])
        GLES30.glUniform3f(u(progWater, "uHorizon"), sun.horizon[0], sun.horizon[1], sun.horizon[2])
        GLES30.glUniform3f(u(progWater, "uGlow"), sun.glow[0], sun.glow[1], sun.glow[2])
        GLES30.glUniform3f(u(progWater, "uFogColor"), sun.fog[0], sun.fog[1], sun.fog[2])
        GLES30.glUniform3f(u(progWater, "uSunDir"), sun.skySun[0], sun.skySun[1], sun.skySun[2])
        GLES30.glUniform3f(u(progWater, "uSunColor"), sun.waterSun[0], sun.waterSun[1], sun.waterSun[2])
        GLES30.glUniform3f(u(progWater, "uMoonDir"), sun.moonDir[0], sun.moonDir[1], sun.moonDir[2])
        GLES30.glUniform3f(u(progWater, "uMoonColor"), sun.waterMoon[0], sun.waterMoon[1], sun.waterMoon[2])
        GLES30.glUniform3f(u(progWater, "uSkyColor"), sun.skyColor[0], sun.skyColor[1], sun.skyColor[2])
        GLES30.glUniform1f(u(progWater, "uAmbient"), sun.hemiRaw.toFloat())
        GLES30.glUniform1f(u(progWater, "uNightFactor"), sun.nightFactor)
        GLES30.glUniform3f(u(progWater, "uSkyFloor"), sun.waterFloor[0], sun.waterFloor[1], sun.waterFloor[2])
        GLES30.glUniform3f(u(progWater, "uNightSheen"), sun.waterSheen[0], sun.waterSheen[1], sun.waterSheen[2])
        GLES30.glUniform2f(u(progWater, "uWind"), weather.state.windX.toFloat(), weather.state.windZ.toFloat())
        GLES30.glUniform1f(u(progWater, "uRain"), weather.precipitation.toFloat()) // rain dimples + roughness
        GLES30.glUniform1f(u(progWater, "uFogDensity"), sun.fogDensity)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE4)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, reflTex)
        GLES30.glUniform1i(u(progWater, "uReflection"), 4)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texHeight)
        GLES30.glUniform1i(u(progWater, "uHeightTex"), 0)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE1)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texShore)
        GLES30.glUniform1i(u(progWater, "uShore"), 1)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE2)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texWNormal)
        GLES30.glUniform1i(u(progWater, "uNormalTex"), 2)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE3)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texNoise)
        GLES30.glUniform1i(u(progWater, "uNoise"), 3)
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, waterCount)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
        GLES30.glDepthMask(true)
        GLES30.glDisable(GLES30.GL_BLEND)
    }

    private fun drawSky(sun: SunState) {
        if (progSky == 0 || skyVbo == 0) return
        GLES30.glDisable(GLES30.GL_CULL_FACE)
        GLES30.glDisable(GLES30.GL_DEPTH_TEST)
        GLES30.glUseProgram(progSky)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, skyVbo)
        GLES30.glVertexAttribPointer(0, 3, GLES30.GL_FLOAT, false, 12, 0)
        GLES30.glEnableVertexAttribArray(0)
        GLES30.glUniformMatrix4fv(u(progSky, "uInvVP"), 1, false, invVpM, 0)
        GLES30.glUniform3f(u(progSky, "uZenith"), sun.zenith[0], sun.zenith[1], sun.zenith[2])
        GLES30.glUniform3f(u(progSky, "uHorizon"), sun.horizon[0], sun.horizon[1], sun.horizon[2])
        GLES30.glUniform3f(u(progSky, "uSunDir"), sun.skySun[0], sun.skySun[1], sun.skySun[2])
        GLES30.glUniform3f(u(progSky, "uSunColor"), sun.glow[0], sun.glow[1], sun.glow[2])
        GLES30.glUniform3f(u(progSky, "uCamPos"),
            camTarget[0] + camDist * cos(camPitch) * sin(camYaw),
            camTarget[1] + camDist * sin(camPitch),
            camTarget[2] + camDist * cos(camPitch) * cos(camYaw))
        GLES30.glUniform1f(u(progSky, "uDayFactor"), sun.dayFactor)
        // stars / Milky Way / moon / sun disc (environment shaders.js)
        GLES30.glUniformMatrix3fv(u(progSky, "uStarRot"), 1, false, starRotM, 0)
        GLES30.glUniform1f(u(progSky, "uStarIntensity"), sun.starIntensity)
        GLES30.glUniform1f(u(progSky, "uStarSeed"), sun.starSeed)
        GLES30.glUniform1f(u(progSky, "uMilkyWay"), sun.milkyWay)
        GLES30.glUniform1f(u(progSky, "uStarFade"), sun.starFade)
        GLES30.glUniform1f(u(progSky, "uSkyFog"), sun.skyFog)
        GLES30.glUniform4f(u(progSky, "uFogSun"), sun.skySun[0], sun.skySun[1], sun.skySun[2], sun.fogSunGlow)
        GLES30.glUniform3f(u(progSky, "uFogColSky"), sun.fogSkyCol[0], sun.fogSkyCol[1], sun.fogSkyCol[2])
        GLES30.glUniform1f(u(progSky, "uNightKey"), sun.nightKey)
        GLES30.glUniform1f(u(progSky, "uTime"), frameNanos / 1_000_000_000f)
        GLES30.glUniform3f(u(progSky, "uMoonDir"), sun.moonDir[0], sun.moonDir[1], sun.moonDir[2])
        GLES30.glUniform1f(u(progSky, "uMoonBright"), sun.moonBright)
        GLES30.glUniform1f(u(progSky, "uMoonRadius"), Stars.MOON_ANGULAR_RADIUS.toFloat())
        GLES30.glUniform1f(u(progSky, "uSunRadius"), Stars.SUN_ANGULAR_RADIUS.toFloat())
        GLES30.glUniform1f(u(progSky, "uSunDisc"), sun.sunDisc)
        GLES30.glUniform3f(u(progSky, "uSunTint"), sun.sunTint[0], sun.sunTint[1], sun.sunTint[2])
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glBindTexture(0x8513, texStars) // GL_TEXTURE_CUBE_MAP
        GLES30.glUniform1i(u(progSky, "uStars"), 0)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE1)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texMoon)
        GLES30.glUniform1i(u(progSky, "uMoonTex"), 1)
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
        GLES30.glEnable(GLES30.GL_DEPTH_TEST)
        GLES30.glEnable(GLES30.GL_CULL_FACE)
    }

    fun markReady() {
        glReady = true
    }

    companion object {
        private const val TAG = "GlCityRenderer"
    }

    // ---------------------------------------------------------------- shaders

    private val VS_LIT = """
        #version 300 es
        layout(location=0) in vec3 aPos;
        layout(location=1) in vec3 aColor;
        layout(location=2) in vec2 aExtra;
        uniform mat4 uVP;
        uniform mat4 uReflTex;
        out vec3 vColor;
        out vec3 vWorld;
        out vec4 vReflUv;
        void main() {
            vColor = aColor;
            vWorld = aPos;
            vReflUv = uReflTex * vec4(aPos, 1.0);
            gl_Position = uVP * vec4(aPos, 1.0);
        }
    """.trimIndent()

    private val FS_LIT = """
        #version 300 es
        precision highp float;
        in vec3 vColor;
        in vec3 vWorld;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uAmbient;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uWetness;
        uniform float uSnow;
        uniform vec3 uCamPos;
        uniform vec3 uTint;
        uniform sampler2D uCloudShadow;
        uniform float uShadowStrength;
        uniform vec3 uLightToward;
        out vec4 fragColor;
        void main() {
            float ndl = max(dot(normalize(vec3(0.0, 1.0, 0.0)), uSunDir), 0.0);
            // cloud shadow (CloudShadowMap projected along the light onto the cloud base)
            float cs = 1.0;
            if (uShadowStrength > 0.001) {
                float t = (1000.0 - vWorld.y) / max(uLightToward.y, 0.05);
                cs = texture(uCloudShadow, (vWorld.xz + uLightToward.xz * t) / 22000.0).r;
            }
            vec3 col = vColor * uTint * (uAmbient + uSunColor * ndl * cs);
            // snow accumulation (WetSurfaces/snow hooks): ground whitens as the deck settles
            col = mix(col, vec3(0.82, 0.85, 0.90) * (uAmbient + uSunColor * ndl) * 1.35, uSnow * 0.72);
            // wet surfaces: albedo darkens and gets a sky sheen (the web's uWetness material hook)
            col *= 1.0 - 0.38 * uWetness;
            col += uAmbient * uWetness * 0.22;
            float d = length(uCamPos - vWorld);
            float fog = 1.0 - exp(-d * uFogDensity);
            fragColor = vec4(mix(col, uFogColor, fog), 1.0);
        }
    """.trimIndent()

    private val VS_BUILDING = """
        #version 300 es
        layout(location=0) in vec3 aPos;
        layout(location=1) in vec3 aNormal;
        layout(location=2) in vec2 aExtra;
        uniform mat4 uVP;
        uniform vec3 uPos;
        uniform vec3 uScale;
        uniform float uYaw;
        out vec3 vNormal;
        out vec3 vLocal;
        out vec3 vWorld;
        out float vPart;
        void main() {
            float c = cos(uYaw);
            float s = sin(uYaw);
            vec3 scaled = aPos * uScale;
            vLocal = aPos;
            vPart = aExtra.x;
            vNormal = normalize(vec3(aNormal.x * c - aNormal.z * s, aNormal.y, aNormal.x * s + aNormal.z * c));
            vWorld = uPos + vec3(scaled.x * c - scaled.z * s, scaled.y, scaled.x * s + scaled.z * c);
            gl_Position = uVP * vec4(vWorld, 1.0);
        }
    """.trimIndent()

    private val FS_BUILDING = """
        #version 300 es
        precision highp float;
        in vec3 vNormal;
        in vec3 vLocal;
        in vec3 vWorld;
        in float vPart;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uAmbient;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform sampler2D uCloudShadow;
        uniform float uShadowStrength;
        uniform vec3 uLightToward;
        uniform vec3 uCamPos;
        uniform vec3 uColor;
        uniform vec3 uScale;
        uniform float uDayFactor;
        uniform float uSeed;
        uniform float uKind;
        uniform float uSelected;
        out vec4 fragColor;

        float hash(vec2 p) {
            return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed) * 43758.5453);
        }

        void main() {
            vec3 n = normalize(vNormal);
            float ndl = max(dot(n, uSunDir), 0.0);
            // cloud shadow (the same projection the ground uses)
            float csB = 1.0;
            if (uShadowStrength > 0.001) {
                float tB = (1000.0 - vWorld.y) / max(uLightToward.y, 0.05);
                csB = texture(uCloudShadow, (vWorld.xz + uLightToward.xz * tB) / 22000.0).r;
            }
            float hemi = 0.5 + 0.5 * n.y;
            float d = length(uCamPos - vWorld);
            float fog = 1.0 - exp(-d * uFogDensity);
            vec3 colOut;
            if (uKind < 8.5) {
                // buildings: window grid on side faces
                vec3 col = uColor * (uAmbient * hemi + uSunColor * ndl * 0.9 * csB);
                bool side = abs(n.y) < 0.5;
                if (side) {
                    float u = abs(n.x) > 0.5 ? vLocal.z : vLocal.x;
                    float v = vLocal.y;
                    float rows = max(2.0, floor(uScale.y / 5.0));
                    vec2 grid = vec2(u, v) * vec2(6.0, rows);
                    vec2 cell = floor(grid);
                    vec2 f = fract(grid);
                    bool win = f.x > 0.22 && f.x < 0.78 && f.y > 0.25 && f.y < 0.80;
                    float litRand = hash(cell);
                    float litFraction = mix(0.72, 0.10, uDayFactor);
                    bool lit = win && litRand < litFraction;
                    if (win) {
                        vec3 glass = uColor * 0.32 + vec3(0.03, 0.05, 0.09);
                        vec3 warm = vec3(1.0, 0.72, 0.38) * (1.6 + 0.9 * hash(cell + 7.0));
                        col = lit ? warm : glass * (uAmbient * 1.4 + uSunColor * ndl * csB);
                    } else {
                        col *= 0.92; // mullions slightly darker
                    }
                }
                if (n.y > 0.5) col = uColor * 0.55 * (uAmbient + uSunColor * ndl * csB);
                colOut = col;
                if (uSelected > 0.5) colOut = mix(colOut, vec3(0.35, 0.85, 1.0), 0.45);
            } else {
                // vehicles: vPart 0 = body (uColor), 1 = cabin glass, 2 = chassis
                vec3 partCol = uColor;
                if (vPart > 1.5) partCol = vec3(0.06, 0.06, 0.07);
                else if (vPart > 0.5) partCol = vec3(0.10, 0.13, 0.18);
                colOut = partCol * (uAmbient * hemi + uSunColor * ndl * 1.15);
                if (vPart > 0.5 && vPart < 1.5) {
                    float spec = pow(max(dot(normalize(uSunDir + normalize(uCamPos - vWorld)), n), 0.0), 60.0);
                    colOut += uSunColor * spec * 0.35;
                }
            }
            fragColor = vec4(mix(colOut, uFogColor, fog), 1.0);
        }
    """.trimIndent()

    private val VS_WATER = VS_LIT

    // The site's water (Water.js port, display-referred): a PBR dielectric at roughness 0.04 /
    // ior 1.333 — the body is a dark teal→navy absorption ramp driven by per-pixel depth from the
    // R16F height texture, and everything bright on the surface is REFLECTED SKY, not paint.
    // Five ripple octaves from the site's own 18-wave normal map (150 m swell → 2.4 m chop; the
    // 23/61 m layers never fade), a sharp-normal GGX glitter lobe for the sun AND the real moon,
    // a narrow noise-broken foam lace driven by the shore SDF, and a dithered waterline dissolve.
    private val FS_WATER = """
        #version 300 es
        precision highp float;
        in vec3 vColor;
        in vec3 vWorld;
        in vec4 vReflUv;
        uniform vec3 uCamPos;
        uniform float uTime;
        uniform float uHalf;
        uniform float uSpacing;
        uniform float uHeightN;
        uniform float uShoreN;
        uniform float uWaterLevel;
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uGlow;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform sampler2D uReflection;
        uniform float uReflectionStrength;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;    // sun colour x intensity, display-referred
        uniform vec3 uMoonDir;
        uniform vec3 uMoonColor;   // moon colour x intensity, display-referred
        uniform vec3 uSkyColor;    // env.skyColor, display-referred (sky floor / night sheen)
        uniform float uAmbient;    // env.ambientIntensity (raw, unitless)
        uniform float uNightFactor;
        uniform vec3 uSkyFloor;    // display-referred (computed on the CPU like the web update())
        uniform vec3 uNightSheen;
        uniform vec2 uWind;
        uniform float uRain;
        uniform sampler2D uHeightTex;
        uniform sampler2D uShore;
        uniform sampler2D uNormalTex;
        uniform sampler2D uNoise;
        out vec4 fragColor;
        const float PI = 3.141592653589793;
        const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
        const mat2 R37 = mat2(0.7986, -0.6018, 0.6018, 0.7986);

        float waterTerrainHeight(vec2 xz) {
            // uv = ((xz + half) / spacing + 0.5) / N — texel centres on grid samples (the web's map)
            vec2 uv = ((xz + uHalf) / uSpacing + 0.5) / uHeightN;
            return texture(uHeightTex, uv).r;
        }
        vec3 waterNrm(vec2 uv, float bias) { return texture(uNormalTex, uv, bias).xyz * 2.0 - 1.0; }

        // analytic stand-in for the PMREM sky probe: the site's own sky gradient along the
        // reflected ray, with the sky-dome sun glow (no hard disc — the glitter lobe owns that)
        vec3 skyProbe(vec3 dir) {
            float t = clamp(dir.y * 1.4 + 0.12, 0.0, 1.0);
            vec3 col = mix(uHorizon, uZenith, pow(t, 0.75));
            float s = max(dot(dir, uSunDir), 0.0);
            col += uGlow * (pow(s, 24.0) * 0.28 + pow(s, 5.0) * 0.10);
            return col;
        }

        void main() {
            vec3 Vw = normalize(uCamPos - vWorld);
            float dist = length(uCamPos - vWorld);
            float h = waterTerrainHeight(vWorld.xz);
            float depth = max(uWaterLevel - h, 0.0);
            // metres from the waterline: in-map from the shore SDF texture, outside from the depth
            float toShore;
            if (max(abs(vWorld.x), abs(vWorld.z)) <= uHalf) {
                vec2 uvS = ((vWorld.xz + uHalf) / uSpacing + 0.5) / uShoreN;
                toShore = max(-(texture(uShore, uvS).r * 255.0 - 128.0) * 0.25, 0.0);
            } else toShore = depth * 6.0;

            // --- animated ripple normals: five octaves; the smallest fade with distance so the far
            //     water calms, but the 23 m / 61 m layers stay on out to the horizon
            vec2 wdir = normalize(uWind + vec2(0.0001));
            vec2 perp = vec2(-wdir.y, wdir.x);
            float t = uTime;
            float bias = 1.35 * smoothstep(150.0, 1100.0, dist);
            vec3 nS = waterNrm((R37 * vWorld.xz) / 150.0 + wdir * t * 0.005, bias);
            vec3 n0 = waterNrm((R37 * vWorld.xz) / 61.0 + wdir * t * 0.010, bias);
            vec3 n1 = waterNrm(vWorld.xz / 23.0 + wdir * t * 0.020 + perp * t * 0.004, bias);
            vec3 n2 = waterNrm((R37 * vWorld.xz) / 7.5 - wdir * t * 0.035 + perp * t * 0.011 + 0.37, bias);
            vec3 n3 = waterNrm(vWorld.xz / 2.4 + wdir * t * 0.055 + 0.71, bias);
            float detailFade = 1.0 - smoothstep(50.0, 520.0, dist);
            float midFade = 1.0 - smoothstep(180.0, 1800.0, dist);
            float farFade = 1.0 - smoothstep(400.0, 3000.0, dist);
            float calm = 0.45 + 0.55 * smoothstep(0.0, 2.5, toShore);   // the shallows are calmer
            vec2 nxy = (nS.xy * 0.15
                      + n0.xy * (0.10 + 0.13 * farFade)
                      + n1.xy * (0.07 + 0.16 * midFade)
                      + n2.xy * (0.03 + 0.13 * detailFade)
                      + n3.xy * 0.09 * detailFade) * (0.60 + 0.40 * calm) * (0.20 + 0.26 * uRain);
            vec3 gWN = normalize(vec3(nxy.x, 1.0, nxy.y));
            // a second, sharper normal for the sun glitter (the sun path as thousands of sparks)
            vec2 gxy = nxy + (n3.xy * 0.30 + n2.xy * 0.22) * detailFade + n1.xy * 0.09 * midFade;
            vec3 Ng = normalize(vec3(gxy.x, 1.0, gxy.y));

            // --- body: absorption. Shallow = dark teal, deep = navy (multipliers on 0x13282f)
            float cosT = max(dot(gWN, Vw), 0.0);
            float absorb = 1.0 - exp(-depth * 0.62);
            vec3 shallow = vec3(1.90, 1.45, 1.05);
            vec3 deep = vec3(0.42, 0.62, 0.98);
            vec3 diffuse = vec3(0.0745, 0.1569, 0.1843) * mix(shallow, deep, absorb);
            // river bed shows through the first metre (sand / mud)
            diffuse = mix(diffuse, vec3(0.058, 0.052, 0.040), exp(-depth * 2.4) * 0.45);
            diffuse = mix(diffuse, vec3(dot(diffuse, LUM)), 0.30);

            // --- shoreline: a narrow (<= 1.6 m) noise-broken foam lace + rare whitecaps
            vec2 fuv = vWorld.xz / 9.0;
            float fN = texture(uNoise, fuv + wdir * t * 0.04).a * 0.55 + texture(uNoise, fuv * 2.7 - wdir * t * 0.07 + 0.3).b * 0.45;
            float band = 1.0 - smoothstep(0.12, 1.30, toShore);
            float swell = 0.5 + 0.5 * sin(t * 1.1 - toShore * 1.6 + fN * 4.0 + vWorld.x * 0.05);
            float foam = band * smoothstep(0.66, 0.88, fN * 0.78 + 0.26 * swell * band) * 0.34;
            foam = max(foam, (1.0 - smoothstep(0.0, 0.42, toShore)) * smoothstep(0.44, 0.70, fN + 0.16 * sin(t * 1.6 + vWorld.x * 0.3 + vWorld.z * 0.23)) * 0.36);
            foam *= 1.0 - smoothstep(260.0, 1000.0, dist);
            foam *= 1.0 - 0.92 * uNightFactor;
            float caps = smoothstep(0.955, 0.995, texture(uNoise, vWorld.xz / 11.0 + wdir * t * 0.06 + 0.5).b)
                       * smoothstep(0.80, 0.97, texture(uNoise, vWorld.xz / 70.0 - wdir * t * 0.02 + 0.2).r)
                       * midFade * calm * smoothstep(1.2, 4.0, depth) * 0.10;
            foam = max(foam, caps * (1.0 - 0.92 * uNightFactor));
            diffuse = mix(diffuse, vec3(0.34, 0.36, 0.375), foam);

            // --- direct: hemi fill on the body, plus the sky-bounce floor (open water is never
            //     a black hole; the web maxes the diffuse irradiance against uSkyFloor * 1.35)
            vec3 col = diffuse * (uAmbient * vec3(1.0) + uSkyFloor);
            col = max(col, uSkyFloor * 1.35);
            float ndv = max(cosT, 1e-3);
            float a = 0.040 + 0.055 * (1.0 - detailFade) + 0.05 * smoothstep(500.0, 2600.0, dist);
            float a2 = a * a;
            float moonUp = smoothstep(0.0, 0.15, uMoonDir.y);
            {
                vec3 Hs = normalize(uSunDir + Vw);
                float ndh = max(dot(Ng, Hs), 0.0), ndlS = max(dot(Ng, uSunDir), 0.0);
                float dd = ndh * ndh * (a2 - 1.0) + 1.0;
                float D = a2 / (PI * dd * dd);
                float Fh = 0.02 + 0.98 * pow(1.0 - max(dot(Hs, Vw), 0.0), 5.0);
                float Vis = 0.5 / max(ndlS * sqrt(ndv * ndv * (1.0 - a2) + a2) + ndv * sqrt(ndlS * ndlS * (1.0 - a2) + a2), 1e-3);
                float sunUp = smoothstep(-0.05, 0.12, uSunDir.y);
                col += uSunColor * sunUp * min(D * Fh * Vis * ndlS, 0.9 + 1.7 * detailFade);
            }
            {
                vec3 Hm = normalize(uMoonDir + Vw);
                float ndh = max(dot(Ng, Hm), 0.0), ndlM = max(dot(Ng, uMoonDir), 0.0);
                float dd = ndh * ndh * (a2 - 1.0) + 1.0;
                float D = a2 / (PI * dd * dd);
                float Fh = 0.02 + 0.98 * pow(1.0 - max(dot(Hm, Vw), 0.0), 5.0);
                float Vis = 0.5 / max(ndlM * sqrt(ndv * ndv * (1.0 - a2) + a2) + ndv * sqrt(ndlM * ndlM * (1.0 - a2) + a2), 1e-3);
                col += uMoonColor * moonUp * min(D * Fh * Vis * ndlM, 5.0) * 1.4;
            }

            // --- sky reflection (the water's main light): fresnel-weighted probe, desaturated to
            //     the site's slate chroma, hazed toward the horizon colour with distance
            float fres = 0.020 + 0.55 * pow(1.0 - cosT, 5.0);
            vec3 refl = skyProbe(reflect(-Vw, gWN));
            refl = mix(refl, vec3(dot(refl, LUM)), 0.46);
            // planar RT overrides the sky probe wherever it caught something (the far bank,
            // its trees, buildings); elsewhere the analytic sky stands in (Water.js)
            if (uReflectionStrength > 0.0) {
                vec4 ruv = vReflUv;
                ruv.xy += vec2(gWN.x, gWN.z) * (0.030 + 0.070 * detailFade) * ruv.w;
                vec2 pv = ruv.xy / max(ruv.w, 1e-4);
                // the distorted lookup can walk off the target; fade back at its border
                vec2 fade = smoothstep(vec2(0.0), vec2(0.035), pv) * smoothstep(vec2(0.0), vec2(0.035), 1.0 - pv);
                float inside = fade.x * fade.y;
                vec4 planar = textureProj(uReflection, ruv);
                refl = mix(refl, max(planar.rgb, refl * 0.14), clamp(planar.a, 0.0, 1.0) * uReflectionStrength * inside);
            }
            refl = mix(refl, uHorizon, 0.5 * smoothstep(160.0, 1700.0, dist));
            col += refl * fres * (1.0 + foam * 0.3) * 1.05;
            col += uNightSheen * (0.16 + 0.84 * pow(1.0 - cosT, 3.0));

            // --- transparency: dithered waterline dissolve (no hard tan seam)
            float alpha = 1.0 - exp(-depth * 2.2);
            alpha = max(alpha, fres * 0.8 * smoothstep(0.0, 0.4, depth));
            alpha = max(alpha, foam * 0.85);
            float edge = smoothstep(0.0, 1.40, toShore) * smoothstep(0.0, 0.05, depth);
            float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
            float grain = texture(uNoise, vWorld.xz * 0.9).g;
            edge = clamp(edge * 1.22 - 0.11 + (ign * 0.6 + grain * 0.4 - 0.5) * 0.30 * edge * (1.0 - edge) * 4.0, 0.0, 1.0);
            float fog = 1.0 - exp(-dist * uFogDensity);
            col = mix(col, uFogColor, fog);
            fragColor = vec4(col, clamp(alpha, 0.0, 1.0) * edge);
        }
    """.trimIndent()

    private val VS_SKY = """
        #version 300 es
        layout(location=0) in vec3 aPos;
        out vec2 vNdc;
        void main() {
            vNdc = aPos.xy;
            gl_Position = vec4(aPos.xy, 0.9999, 1.0);
        }
    """.trimIndent()

    // The site's sky (environment shaders.js port, display-referred): the analytic gradient feeds
    // the same shader that draws the procedural star field + the baked Milky Way cube rotating
    // with sidereal time, the phase-correct moon disc with limb darkening + halo, and the sun
    // disc with limb darkening. Star/disc radiance reaches display space through uNightKey.
    private val FS_SKY = """
        #version 300 es
        precision highp float;
        in vec2 vNdc;
        uniform mat4 uInvVP;
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uCamPos;
        uniform float uDayFactor;
        uniform mat3 uStarRot;
        uniform samplerCube uStars;
        uniform sampler2D uMoonTex;
        uniform float uStarIntensity;
        uniform float uStarSeed;
        uniform float uMilkyWay;
        uniform float uStarFade;
        uniform float uSkyFog;      // dome dissolve into the luminous fog colour
        uniform vec4 uFogSun;      // xyz sun dir, w = fog glow strength
        uniform vec3 uFogColSky;   // fog colour (milk) in display units for the dissolve
        uniform float uNightKey;
        uniform float uTime;
        uniform vec3 uMoonDir;
        uniform float uMoonBright;
        uniform float uMoonRadius;
        uniform float uSunRadius;
        uniform float uSunDisc;
        uniform vec3 uSunTint;
        out vec4 fragColor;
        const float PI = 3.141592653589793;
        const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);

        vec4 hash4(vec3 p) {
            vec4 q = vec4(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)), dot(p, vec3(419.2, 371.9, 43.7)));
            return fract(sin(q) * 43758.5453123);
        }

        // procedural star field on the celestial sphere (cube-face grid, 3x3 neighbourhood)
        vec3 starField(vec3 sd) {
            vec3 a = abs(sd);
            float faceId; vec2 uv;
            if (a.x >= a.y && a.x >= a.z) { faceId = sd.x > 0.0 ? 0.0 : 1.0; uv = vec2(-sd.z * sign(sd.x), -sd.y) / a.x; }
            else if (a.y >= a.z) { faceId = sd.y > 0.0 ? 2.0 : 3.0; uv = vec2(sd.x, sd.z * sign(sd.y)) / a.y; }
            else { faceId = sd.z > 0.0 ? 4.0 : 5.0; uv = vec2(sd.x * sign(sd.z), -sd.y) / a.z; }
            const float GRID = 72.0;
            vec2 g = (uv * 0.5 + 0.5) * GRID;
            vec2 cell = floor(g);
            float px = clamp(length(fwidth(g)), 1e-4, 0.25); // one screen pixel in grid units
            vec3 acc = vec3(0.0);
            for (int j = -1; j <= 1; j++) {
                for (int i = -1; i <= 1; i++) {
                    vec2 c = cell + vec2(float(i), float(j));
                    if (c.x < 0.0 || c.y < 0.0 || c.x >= GRID || c.y >= GRID) continue;
                    vec4 h = hash4(vec3(c, faceId * 17.0 + uStarSeed));
                    if (h.z > 0.50) continue; // star density
                    vec2 sp = c + 0.1 + 0.8 * h.xy;
                    float d = length(g - sp);
                    vec4 h2 = hash4(vec3(c + 31.0, faceId * 5.0 + uStarSeed));
                    float mag = pow(h2.x, 7.0);            // many faint, few bright
                    float bright = 0.05 + mag * 4.0 + pow(h2.x, 40.0) * 6.0;
                    float size0 = 0.018 + mag * 0.05;
                    float size = max(size0, px * 0.8);     // never thinner than a pixel
                    float e = bright * clamp(size0 / size, 0.35, 1.0); // partial energy conservation
                    float sIn = exp(-(d * d) / (size * size));
                    vec3 col = h2.y < 0.22 ? vec3(0.70, 0.80, 1.0) : h2.y < 0.72 ? vec3(0.94, 0.96, 1.0) : h2.y < 0.93 ? vec3(1.0, 0.95, 0.88) : vec3(1.0, 0.85, 0.70);
                    float tw = 1.0 + 0.25 * sin(uTime * (3.0 + 5.0 * h2.z) + h2.w * 40.0);
                    acc += col * e * sIn * tw;
                }
            }
            return acc * 0.92;
        }

        // phase-consistent moon disc with limb darkening and earthshine
        vec3 moonDisc(vec3 rd) {
            float cosA = dot(rd, uMoonDir);
            float ang = acos(clamp(cosA, -1.0, 1.0));
            if (ang > uMoonRadius) return vec3(0.0);
            vec3 up = abs(uMoonDir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
            vec3 right = normalize(cross(up, uMoonDir));
            vec3 upv = cross(uMoonDir, right);
            float x = dot(rd, right) / uMoonRadius;
            float y = dot(rd, upv) / uMoonRadius;
            float r2 = x * x + y * y;
            float z = sqrt(max(0.0, 1.0 - r2));
            vec3 n = normalize(-uMoonDir * z + right * x + upv * y);
            float ndl = max(0.0, dot(n, uSunDir));
            vec2 uv = vec2(atan(x, z) / (2.0 * PI) + 0.5, acos(clamp(y, -1.0, 1.0)) / PI);
            float alb = texture(uMoonTex, uv).r;
            alb = 0.42 + 0.58 * alb;
            float edge = 1.0 - smoothstep(0.985, 1.0, sqrt(r2));
            float limb = 0.62 + 0.38 * pow(max(z, 0.0), 0.42);
            float light = ndl * limb + 0.012; // earthshine keeps the dark side barely visible
            return vec3(alb) * light * uMoonBright * 0.30 * edge;
        }

        void main() {
            vec4 p = uInvVP * vec4(vNdc, 1.0, 1.0);
            vec3 dir = normalize(p.xyz / p.w - uCamPos);
            float t = clamp(dir.y * 1.4 + 0.12, 0.0, 1.0);
            vec3 col = mix(uHorizon, uZenith, pow(t, 0.75));
            float s = max(dot(dir, uSunDir), 0.0);
            col += uSunColor * (pow(s, 700.0) * 2.4 + pow(s, 24.0) * 0.28 + pow(s, 5.0) * 0.10);
            // ground below horizon darkens toward a muted land tone
            col = mix(col, uHorizon * 0.55, clamp(-dir.y * 6.0, 0.0, 1.0));

            // stars: procedural (pixel-exact) + baked Milky Way cube, washed out by sky brightness
            vec3 sd = uStarRot * dir;
            float skyLum = dot(col, LUM);
            float wash = exp(-skyLum / max(uNightKey, 1e-4) * 10.0);
            vec4 mw = texture(uStars, sd);
            vec3 stars = mw.rgb * (mw.a * 0.7 * 2.4 * uMilkyWay) + starField(sd);
            col += stars * uStarIntensity * wash * uNightKey * uStarFade;

            // moon + soft halo (forward scattering of moonlight by haze)
            col += moonDisc(dir) * uNightKey;
            {
                float cosM = dot(dir, uMoonDir);
                float halo = exp(-(1.0 - cosM) * 900.0) * 0.06 + exp(-(1.0 - cosM) * 60.0) * 0.007 + exp(-(1.0 - cosM) * 11.0) * 0.0032;
                col += halo * uMoonBright * vec3(0.7, 0.8, 1.0) * step(0.0, uMoonDir.y) * uNightKey;
            }

            // sun disc with limb darkening (low sun: a dimmer, 2200 K tinted disc)
            {
                float cosS = dot(dir, uSunDir);
                float angS = acos(clamp(cosS, -1.0, 1.0));
                if (angS < uSunRadius) {
                    float q = angS / uSunRadius;
                    float limb = 1.0 - 0.55 * (1.0 - sqrt(max(0.0, 1.0 - q * q)));
                    float edge = 1.0 - smoothstep(0.93, 1.0, q);
                    col += uSunDisc * uSunTint * limb * edge;
                }
            }
            // dense fog / overcast: the dome dissolves into the luminous fog colour (shaders.js
            // FS_SKY uSkyFog block) with a soft glow toward the sun so the frame keeps direction
            if (uSkyFog > 0.001) {
                float fogMix = uSkyFog * (0.72 + 0.28 * exp(-max(dir.y, 0.0) * 4.0));
                float glow = uFogSun.w * pow(max(dot(dir, uFogSun.xyz), 0.0), 10.0);
                col = mix(col, uFogColSky * (1.0 + glow), clamp(fogMix, 0.0, 1.0));
            }
            fragColor = vec4(col, 1.0);
        }
    """.trimIndent()

    private val VS_PRECIP = """
        #version 300 es
        precision highp float;
        layout(location=0) in vec4 aSeed; // rx, ry, rz in [0,1), speed factor
        uniform mat4 uVP;
        uniform vec3 uCenter;   // volume centre (world) — the camera target
        uniform vec3 uVolume;   // volume size (world)
        uniform vec3 uVel;      // base velocity (world, m/s) incl. wind
        uniform float uTime;
        uniform float uMode;    // 0 = rain streak point, 1 = snow flake
        uniform float uSway;    // lateral sway amplitude (snow)
        uniform float uSize;    // point size (px)
        out float vFade;
        void main() {
            float speed = mix(0.75, 1.25, aSeed.w);
            vec3 vel = uVel * speed;
            vec3 base = aSeed.xyz * uVolume;
            vec3 travel = vel * uTime;
            if (uMode > 0.5) {
                float ph = aSeed.x * 37.0 + aSeed.z * 11.0;
                travel.x += sin(uTime * 0.9 + ph) * uSway + sin(uTime * 2.3 + ph * 0.7) * uSway * 0.3;
                travel.z += cos(uTime * 0.7 + ph * 1.3) * uSway + cos(uTime * 1.9 + ph) * uSway * 0.3;
                travel.y += sin(uTime * 1.7 + ph * 3.1) * 0.12;
            }
            // wrap around the volume centre so moving the camera never makes drops pop (Precipitation.js)
            vec3 h = uVolume * 0.5;
            vec3 world = uCenter + mod(base + travel - uCenter + h, uVolume) - h;
            gl_Position = uVP * vec4(world, 1.0);
            float dist = length(world - uCenter);
            float radius = length(uVolume) * 0.5;
            vFade = (1.0 - smoothstep(radius * 0.55, radius, dist)) * smoothstep(1.5, 6.0, dist);
            gl_PointSize = uMode > 0.5 ? uSize * mix(0.75, 1.35, aSeed.w) : uSize;
        }
    """.trimIndent()

    private val FS_PRECIP = """
        #version 300 es
        precision highp float; // uMode must match the vertex shader's highp (GLES link rule)
        in float vFade;
        uniform float uMode;
        uniform vec3 uTint;
        uniform float uAlpha;
        out vec4 fragColor;
        void main() {
            float a = uAlpha * vFade;
            if (uMode > 0.5) {
                vec2 d = gl_PointCoord - vec2(0.5);
                a *= smoothstep(0.5, 0.12, length(d));
            }
            fragColor = vec4(uTint, a);
        }
    """.trimIndent()

    // The site's volumetric cloud deck (environment/shaders.js CLOUD_FRAGMENT port): ray-marched
    // spherical shell fed by the baked 64³ Perlin-Worley shape volume, the 256² rank-equalised
        // weather map and the cirrus sheet — the same textures the web bakes on the CPU (worldgen
        // Clouds.kt). Temporal accumulation is dropped (fixed jitter, the web's probe path); the march
        // budget is 18 view steps / 3 light steps (the web 'low' profile).
    private val FS_CLOUDS = """
            #version 300 es
            precision highp float;
            in vec2 vNdc;
            uniform mat4 uInvVP;
            out vec4 fragColor;
    uniform vec3 uCamPos;
    uniform vec3 uLightDir;      // toward the dominant light (sun or moon)
    uniform vec3 uLightColor;    // irradiance at cloud altitude
    uniform vec3 uAmbientTop;
    uniform vec3 uAmbientBottom;
    uniform vec3 uAmbientSunSide;// warm horizon radiance on the sun side (golden hour), lights bases / sun-facing flanks
    uniform vec3 uHazeColor;
    uniform float uHazeDensity;
    uniform float uCoverage;     // 0..1 weather coverage
    uniform float uCloudType;    // 0 stratus .. 1 cumulus
    uniform float uDensity;      // extinction scale (1/m at full density)
    uniform float uPrecip;       // darkens bases
    uniform float uCloudBase;
    uniform float uCloudTop;
    uniform float uCurvatureRadius;
    uniform vec3 uWindOffset;    // metres
    uniform vec2 uWindDir;       // unit XZ wind direction (cirrus streaks)
    uniform float uTime;
    const int uSteps = 18;
    const int uLightSteps = 3;
    uniform sampler3D uNoise;
    uniform sampler2D uWeather;
    uniform sampler2D uCirrus;   // R fibrous streak noise, G broad patches (both rank-equalised)
    uniform float uCirrusCover;  // 0..1
    uniform float uCirrusAlt;    // metres
    uniform float uCirrusScale;  // metres per cirrus tile
    uniform float uWeatherScale; // metres per weather tile
    uniform float uBaseScale;    // metres per base-noise tile
    uniform float uDetailScale;
    // temporal accumulation (main pass only)
    uniform mat4 uPrevViewProj;  // previous frame projection * rotation-only view
    uniform float uPixelAngle;   // radians per render-target pixel
    uniform float uScatterGain;  // in-scatter gain: sunlit cumulus must be the brightest thing in a daylight frame
    uniform float uBaseJitter;   // per-column base-height jitter as a fraction of the shell thickness

    const float PI = 3.14159265359;

    float remap01(float v, float a, float b) { return clamp((v - a) / (b - a), 0.0, 1.0); }
    float hg(float mu, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * mu, 1.5)); }

    vec2 raySphere(vec3 ro, vec3 rd, float R) {
      float b = dot(ro, rd);
      float c = dot(ro, ro) - R * R;
      float h = b * b - c;
      if (h < 0.0) return vec2(-1.0);
      h = sqrt(h);
      return vec2(-b - h, -b + h);
    }

    // weather-map coverage → local cloud coverage; the covered sky fraction tracks uCoverage. Wide ramp: the
    // coverage field itself shapes the cloud (thin ragged fringe → dense core)
    float coverageAt(vec4 w) {
      float th = 1.0 - uCoverage;
      return smoothstep(th - 0.08, th + 0.20, w.r + (w.b - 0.5) * 0.28);
    }

    // per-column top (fraction of the shell thickness): small patches stay flatter, big fronts tower
    float columnTop(float cov, vec4 w2) {
      return clamp(mix(0.44, 1.05, pow(cov, 0.5)) * mix(0.60, 1.30, w2.b), 0.18, 1.0);
    }
    // per-column base height offset (fraction of the shell thickness): two decorrelated weather octaves so the deck
    // never sits on one plane — the r2 critic's 'row of pancakes with a shared dead-flat base'
    // per-cloud base wobble: the weather map is km-scale, so on its own every cumulus in a row is still cut off by
    // the same base plane (the r3 critic's 'dead-flat horizontal base'). Two decorrelated sine lattices at ~620 m and
    // ~290 m give each cell its own base height at no texture cost.
    float baseWobble(vec2 pw) {
      vec2 q = pw * (1.0 / 620.0);
      float a = sin(q.x * 1.7 + sin(q.y * 1.3) * 2.1) * cos(q.y * 1.9 - sin(q.x * 0.7) * 1.7);
      vec2 r = pw * (1.0 / 291.0);
      float b = sin(r.x * 2.3 - cos(r.y * 1.1) * 1.9) * cos(r.y * 1.5 + sin(r.x * 1.3) * 1.3);
      return a * 0.64 + b * 0.36;
    }
    float columnBase(vec4 wHi, vec4 w2, vec2 pw) {
      float km = (wHi.b - 0.5) * 0.62 + (w2.g - 0.5) * 0.38;
      return (km * 1.30 + baseWobble(pw) * 0.42) * 2.0 * uBaseJitter;
    }
    // vertical profile in normalised column height hn (0 = base, 1 = local top): flat dense base, rounded top
    float heightGradient(float hn, float type) {
      float stratus = smoothstep(0.0, 0.06, hn) * (1.0 - smoothstep(0.25, 0.65, hn));
      float cumulus = smoothstep(0.0, 0.16, hn) * (1.0 - smoothstep(0.52, 1.0, hn));
      return mix(stratus, cumulus, type);
    }

    // mip level for a noise tile of scale metres (64 texels) seen at distance t: footprint in texels → log2.
    // aniso: at grazing elevations adjacent pixel ROWS sample the layer hundreds of metres apart while columns are metres
    // apart — the vertical footprint is 1/sin(elevation) larger, and without this the far deck aliases into stripes
    float noiseLod(float t, float scale, float pixAng, float aniso) {
      return log2(max(1.0, t * pixAng * aniso * 64.0 / scale));
    }

    // density at world position p; hn = normalised column height; detail in [0,1] scales the erosion samples;
    // lodB / lodD: explicit mip levels for the base / detail lookups (far clouds must not alias into dashes)
    float cloudDensity(vec3 p, float hn, float weatherCov, float cloudType, float detail, float lodB, float lodD) {
      vec3 q = (p + uWindOffset) / uBaseScale;
      q.y *= 0.85; // near-isotropic: cumulus heaps, not smeared sheets
      vec4 n = textureLod(uNoise, q, lodB);
      float lowFbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
      float base = remap01(n.r, -(1.0 - lowFbm) * 0.85, 1.0);
      float type = clamp(mix(0.15, 0.95, uCloudType) * (0.42 + 1.16 * cloudType), 0.05, 1.0);
      // ragged base: the height gradient alone cuts every column off at exactly the same plane (the r2 critic's
      // 'row of pancakes'). n.b is the 16-cell Worley octave (~350 m cells) already fetched above, so this wobbles
      // the base and the cap by +/- 11 % of the column for free.
      float wob = (n.b - 0.5) * 0.22;
      base *= heightGradient(clamp(hn - wob, 0.0, 1.0), type);
      // coverage carves the base shape; density grows with height (bases wispy, cores dense)
      float dens = remap01(base, 1.0 - weatherCov, 1.0) * weatherCov;
      dens *= mix(0.65, 1.0, smoothstep(0.0, 0.35, hn));
      if (detail > 0.001 && dens > 0.0) {
        vec3 qd = (p + uWindOffset * 0.6 + vec3(uTime * 6.0, uTime * 1.5, 0.0)) / uDetailScale;
        vec4 hn4 = textureLod(uNoise, qd, lodD);
        float hfbm = hn4.g * 0.625 + hn4.b * 0.25 + hn4.a * 0.125;
        // wispy erosion at the base (subtract fbm), billowy at the top (subtract inverted fbm)
        float erode = mix(hfbm, 1.0 - hfbm, clamp(hn * 5.0, 0.0, 1.0));
        float strength = mix(0.66, 0.46, smoothstep(0.1, 0.5, hn)) * detail;
        dens = remap01(dens, erode * strength, 1.0);
        // cauliflower: two high-frequency Worley octaves (3.1x and 6.4x the detail tile) biting into the silhouette.
        // The bite scales with sqrt(coverage) so dense cores stay solid while fringes break into billows.
        if (dens > 0.0 && dens < 0.72) {
          float edge = 1.0 - dens / 0.72;
          float bite = detail * sqrt(clamp(weatherCov, 0.0, 1.0)) * edge;
          float f1 = textureLod(uNoise, qd * 3.1 + vec3(0.21, 0.57, 0.13), lodD + 1.63).a;
          float f2 = textureLod(uNoise, qd * 6.4 + vec3(0.73, 0.11, 0.47), lodD + 2.68).a;
          dens = remap01(dens, ((1.0 - f1) * 0.30 + (1.0 - f2) * 0.16) * bite, 1.0);
        }
      }
      return dens;
    }

    void main() {
      vec4 pw2 = uInvVP * vec4(vNdc, 1.0, 1.0);
      vec3 rd = normalize(pw2.xyz / pw2.w - uCamPos);
      vec3 ro = uCamPos;
      if (rd.y < -0.02) discard;
      // spherical shell centred below the camera → clouds curve down to the horizon
      vec3 C = vec3(ro.x, -uCurvatureRadius, ro.z);
      vec3 roC = ro - C;
      float rIn = uCurvatureRadius + uCloudBase;
      float rOut = uCurvatureRadius + uCloudTop;
      float camR = length(roC);
      float tStart, tEnd;
      vec2 tIn = raySphere(roC, rd, rIn);
      vec2 tOut = raySphere(roC, rd, rOut);
      bool hasShell = true;
      if (camR < rIn) { tStart = tIn.y; tEnd = tOut.y; }
      else if (camR < rOut) { tStart = 0.0; tEnd = (tIn.x > 0.0) ? tIn.x : tOut.y; }
      else { if (tOut.x < 0.0) hasShell = false; tStart = tOut.x; tEnd = (tIn.x > 0.0) ? tIn.x : tOut.y; }
      if (tEnd <= tStart) hasShell = false;
      float maxLen = 22000.0;
      tEnd = min(tEnd, tStart + maxLen);
      float pathLen = max(tEnd - tStart, 1.0);

      float mu = dot(rd, uLightDir);
      float thick = uCloudTop - uCloudBase;
      vec3 col = vec3(0.0);
      float T = 1.0;
      float firstHitT = -1.0;
      float sigma = uDensity;
      vec2 weatherOfs = uWindOffset.xz * 0.35;
      // interleaved gradient noise + golden-ratio temporal offset: every frame marches a different start offset and
      // the history buffer integrates them. The probe (no history) uses a fixed offset so the PMREM stays noise-free.
      // stratified temporal jitter: per-pixel random phase + golden-ratio sequence over frames (converges far faster
      // than white noise under the exponential history)
      float ign = 0.5; // fixed jitter (the web's probe path): deterministic, noise-free
      float pixAng = 0.0035;
      // anisotropic footprint at grazing elevations (see noiseLod); the layer curves down with the shell so use the
      // elevation relative to the shell tangent at the entry point
      float elev = clamp(abs(rd.y) + tStart / (2.0 * uCurvatureRadius), 0.03, 1.0);
      float aniso = pow(1.0 / elev, 0.6);

      if (hasShell && uCoverage > 0.003) {
        // step budget scales with the path length (grazing rays are long) up to a hard cap
        float targetStep = 5200.0 / float(uSteps);  // ~160 m at 32 steps
        int steps = int(clamp(pathLen / targetStep, 16.0, min(float(uSteps) * 2.0, 64.0)));
        float ds = pathLen / float(steps);
        float t = tStart + ds * ign;
        // phase: dual-lobe HG octaves (Hillaire) — forward lobe brightens sun-facing flanks, back lobe keeps the
        // anti-solar side from going black
        float ph0 = 4.0 * PI * mix(hg(mu, 0.72), hg(mu, -0.24), 0.40);
        float ph1 = 4.0 * PI * mix(hg(mu, 0.45), hg(mu, -0.14), 0.40);
        float ph2 = 4.0 * PI * mix(hg(mu, 0.26), hg(mu, -0.08), 0.40);
        ph0 = min(ph0, 3.0);
        // silver lining: a very narrow forward lobe that survives only through thin, sun-facing edges
        float silverPh = min(4.0 * PI * hg(mu, 0.93), 40.0);
        float stepScale = 1.0;
        int emptyRun = 0;
        for (int i = 0; i < 84; i++) {
          if (t >= tEnd) break;
          vec3 p = ro + rd * t;
          float h = length(p - C) - uCurvatureRadius;
          vec2 wuv = (p.xz + weatherOfs) / uWeatherScale;
          vec4 w = texture(uWeather, wuv);
          vec4 w2 = texture(uWeather, wuv * 0.41 + vec2(0.37, 0.61)); // large-scale column structure (top height)
          float cov = coverageAt(w);
          // grazing rays stack dozens of cells: thin the far field a little so a 25 %-cover sky keeps its blue gaps
          cov *= 1.0 - 0.5 * smoothstep(3000.0, 14000.0, t);
          float dens = 0.0;
          float hn = 0.0;
          if (cov > 0.01) {
            // ~1 km-scale lookup: neighbouring columns must get decorrelated bases, or the deck is one plane
            vec4 wHi = texture(uWeather, wuv * 2.7 + vec2(0.19, 0.83));
            float baseShift = columnBase(wHi, w2, p.xz) * thick;  // undulating, per-column cloud base
            float topF = columnTop(cov, w2);
            float hf = (h - uCloudBase - baseShift) / thick;
            hn = hf / topF;
            if (hn > 0.0 && hn < 1.0) {
              float detail = 1.0 - smoothstep(12000.0, 24000.0, t); // detail erosion resolvable to ~15 km
              dens = cloudDensity(p, hn, cov, w.g, detail, noiseLod(t, uBaseScale, pixAng, aniso), noiseLod(t, uDetailScale, pixAng, aniso));
            }
          }
          if (dens > 0.002) {
            if (stepScale > 0.75) {
              // entered a cloud with a coarse step: back up and refine
              t -= ds * stepScale * 0.65;
              stepScale = 0.35;
              emptyRun = 0;
              continue;
            }
            emptyRun = 0;
            float dsl = ds * stepScale;
            if (firstHitT < 0.0) firstHitT = t;
            // light march toward the light (exponentially growing steps: fine near the sample, coarse far away)
            float odL = 0.0;
            vec3 lp = p;
            float ls = 34.0;
            for (int j = 0; j < 6; j++) {
              if (j >= uLightSteps) break;
              lp += uLightDir * ls;
              float lh = length(lp - C) - uCurvatureRadius;
              if (lh > uCloudTop + 200.0 || lh < uCloudBase - 200.0) break;
              vec2 lwuv = (lp.xz + weatherOfs) / uWeatherScale;
              vec4 lw = texture(uWeather, lwuv);
              vec4 lw2 = texture(uWeather, lwuv * 0.41 + vec2(0.37, 0.61));
              float lcov = coverageAt(lw);
              float ltopF = columnTop(lcov, lw2);
              vec4 lwHi = texture(uWeather, lwuv * 2.7 + vec2(0.19, 0.83));
              float lhn = ((lh - uCloudBase - columnBase(lwHi, lw2, lp.xz) * thick) / thick) / ltopF;
              if (lhn > 0.0 && lhn < 1.0) odL += cloudDensity(lp, lhn, lcov, lw.g, 0.0, noiseLod(t, uBaseScale, pixAng, aniso) + 0.5, 0.0) * ls;
              ls *= 1.9;
            }
            float tauL = odL * sigma * 0.55;
            // multiple-scattering approximation (Hillaire): octaves of attenuated single scattering
            float lightE = exp(-tauL) * ph0 + 0.45 * exp(-tauL * 0.42) * ph1 + 0.20 * exp(-tauL * 0.18) * ph2;
            // Beer-powder: the eye sees less in-scatter at the freshly lit surface of dense cloud (sun side only)
            float powder = 1.0 - 0.55 * exp(-2.4 * (dens * sigma * dsl + odL * sigma * 0.12)) * clamp(mu, 0.0, 1.0);
            lightE *= powder;
            // single scattering alone leaves cumulus a mid-grey smudge (the r2 critic's 'blurry smudges'): a real deck
            // is many-times-scattered and reads as the brightest surface in the frame. uScatterGain lifts it there, the
            // clamp keeps it from blowing the white point (auto-exposure would then sink the ground).
            lightE = min(lightE * uScatterGain, 5.2);
            lightE += min(silverPh * exp(-tauL * 2.2) * 0.34 * (1.0 - smoothstep(0.0, 0.5, dens)), 1.4);
            // sky ambient: top/bottom gradient, occluded by the cloud above; precipitation darkens the bases
            vec3 ambient = mix(uAmbientBottom, uAmbientTop, smoothstep(0.0, 0.75, hn)) * (1.0 - 0.45 * uPrecip * (1.0 - hn));
            ambient *= 0.46 + 0.54 * exp(-tauL * 0.55);
            // golden hour: the warm sun-side horizon lights bases and sun-facing flanks (exp(-tauL) ≈ "faces the sun").
            // Bases pick it up most (the belt is below them), which is what turns an evening deck orange from underneath.
            ambient += uAmbientSunSide * (0.35 + 1.15 * (1.0 - hn)) * (0.22 + 0.78 * exp(-tauL * 0.8));
            vec3 sctr = uLightColor * lightE * (1.0 / PI) + ambient;
            // optical step capped: grazing rays take 500 m+ steps, and an opaque hit-or-miss per sample is variance the
            // history cannot average — capping keeps the far deck soft and the accumulation converged in ~40 frames
            float aStep = 1.0 - exp(-dens * sigma * min(dsl, 260.0));
            col += sctr * aStep * T;
            T *= 1.0 - aStep;
            if (T < 0.02) break;
          } else {
            emptyRun++;
            if (emptyRun > 2) stepScale = 1.0;
          }
          t += ds * stepScale;
        }
      }

      // --- cirrus / alto-stratus veil: a 2D sheet high above the deck, strongly forward scattering (ice) ---
      if (uCirrusCover > 0.003 && T > 0.01) {
        float rC = uCurvatureRadius + uCirrusAlt;
        float tC = raySphere(roC, rd, rC).y;
        if (tC > 0.0) {
          vec3 pc = ro + rd * tC;
          vec2 wd = normalize(uWindDir + vec2(1e-4, 0.0));
          vec2 uvw = (pc.xz + uWindOffset.xz * 1.9) / uCirrusScale;
          // streaks along the wind: anisotropic lookup in the wind frame
          vec2 uv = vec2(dot(uvw, wd) * 0.28, dot(uvw, vec2(-wd.y, wd.x)));
          float fib = texture(uCirrus, uv).r;
          float fib2 = texture(uCirrus, uv * 2.3 + vec2(0.13, 0.71)).r;
          float patchN = texture(uCirrus, uvw * 0.16 + vec2(0.5, 0.27)).g;
          float th = 1.0 - uCirrusCover;
          float covC = smoothstep(th - 0.05, th + 0.30, patchN * 0.72 + fib * 0.28);
          float densC = covC * (fib * 0.7 + fib2 * 0.3);
          densC *= densC;
          float alphaC = clamp(densC * 0.7, 0.0, 0.40);
          float phC = min(4.0 * PI * (0.42 * hg(mu, 0.86) + 0.30 * hg(mu, 0.45) + 0.28 * hg(mu, -0.12)), 2.0);
          vec3 cirCol = uLightColor * phC * (0.9 / PI) * (0.55 + 0.45 * (1.0 - alphaC)) + uAmbientTop * 0.9 + uAmbientSunSide * 0.5;
          float hazeC = 1.0 - exp(-pow(tC * uHazeDensity * 0.6, 1.3));
          cirCol = mix(cirCol, uHazeColor, clamp(hazeC, 0.0, 1.0));
          col += cirCol * alphaC * T;
          T *= 1.0 - alphaC;
        }
      }

      float alpha = 1.0 - T;
      // aerial perspective on the deck: blend toward the horizon haze with distance
      float dist = firstHitT > 0.0 ? firstHitT : tStart;
      float haze = 1.0 - exp(-pow(dist * uHazeDensity, 1.3));
      haze = clamp(haze, 0.0, 1.0);
      col = mix(col, uHazeColor * alpha, haze);
      // fade the deck into the horizon band so it never cuts the sky abruptly
      float horizonFade = smoothstep(-0.008, 0.02, rd.y);
      alpha *= horizonFade;
      col *= horizonFade;

      fragColor = vec4(col * alpha, alpha); // premultiplied over-compositing
    }
    """.trimIndent()
}
