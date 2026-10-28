package dev.dtmodeling.capture

import android.util.Log
import com.google.ar.core.CameraIntrinsics
import com.google.ar.core.Frame
import com.google.ar.core.ImageMetadata
import com.google.ar.core.Plane
import com.google.ar.core.Pose
import com.google.ar.core.Session
import com.google.ar.core.TrackingFailureReason
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.NotYetAvailableException
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Date
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.min
import kotlin.math.sqrt

data class Status(
    val tracking: TrackingState,
    val failure: TrackingFailureReason,
    val room: String?,
    val roomIndex: Int,
    val photos: Int,
    val depthFrames: Int,
    val blurPixels: Double,
    val depthEnabled: Boolean,
    val pendingWrites: Int,
)

/**
 * Runs on the GL thread once per ARCore frame. Decides when to take photos and depth frames and
 * hands copies to the [SessionWriter]. UI requests are queued with [post] and applied on the next frame.
 *
 * Poses: ARCore's Camera.getPose() is the physical camera (sensor orientation, +X right, +Y up, looking
 * down −Z) in a right-handed, gravity-aligned, metric world — the same convention as ARKit's camera
 * transform, so photos.json / frames.json match iPhone house-capture bundles.
 */
class Capturer(
    private val sessionsRoot: File,
    private val depthEnabled: () -> Boolean,
    private val deviceInfo: () -> JSONObject,
    private val onStatus: (Status) -> Unit,
) {
    private val commands = ConcurrentLinkedQueue<(Session, Frame) -> Unit>()

    private var writer: SessionWriter? = null
    private var roomIndex = -1
    private var nextRoom = 0
    private var roomName: String? = null
    private var roomPhotos = 0
    private var roomDepth = 0

    private var manualRequested = false
    private var lastPhotoPose: Pose? = null
    private var lastPhotoNs = 0L
    private var lastDepthNs = 0L
    private var prevPose: Pose? = null
    private var prevNs = 0L
    private var lastTracking: TrackingState? = null
    private var lastStatusNs = 0L
    private var blur = 0.0

    val roomActive get() = roomIndex >= 0

    fun post(command: (Session, Frame) -> Unit) = commands.add(command)

    fun startRoom(name: String) = post { _, _ ->
        val w = writer ?: SessionWriter(File(sessionsRoot, SessionWriter.folderName(Date())), deviceInfo())
            .also { writer = it }
        roomIndex = nextRoom++
        roomName = name
        roomPhotos = 0
        roomDepth = 0
        lastPhotoPose = null
        w.startRoom(roomIndex, UUID.randomUUID().toString(), name)
        w.event("room-start", "$roomIndex $name")
        w.event("tracking", "at room start: $lastTracking")
    }

    fun finishRoom() = post { session, _ -> closeRoom(session) }

    fun requestPhoto() = post { _, _ -> manualRequested = true }

    fun finishSession(onDone: (File?) -> Unit) = post { session, _ ->
        closeRoom(session)
        val w = writer
        writer = null
        nextRoom = 0
        if (w == null) onDone(null) else {
            w.event("session-finish")
            w.finish(onDone)
        }
    }

    /** Called from the UI thread when the activity is destroyed (GL thread no longer running). */
    fun abandon() {
        writer?.let {
            it.event("app-closed", "room ${if (roomActive) roomIndex else -1} left open")
            it.finish { }
        }
        writer = null
    }

    fun lifecycle(event: String) = writer?.event(event)

    private fun closeRoom(session: Session) {
        val w = writer ?: return
        if (roomIndex < 0) return
        w.finishRoom(roomIndex, planes(session), roomPhotos, roomDepth)
        w.event("room-finish", "$roomIndex photos=$roomPhotos depth=$roomDepth")
        roomIndex = -1
        roomName = null
    }

    fun onFrame(session: Session, frame: Frame) {
        while (true) (commands.poll() ?: break)(session, frame)

        val camera = frame.camera
        val state = camera.trackingState
        if (state != lastTracking) {
            writer?.event("tracking", if (state == TrackingState.PAUSED) "$state ${camera.trackingFailureReason}" else state.toString())
            lastTracking = state
        }
        val ns = frame.timestamp
        if (state != TrackingState.TRACKING || ns == 0L) {
            prevPose = null
            publish(ns, camera.trackingState, camera.trackingFailureReason)
            return
        }

        val pose = camera.pose
        var omega = 0.0
        var speed = 0.0
        prevPose?.let {
            val dt = (ns - prevNs) / 1e9
            if (dt > 0) {
                omega = angle(it, pose) / dt
                speed = distance(it, pose) / dt
            }
        }
        prevPose = pose
        prevNs = ns

        val image = camera.imageIntrinsics
        val exposureS = exposureSeconds(frame)
        // Rotational motion blur in CPU-image pixels during the exposure (translation blur is small indoors).
        blur = omega * exposureS * image.focalLength[0]

        val w = writer
        if (w != null && roomIndex >= 0) {
            val last = lastPhotoPose
            val moved = last == null || distance(last, pose) > PHOTO_MOVE_M || angle(last, pose) > PHOTO_TURN_RAD
            val auto = ns - lastPhotoNs > PHOTO_MIN_INTERVAL_NS && moved && blur < MAX_AUTO_BLUR_PX && speed < MAX_AUTO_SPEED
            if ((manualRequested || auto) && w.pending.get() < MAX_PENDING_PHOTO) {
                if (takePhoto(w, frame, pose, image, exposureS, manualRequested)) {
                    manualRequested = false
                    lastPhotoPose = pose
                    lastPhotoNs = ns
                }
            }
            if (depthEnabled() && ns - lastDepthNs > DEPTH_INTERVAL_NS && w.pending.get() < MAX_PENDING_DEPTH) {
                if (takeDepth(w, frame, pose, camera.textureIntrinsics, image)) lastDepthNs = ns
            }
        }
        publish(ns, state, TrackingFailureReason.NONE)
    }

    private fun takePhoto(w: SessionWriter, frame: Frame, pose: Pose, k: CameraIntrinsics, exposureS: Double, manual: Boolean): Boolean {
        val copy = try {
            frame.acquireCameraImage().use { YuvCopy.of(it) }
        } catch (e: NotYetAvailableException) {
            return false
        }
        val meta = JSONObject()
            .put("room", roomIndex)
            .put("timestamp", frame.timestamp / 1e9)
            .put("transform", matrix(pose))
            .put("intrinsics", intrinsics(k, 1.0, 1.0))
            .put("tracking", "normal")
            .put("manual", manual)
            .put("pass", if (manual) "manual" else "auto")
            .put("highRes", false)
            .put("camera", "back")
            .put("exposure", JSONObject().put("duration", exposureS).put("iso", iso(frame)))
            .put("blurPixels", round(blur, 2))
        w.addPhoto(copy, meta)
        roomPhotos++
        return true
    }

    private fun takeDepth(w: SessionWriter, frame: Frame, pose: Pose, texture: CameraIntrinsics, image: CameraIntrinsics): Boolean {
        val depth = try {
            frame.acquireDepthImage16Bits().use { DepthCopy.of(it) }
        } catch (e: NotYetAvailableException) {
            return false
        }
        val raw = try { frame.acquireRawDepthImage16Bits().use { DepthCopy.of(it) } } catch (e: NotYetAvailableException) { null }
        val conf = try { frame.acquireRawDepthConfidenceImage().use { DepthCopy.y8(it) } } catch (e: NotYetAvailableException) { null }
        val rgb = try { frame.acquireCameraImage().use { YuvCopy.of(it) } } catch (e: NotYetAvailableException) { null }

        // The depth image covers the same field of view as one of ARCore's camera streams. Use whichever
        // stream's aspect ratio matches the depth image and scale its intrinsics to depth resolution.
        val depthAspect = depth.width.toDouble() / depth.height
        val src = listOf("texture" to texture, "image" to image).minBy { (_, k) ->
            val d = k.imageDimensions
            abs(d[0].toDouble() / d[1] - depthAspect)
        }
        val dims = src.second.imageDimensions
        val meta = JSONObject()
            .put("room", roomIndex)
            .put("timestamp", frame.timestamp / 1e9)
            .put("transform", matrix(pose))
            .put("intrinsics", intrinsics(src.second, depth.width.toDouble() / dims[0], depth.height.toDouble() / dims[1]))
            .put("intrinsicsSource", src.first)
            .put("camera", "back")
            .put("depthSource", "arcore-smoothed")
        var factor = 1
        if (rgb != null) {
            factor = maxOf(1, rgb.width / RGB_TARGET_WIDTH)
            val rw = (rgb.width / factor) and 1.inv()
            val rh = (rgb.height / factor) and 1.inv()
            meta.put("rgbIntrinsics", intrinsics(image, rw.toDouble() / image.imageDimensions[0], rh.toDouble() / image.imageDimensions[1]))
        }
        w.addDepth(depth, raw, conf, rgb, factor, meta)
        roomDepth++
        return true
    }

    private fun planes(session: Session): JSONArray {
        val out = JSONArray()
        for (p in session.getAllTrackables(Plane::class.java)) {
            if (p.subsumedBy != null || p.trackingState == TrackingState.STOPPED) continue
            val poly = JSONArray()
            val buf = p.polygon.duplicate()
            buf.rewind()
            while (buf.remaining() >= 2) poly.put(JSONArray().put(round(buf.get().toDouble(), 4)).put(round(buf.get().toDouble(), 4)))
            out.put(JSONObject()
                .put("id", System.identityHashCode(p))
                .put("type", p.type.toString())
                .put("tracking", p.trackingState.toString())
                .put("centerPose", matrix(p.centerPose))
                .put("extentX", round(p.extentX.toDouble(), 4))
                .put("extentZ", round(p.extentZ.toDouble(), 4))
                .put("polygon", poly))
        }
        return out
    }

    private fun publish(ns: Long, state: TrackingState, failure: TrackingFailureReason) {
        if (ns != 0L && ns - lastStatusNs < 250_000_000L) return
        if (ns / 1_000_000_000L != lastStatusNs / 1_000_000_000L) {
            Log.i(MainActivity.TAG, "tracking $state failure $failure room $roomIndex photos $roomPhotos depth $roomDepth blur %.1f pending %d"
                .format(blur, writer?.pending?.get() ?: 0))
        }
        lastStatusNs = ns
        onStatus(Status(state, failure, roomName, roomIndex, roomPhotos, roomDepth, blur, depthEnabled(), writer?.pending?.get() ?: 0))
    }

    companion object {
        const val PHOTO_MOVE_M = 0.20
        const val PHOTO_TURN_RAD = 10.0 * Math.PI / 180
        const val PHOTO_MIN_INTERVAL_NS = 400_000_000L
        const val MAX_AUTO_BLUR_PX = 2.5
        const val MAX_AUTO_SPEED = 0.6
        const val DEPTH_INTERVAL_NS = 200_000_000L
        const val MAX_PENDING_PHOTO = 4
        const val MAX_PENDING_DEPTH = 8
        const val RGB_TARGET_WIDTH = 640

        /** Column-major 4×4 camera-to-world (translation in the last column). */
        fun matrix(pose: Pose): JSONArray {
            val m = FloatArray(16)
            pose.toMatrix(m, 0)
            return JSONArray().also { a -> m.forEach { a.put(round(it.toDouble(), 6)) } }
        }

        /** [fx, 0, 0, 0, fy, 0, cx, cy, 1] (column-major 3×3), optionally rescaled to another resolution. */
        fun intrinsics(k: CameraIntrinsics, sx: Double, sy: Double): JSONArray {
            val f = k.focalLength
            val c = k.principalPoint
            return JSONArray(listOf(f[0] * sx, 0.0, 0.0, 0.0, f[1] * sy, 0.0, c[0] * sx, c[1] * sy, 1.0).map { round(it, 4) })
        }

        fun distance(a: Pose, b: Pose): Double {
            val dx = a.tx() - b.tx()
            val dy = a.ty() - b.ty()
            val dz = a.tz() - b.tz()
            return sqrt((dx * dx + dy * dy + dz * dz).toDouble())
        }

        fun angle(a: Pose, b: Pose): Double {
            val dot = abs(a.qx() * b.qx() + a.qy() * b.qy() + a.qz() * b.qz() + a.qw() * b.qw()).toDouble()
            return 2 * acos(min(1.0, dot))
        }

        private fun exposureSeconds(frame: Frame): Double = try {
            frame.imageMetadata.getLong(ImageMetadata.SENSOR_EXPOSURE_TIME) / 1e9
        } catch (e: Exception) {
            1.0 / 60
        }

        private fun iso(frame: Frame): Int = try {
            frame.imageMetadata.getInt(ImageMetadata.SENSOR_SENSITIVITY)
        } catch (e: Exception) {
            0
        }

        private fun round(v: Double, digits: Int): Double {
            val p = Math.pow(10.0, digits.toDouble())
            return Math.round(v * p) / p
        }
    }
}
