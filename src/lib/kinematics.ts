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

