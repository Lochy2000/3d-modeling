import type { V3 } from '../room-runtime/types';

/**
 * One piece of furniture as data. A room's furniture.json is a list of these; the library turns each
 * into geometry. Local frame of every builder: origin at the floor centre of the footprint, front
 * facing +z, so `rotY` (degrees) turns the front toward the room.
 */
export interface FurnitureItem {
  id: string;
  type: FurnitureType;
  /** footprint centre in room coordinates [x, z] (meters) */
  at: [number, number];
  /** height of the item's base above the floor (wall-mounted TVs, things on a sideboard) */
  elevation?: number;
  /** degrees about +y; 0 = front faces +z, 180 = front faces -z */
  rotY?: number;
  /** [width, height, depth] in meters */
  size: V3;
  /** named colours (#rrggbb); tools/sample_colors.py fills the ones listed in `sample` from the photos */
  colors?: Record<string, string>;
  /** colour names to (re)sample from the photos */
  sample?: string[];
  /** type-specific options, see each builder */
  params?: Record<string, unknown>;
  /** where the numbers came from (scan probe, photo index, guess) */
  source?: string;
}

export type FurnitureType =
  | 'sofa' | 'sideboard' | 'tv' | 'rug' | 'sideTable' | 'beanBag' | 'speaker'
  | 'kitchenIsland' | 'kitchenRun' | 'barStool' | 'diningTable' | 'diningChair' | 'pendant' | 'floorLamp';

export interface FurnitureFile {
  version: 1;
  items: FurnitureItem[];
}
