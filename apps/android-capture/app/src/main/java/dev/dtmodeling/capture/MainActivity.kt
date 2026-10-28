package dev.dtmodeling.capture

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.pm.PackageManager
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.util.Log
import android.view.Surface
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import com.google.ar.core.ArCoreApk
import com.google.ar.core.CameraConfig
import com.google.ar.core.CameraConfigFilter
import com.google.ar.core.Config
import com.google.ar.core.Session
import com.google.ar.core.TrackingFailureReason
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.CameraNotAvailableException
import com.google.ar.core.exceptions.UnavailableException
import org.json.JSONObject
import java.io.File
import java.util.EnumSet
import kotlin.math.abs
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

class MainActivity : Activity(), GLSurfaceView.Renderer {
    private lateinit var surface: GLSurfaceView
    private lateinit var statusView: TextView
    private lateinit var hintView: TextView
    private lateinit var roomButton: Button
    private lateinit var photoButton: Button
    private lateinit var sessionButton: Button

    private val background = BackgroundRenderer()
    @Volatile private var session: Session? = null
    private var textureBound = false
    private var viewport: Pair<Int, Int>? = null
    private var installRequested = false
    private var depthSupported = false
    private var cameraConfigInfo = JSONObject()

    private lateinit var capturer: Capturer

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        surface = findViewById(R.id.surface)
        statusView = findViewById(R.id.status)
        hintView = findViewById(R.id.hint)
        roomButton = findViewById(R.id.room)
        photoButton = findViewById(R.id.photo)
        sessionButton = findViewById(R.id.session)

        val root = File(getExternalFilesDir(null), "Sessions").apply { mkdirs() }
        capturer = Capturer(root, { depthSupported }, ::deviceInfo) { s -> runOnUiThread { showStatus(s) } }

        surface.preserveEGLContextOnPause = true
        surface.setEGLContextClientVersion(2)
        surface.setEGLConfigChooser(8, 8, 8, 8, 16, 0)
        surface.setRenderer(this)
        surface.renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY

        roomButton.setOnClickListener { if (capturer.roomActive) finishRoom() else askRoomName() }
        photoButton.setOnClickListener { capturer.requestPhoto() }
        sessionButton.setOnClickListener { confirmFinishSession() }
    }

    override fun onResume() {
        super.onResume()
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), 1)
            return
        }
        if (session == null) {
            try {
                if (ArCoreApk.getInstance().requestInstall(this, !installRequested) == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
                    installRequested = true
                    return
                }
                session = createSession()
            } catch (e: UnavailableException) {
                fatal("ARCore is not available on this device: ${e.javaClass.simpleName}")
                return
            }
        }
        try {
            session?.resume()
        } catch (e: CameraNotAvailableException) {
            fatal("Camera not available. Close other camera apps and reopen.")
            return
        }
        surface.onResume()
        capturer.lifecycle("resumed")
    }

    override fun onPause() {
        super.onPause()
        capturer.lifecycle("paused")
        surface.onPause()
        session?.pause()
    }

    override fun onDestroy() {
        capturer.abandon()
        session?.close()
        session = null
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (grantResults.firstOrNull() != PackageManager.PERMISSION_GRANTED) fatal("Camera permission is required to scan.")
    }

    private fun createSession(): Session {
        val s = Session(this)
        // Developer switches for diagnosing tracking (adb shell am start ... --ei imageWidth 0 --ez depth false):
        // imageWidth 0 keeps ARCore's default camera config.
        val targetWidth = intent.getIntExtra("imageWidth", TARGET_IMAGE_WIDTH)
        val allowDepth = intent.getBooleanExtra("depth", true)
        val fixedFocus = intent.getBooleanExtra("fixedFocus", true)
        val planes = intent.getBooleanExtra("planes", true)
        Log.i(TAG, "options: imageWidth $targetWidth depth $allowDepth fixedFocus $fixedFocus planes $planes")
        // CPU-image resolution closest to targetWidth at 30 fps (these frames become the photos), among the
        // configs that support depth. On a Galaxy S10e the 4:3 1440×1080 config is a different camera (id 2)
        // without depth, so depth support is checked per config rather than assumed.
        val filter = CameraConfigFilter(s).setTargetFps(EnumSet.of(CameraConfig.TargetFps.TARGET_FPS_30))
        val configs = s.getSupportedCameraConfigs(filter)
        Log.i(TAG, "default camera config: image ${s.cameraConfig.imageSize} texture ${s.cameraConfig.textureSize}")
        val withDepth = configs.filter {
            s.cameraConfig = it
            s.isDepthModeSupported(Config.DepthMode.AUTOMATIC).also { d ->
                Log.i(TAG, "camera config: id ${it.cameraId} image ${it.imageSize} texture ${it.textureSize} depth $d")
            }
        }
        val pool = if (allowDepth && withDepth.isNotEmpty()) withDepth else configs
        val best = if (targetWidth > 0) pool.minByOrNull { abs(it.imageSize.width - targetWidth) } else pool.firstOrNull()
        if (best != null) {
            Log.i(TAG, "using camera config: image ${best.imageSize} texture ${best.textureSize}")
            s.cameraConfig = best
            cameraConfigInfo = JSONObject()
                .put("imageSize", "${best.imageSize.width}x${best.imageSize.height}")
                .put("textureSize", "${best.textureSize.width}x${best.textureSize.height}")
                .put("depthSensor", best.depthSensorUsage.toString())
                .put("cameraId", best.cameraId)
        }
        depthSupported = allowDepth && s.isDepthModeSupported(Config.DepthMode.AUTOMATIC)
        s.configure(Config(s).apply {
            // Fixed focus keeps intrinsics constant across frames (ARCore's default; sharp beyond ~1 m).
            focusMode = if (fixedFocus) Config.FocusMode.FIXED else Config.FocusMode.AUTO
            planeFindingMode = if (planes) Config.PlaneFindingMode.HORIZONTAL_AND_VERTICAL else Config.PlaneFindingMode.DISABLED
            depthMode = if (depthSupported) Config.DepthMode.AUTOMATIC else Config.DepthMode.DISABLED
            updateMode = Config.UpdateMode.BLOCKING
        })
        if (!depthSupported) Toast.makeText(this, "ARCore depth not supported: photos only", Toast.LENGTH_LONG).show()
        return s
    }

    private fun deviceInfo(): JSONObject = JSONObject()
        .put("platform", "android")
        .put("manufacturer", Build.MANUFACTURER)
        .put("model", Build.MODEL)
        .put("sdk", Build.VERSION.SDK_INT)
        .put("arcoreDepth", depthSupported)
        .put("camera", cameraConfigInfo)

    // --- GLSurfaceView.Renderer (GL thread) ------------------------------------------------

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        background.create()
        textureBound = false
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        GLES20.glViewport(0, 0, width, height)
        viewport = width to height
    }

    override fun onDrawFrame(gl: GL10?) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
        val s = session ?: return
        if (!textureBound) {
            s.setCameraTextureName(background.textureId)
            textureBound = true
        }
        viewport?.let { (w, h) ->
            s.setDisplayGeometry(Surface.ROTATION_0, w, h)
            viewport = null
        }
        val frame = try {
            s.update()
        } catch (e: CameraNotAvailableException) {
            return
        }
        background.draw(frame)
        capturer.onFrame(s, frame)
    }

    // --- UI ---------------------------------------------------------------------------------

    private fun askRoomName() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS
            hint = "e.g. Bedroom"
        }
        AlertDialog.Builder(this)
            .setTitle("Room name")
            .setView(input)
            .setPositiveButton("Scan") { _, _ ->
                val name = input.text.toString().trim().ifEmpty { "Room" }
                capturer.startRoom(name)
                roomButton.text = "Finish room"
                photoButton.isEnabled = true
                sessionButton.isEnabled = true
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun finishRoom() {
        capturer.finishRoom()
        roomButton.text = "Next room"
        photoButton.isEnabled = false
    }

    private fun confirmFinishSession() {
        AlertDialog.Builder(this)
            .setTitle("Finish session?")
            .setMessage("Saves all rooms. Rooms scanned in a new session will be in a separate coordinate frame.")
            .setPositiveButton("Finish") { _, _ ->
                sessionButton.isEnabled = false
                photoButton.isEnabled = false
                roomButton.isEnabled = false
                capturer.finishSession { dir -> runOnUiThread { sessionSaved(dir) } }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun sessionSaved(dir: File?) {
        roomButton.isEnabled = true
        roomButton.text = "Start room"
        if (dir == null) return
        AlertDialog.Builder(this)
            .setTitle("Session saved")
            .setMessage("${dir.name}\n\nPlug the phone into the PC and run, from the dt-modeling folder:\n\npython tools/pull_scans.py")
            .setPositiveButton("OK", null)
            .show()
    }

    private fun showStatus(s: Status) {
        val track = if (s.tracking == TrackingState.TRACKING) "OK" else "${s.tracking} (${s.failure}) — NOT RECORDING"
        val room = if (s.roomIndex >= 0) "room ${s.roomIndex} \"${s.room}\"" else "no room active"
        statusView.text = buildString {
            append("tracking $track · depth ${if (s.depthEnabled) "on" else "off"}\n")
            append("$room\n")
            append("photos ${s.photos} · depth frames ${s.depthFrames} · blur %.1f px".format(s.blurPixels))
            if (s.pendingWrites > 3) append(" · saving ${s.pendingWrites}")
        }
        val hint = when {
            s.tracking == TrackingState.TRACKING -> if (s.roomIndex >= 0 && s.blurPixels > Capturer.MAX_AUTO_BLUR_PX) "Move slower" else null
            s.failure == TrackingFailureReason.EXCESSIVE_MOTION -> "Moving too fast — slow down"
            s.failure == TrackingFailureReason.INSUFFICIENT_FEATURES -> "Not enough detail — point at textured surfaces"
            s.failure == TrackingFailureReason.INSUFFICIENT_LIGHT -> "Too dark — turn on lights"
            s.failure == TrackingFailureReason.CAMERA_UNAVAILABLE -> "Camera unavailable"
            else -> "Move the phone slowly to start tracking"
        }
        hintView.text = hint
        hintView.visibility = if (hint == null) View.GONE else View.VISIBLE
    }

    companion object {
        const val TAG = "DTCapture"
        const val TARGET_IMAGE_WIDTH = 1920
    }

    private fun fatal(message: String) {
        AlertDialog.Builder(this)
            .setMessage(message)
            .setCancelable(false)
            .setPositiveButton("Close") { _, _ -> finish() }
            .show()
    }
}
