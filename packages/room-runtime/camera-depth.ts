import type { Box3, PerspectiveCamera } from 'three';

/** Spend depth precision on the visible model instead of empty space in front of it.
 * Half the distance to its enclosing box keeps the near plane safely outside all geometry.
 * Inside the box, retain the close-up near plane used for walking and inspecting objects.
 */
export function updateCameraDepth(camera: PerspectiveCamera, bounds: Box3, orbit: boolean) {
  const near = orbit && !bounds.isEmpty()
    ? Math.max(0.05, Math.min(1, bounds.distanceToPoint(camera.position) * 0.5))
    : 0.05;
  if (Math.abs(camera.near - near) < 0.0001) return false;
  camera.near = near;
  camera.updateProjectionMatrix();
  return true;
}
