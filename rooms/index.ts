import type { RoomModule } from '../packages/room-runtime/types';

// Rooms register themselves by exporting `room` from <dir>/index.ts. Personal rooms live in
// rooms/private/<id>/ (git-ignored), so the tracked code never names or imports them directly,
// and they load only in the dev server: a production build (anything you might publish) never
// contains them. Their photos and scans in data/web-assets are dev-only too (see vite.config.ts).
type Entry = { room: RoomModule };
const shared = import.meta.glob<Entry>('./*/index.ts', { eager: true });
const personal = import.meta.env.DEV ? import.meta.glob<Entry>('./private/*/index.ts') : {};
const loaded = await Promise.all(Object.values(personal).map(load => load()));

export const ROOMS: RoomModule[] = [
  ...loaded.map(m => m.room).sort((a, b) => a.label.localeCompare(b.label)),
  ...Object.entries(shared).sort(([a], [b]) => a.localeCompare(b)).map(([, m]) => m.room),
];
export const roomById = (id: string | null) => ROOMS.find(r => r.id === id) ?? ROOMS[0];
export type { BuiltRoom, RoomModule } from '../packages/room-runtime/types';
