import { KinematicsData } from './types';

export function calculateKinematics(
  diameterMeters: number,
  rotations: number,
  currentRpm: number
): KinematicsData {
  const safeDiameter = Math.max(0.2, diameterMeters);
  const radius = safeDiameter / 2;
  const circumference = Math.PI * safeDiameter;
  
  // Linear velocities
  const linearVelocityMs = (currentRpm * circumference) / 60;
  const linearVelocityKmh = linearVelocityMs * 3.6;
  const linearVelocityMph = linearVelocityKmh * 0.621371;

  // Odometry
  const totalDistanceMeters = rotations * circumference;
  const totalDistanceKm = totalDistanceMeters / 1000;

  const moonDistanceMeters = 384400000;
  const everestHeightMeters = 8848.86;

  const moonProgressPct = (totalDistanceMeters / moonDistanceMeters) * 100;
  const everestClimbsEquivalent = totalDistanceMeters / everestHeightMeters;

  // Aerospace Kinematics: Centripetal Acceleration & G-force
  const omega = (2 * Math.PI * currentRpm) / 60; // rad/s
  const centripetalAcc = Math.pow(omega, 2) * radius; // m/s^2
  const centripetalG = centripetalAcc / 9.80665; // in G's

  // Mach number (Speed of sound at sea level approx 343 m/s)
  const machNumber = linearVelocityMs / 343.0;

  // Rotational Kinetic Energy: E_k = 0.5 * I * omega^2
  // Approximate standard ceiling fan blade rotor moment of inertia I = 0.18 kg*m^2
  const estimatedInertia = 0.18 * Math.pow(radius / 0.6, 2);
  const kineticEnergyJoules = 0.5 * estimatedInertia * Math.pow(omega, 2);

  return {
    rpm: Math.round(currentRpm),
    smoothedRpm: Math.round(currentRpm),
    linearVelocityKmh: Number(linearVelocityKmh.toFixed(1)),
    linearVelocityMph: Number(linearVelocityMph.toFixed(1)),
    cumulativeRotations: Math.round(rotations),
    totalDistanceMeters: Number(totalDistanceMeters.toFixed(1)),
    totalDistanceKm: Number(totalDistanceKm.toFixed(3)),
    moonProgressPct: Number(moonProgressPct.toFixed(7)),
    everestClimbsEquivalent: Number(everestClimbsEquivalent.toFixed(2)),
    centripetalG: Number(centripetalG.toFixed(1)),
    machNumber: Number(machNumber.toFixed(4)),
    kineticEnergyJoules: Number(kineticEnergyJoules.toFixed(1)),
  };
}

export interface ProjectedTrajectory {
  targetHours: number;
  linearVelocityMs: number;
  linearVelocityKmh: number;
  projectedDistanceMeters: number;
  projectedDistanceKm: number;
  projectedRotations: number;
  formulaString: string;
  substitutedFormula: string;
  landmarkEquivalent: string;
}

export function calculateProjectedTrajectory(
  diameterMeters: number,
  currentRpm: number,
  hours: number
): ProjectedTrajectory {
  const safeDiameter = Math.max(0.2, diameterMeters);
  const safeRpm = Math.max(0, currentRpm);
  const safeHours = Math.max(0.01, hours);

  const circumference = Math.PI * safeDiameter;
  const linearVelocityMs = (safeRpm * circumference) / 60;
  const linearVelocityKmh = linearVelocityMs * 3.6;

  const totalSeconds = safeHours * 3600;
  const projectedDistanceMeters = linearVelocityMs * totalSeconds;
  const projectedDistanceKm = projectedDistanceMeters / 1000;
  const projectedRotations = Math.round(safeRpm * (safeHours * 60));

  let landmarkEquivalent = 'Local room perimeter';
  if (projectedDistanceKm > 800) {
    landmarkEquivalent = 'Continental Highway Orbit';
  } else if (projectedDistanceKm > 350) {
    landmarkEquivalent = 'Intercity Express Transit';
  } else if (projectedDistanceKm > 100) {
    landmarkEquivalent = 'Regional Commute Trajectory';
  } else if (projectedDistanceKm > 42) {
    landmarkEquivalent = 'Full Marathon Distance';
  } else if (projectedDistanceKm > 10) {
    landmarkEquivalent = 'Cross-City Aerodynamic Glide';
  } else if (projectedDistanceKm > 1) {
    landmarkEquivalent = 'Multiple Campus Laps';
  }

  const formulaString = 'd = v · t = ((RPM · π · D) / 60) · t';
  const substitutedFormula = `d = ((${safeRpm} · 3.14 · ${safeDiameter.toFixed(1)}m) / 60) · ${Math.round(totalSeconds)}s = ${projectedDistanceKm.toFixed(2)} km`;

  return {
    targetHours: safeHours,
    linearVelocityMs: Number(linearVelocityMs.toFixed(2)),
    linearVelocityKmh: Number(linearVelocityKmh.toFixed(1)),
    projectedDistanceMeters: Number(projectedDistanceMeters.toFixed(1)),
    projectedDistanceKm: Number(projectedDistanceKm.toFixed(2)),
    projectedRotations,
    formulaString,
    substitutedFormula,
    landmarkEquivalent,
  };
}


