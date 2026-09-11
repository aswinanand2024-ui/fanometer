import { CharacterTier } from './types';

export const CHARACTER_TIERS: CharacterTier[] = [
  {
    id: 'tier-relic',
    title: 'Dormant Kinetic Relic',
    callsign: 'RELIC-ZERO',
    minRpm: 0,
    maxRpm: 15,
    description: 'Complete aerodynamic apathy. Functions purely as an aesthetic ceiling dust accumulator.',
    hazardLevel: 'NOMINAL',
  },
  {
    id: 'tier-sloth',
    title: 'The Asthmatic Sloth',
    callsign: 'SLOTH-ONE',
    minRpm: 16,
    maxRpm: 75,
    description: 'Pushes individual air molecules with extreme reluctance. A gentle exhale moves more air.',
    hazardLevel: 'NOMINAL',
  },
  {
    id: 'tier-diplomat',
    title: 'The Breeze Diplomat',
    callsign: 'DIPLOMAT-TWO',
    minRpm: 76,
    maxRpm: 210,
    description: 'Polite, socially compliant airflow. Keeps tea warm and invoices safely pinned to desks.',
    hazardLevel: 'ELEVATED',
  },
  {
    id: 'tier-jet',
    title: 'Ceiling Jet Engine',
    callsign: 'JET-THREE',
    minRpm: 211,
    maxRpm: 330,
    description: 'Mounting bolts are sweating. Structural tremors observed. Prepare your room for takeoff.',
    hazardLevel: 'CRITICAL',
  },
  {
    id: 'tier-hadron',
    title: 'CERN Hadron Fanblade',
    callsign: 'HADRON-OMEGA',
    minRpm: 331,
    maxRpm: 9999,
    description: 'Warning: Relativistic bedroom airflow. Air friction is ionizing oxygen. May tear space-time.',
    hazardLevel: 'COSMIC',
  },
];

export function resolveTier(rpm: number): CharacterTier {
  const match = CHARACTER_TIERS.find((tier) => rpm >= tier.minRpm && rpm <= tier.maxRpm);
  return match || CHARACTER_TIERS[CHARACTER_TIERS.length - 1];
}
