export type CalibrationMode = 'single_marker' | 'symmetrical_blades';

export interface KinematicsData {
  rpm: number;
  smoothedRpm: number;
  linearVelocityKmh: number;
  linearVelocityMph: number;
  cumulativeRotations: number;
  totalDistanceMeters: number;
  totalDistanceKm: number;
  moonProgressPct: number;
  everestClimbsEquivalent: number;
  centripetalG: number;
  machNumber: number;
  kineticEnergyJoules: number;
}

export interface CharacterTier {
  id: string;
  title: string;
  callsign: string;
  minRpm: number;
  maxRpm: number;
  description: string;
  hazardLevel: 'NOMINAL' | 'ELEVATED' | 'CRITICAL' | 'COSMIC';
}

export interface FlightRecord {
  id: string;
  fanCodename: string;
  pilotCallsign: string;
  peakRpm: number;
  maxSpeedKmh: number;
  totalDistanceKm: number;
  assignedTier: string;
  recordedAt: string;
  centripetalG?: number;
  machNumber?: number;
  durationSeconds?: number;
}

export interface TrackingRoi {
  x: number;
  y: number;
}

