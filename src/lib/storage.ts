import { FlightRecord } from './types';

const STORAGE_KEY = 'PROJECT_CEILING_DRIFT_STANDINGS';

export const DEFAULT_STANDINGS: FlightRecord[] = [
  {
    id: 'flight-01',
    fanCodename: 'USHA Tornado 9000-GT',
    pilotCallsign: 'Major Swivel',
    peakRpm: 348,
    maxSpeedKmh: 47.2,
    totalDistanceKm: 14.82,
    assignedTier: 'CERN Hadron Fanblade',
    recordedAt: '2026-09-11 20:45',
  },
  {
    id: 'flight-02',
    fanCodename: 'Dorm Death Trap MK.II',
    pilotCallsign: 'Cadet Wobbly',
    peakRpm: 285,
    maxSpeedKmh: 38.6,
    totalDistanceKm: 7.94,
    assignedTier: 'Ceiling Jet Engine',
    recordedAt: '2026-09-11 19:30',
  },
  {
    id: 'flight-03',
    fanCodename: 'Grandma’s 1978 Brass Unit',
    pilotCallsign: 'Prof. Humming',
    peakRpm: 48,
    maxSpeedKmh: 6.5,
    totalDistanceKm: 0.82,
    assignedTier: 'The Asthmatic Sloth',
    recordedAt: '2026-09-11 18:15',
  },
  {
    id: 'flight-04',
    fanCodename: 'Hostel Room 404 Overclocker',
    pilotCallsign: 'Cadet Turboshake',
    peakRpm: 412,
    maxSpeedKmh: 55.8,
    totalDistanceKm: 21.40,
    assignedTier: 'CERN Hadron Fanblade',
    recordedAt: '2026-09-11 21:10',
  },
];

export function getPersistedStandings(): FlightRecord[] {
  if (typeof window === 'undefined') return DEFAULT_STANDINGS;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return DEFAULT_STANDINGS;
  try {
    return JSON.parse(stored);
  } catch {
    return DEFAULT_STANDINGS;
  }
}

export function saveFlightRecord(record: FlightRecord): FlightRecord[] {
  const existing = getPersistedStandings();
  const updated = [record, ...existing].slice(0, 12);
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  }
  return updated;
}

export function clearStandings(): FlightRecord[] {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY);
  }
  return [];
}


export function exportStandingsCsv(records: FlightRecord[]): string {
  const headers = ['Flight ID', 'Fan Codename', 'Pilot Callsign', 'Peak RPM', 'Max Speed (km/h)', 'Total Distance (km)', 'Aero Tier', 'Centripetal G', 'Mach', 'Recorded At'];
  const rows = records.map((r) => [
    r.id,
    `"${r.fanCodename.replace(/"/g, '""')}"`,
    `"${r.pilotCallsign.replace(/"/g, '""')}"`,
    r.peakRpm,
    r.maxSpeedKmh,
    r.totalDistanceKm,
    `"${r.assignedTier}"`,
    r.centripetalG ?? 'N/A',
    r.machNumber ?? 'N/A',
    `"${r.recordedAt}"`,
  ]);
  return [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
}

