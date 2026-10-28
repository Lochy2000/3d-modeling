import { layoutRoom, type ScanLayout } from '../layout-room';
import layout from './room.json';

export const room = layoutRoom({ id: 'example', label: 'Example room (invented)', layout: layout as ScanLayout });
