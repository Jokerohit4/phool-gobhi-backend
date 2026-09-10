// Seed script: demo gyms near Sector 39, Gurugram so the customer app's
// "near you" / explore map has discoverable gyms in the launch area.
//
// There is no partner-service table in this DB (partnerId is a plain int, no
// FK), so seed gyms are assigned a fixed seed partner id. All seeded gyms are
// created approved + active + marketplace-enabled so the customer-facing
// /api/gyms endpoint (which filters on all three) returns them immediately.
//
// Run with:  npx prisma db seed   (from services/gym-service)
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

// Manually picked to sit within ~2-3km of Sector 39, Gurugram
// (28.4085, 77.0553) so the 40km discovery cutoff never drops them.
const SEED_GROUPS = [
  {
    partnerId: 1,
    name: 'FitZone Gym Sector 39',
    description:
      'Neighbourhood strength gym in Gurugram Sector 39 with cardio floor, free weights and personal training.',
    address: '76, Sector 39, Gurugram, Haryana 122003',
    city: 'Gurugram',
    state: 'Haryana',
    lat: 28.4087,
    lng: 77.0551,
    amenities: ['cardio', 'free weights', 'personal training', 'locker rooms'],
    phone: '+91 98110 12001',
    sessionPrice: 399,
    quotedPrice: 499,
    openTime: '06:00',
    closeTime: '22:00',
  },
  {
    partnerId: 1,
    name: 'Iron Temple Gym',
    description:
      'Hardcore lifting-focused gym with squat racks, deadlift platforms and group WOD classes.',
    address: 'Shop 13, Sector 38, Gurugram, Haryana 122001',
    city: 'Gurugram',
    state: 'Haryana',
    lat: 28.4136,
    lng: 77.043,
    amenities: ['free weights', 'crossfit', 'shower', 'supplement store'],
    phone: '+91 98110 12002',
    sessionPrice: 299,
    quotedPrice: 399,
    openTime: '05:00',
    closeTime: '23:00',
  },
  {
    partnerId: 1,
    name: 'Steel Strength Studio',
    description:
      'Functional training studio specialising in HIIT, strength and mobility in a small-group format.',
    address: 'First Floor, Sector 40 Market, Gurugram, Haryana 122001',
    city: 'Gurugram',
    state: 'Haryana',
    lat: 28.4068,
    lng: 77.0631,
    amenities: ['functional training', 'HIIT', 'group classes', 'air conditioning'],
    phone: '+91 98110 12003',
    sessionPrice: 450,
    quotedPrice: 599,
    openTime: '06:30',
    closeTime: '21:30',
  },
  {
    partnerId: 1,
    name: 'PowerHouse Gym Gurugram',
    description:
      'Full-service gym with cardio cinema, olympic platforms, steam room and zone-based training.',
    address: 'Block A, Sector 41, Gurugram, Haryana 122001',
    city: 'Gurugram',
    state: 'Haryana',
    lat: 28.4197,
    lng: 77.0618,
    amenities: ['cardio', 'free weights', 'steam room', 'locker rooms'],
    phone: '+91 98110 12004',
    sessionPrice: 350,
    openTime: '05:30',
    closeTime: '22:30',
  },
  {
    partnerId: 1,
    name: 'Bharat Fitness Club',
    description:
      'Affordable neighbourhood gym with cardio and free-weight zones popular with early-morning regulars.',
    address: 'Basement, Sector 42, Gurugram, Haryana 122001',
    city: 'Gurugram',
    state: 'Haryana',
    lat: 28.4271,
    lng: 77.0689,
    amenities: ['cardio', 'free weights', 'locker rooms'],
    phone: '+91 98110 12005',
    sessionPrice: 249,
    openTime: '06:00',
    closeTime: '22:00',
  },
  {
    partnerId: 1,
    name: 'Zen Fitness Hub',
    description:
      'Calm, clean studio combining yoga, pilates and light strength training with boutique amenities.',
    address: 'Shop 7, Sector 35, Gurugram, Haryana 122001',
    city: 'Gurugram',
    state: 'Haryana',
    lat: 28.4024,
    lng: 77.0486,
    amenities: ['yoga', 'pilates', 'light strength', 'air conditioning'],
    phone: '+91 98110 12006',
    sessionPrice: 500,
    quotedPrice: 650,
    openTime: '06:00',
    closeTime: '21:00',
  },
  {
    partnerId: 1,
    name: 'Momentum Fitness Gym',
    description:
      'Sports-oriented gym with turf lane, sleds, boxing bags and strength equipment for athletes.',
    address: 'Tower B, Sector 44, near Subhash Chowk, Gurugram, Haryana 122003',
    city: 'Gurugram',
    state: 'Haryana',
    lat: 28.4436,
    lng: 77.0521,
    amenities: ['turf', 'boxing', 'free weights', 'shower'],
    phone: '+91 98110 12007',
    sessionPrice: 400,
    openTime: '05:30',
    closeTime: '23:00',
  },
  {
    partnerId: 1,
    name: 'ActiveLife Gym Sector 44',
    description:
      'Community gym with cardio machines, strength racks and dedicated ladies-window timings.',
    address: 'Ground Floor, Sector 44 Market, Gurugram, Haryana 122003',
    city: 'Gurugram',
    state: 'Haryana',
    lat: 28.4382,
    lng: 77.0588,
    amenities: ['cardio', 'free weights', 'ladies hours', 'locker rooms'],
    phone: '+91 98110 12008',
    sessionPrice: 320,
    openTime: '06:00',
    closeTime: '22:00',
  },
];

async function main() {
  let created = 0;
  let existing = 0;

  for (const gym of SEED_GROUPS) {
    const already = await prisma.gym.findFirst({
      where: { name: gym.name, city: gym.city },
    });
    if (already) {
      existing++;
      console.log(`seed: already present, skipping "${gym.name}" (id ${already.id})`);
      continue;
    }

    const createdGym = await prisma.gym.create({
      data: {
        ...gym,
        // Seed gyms are deliberately live for the customer app.
        isApproved: true,
        isActive: true,
        marketplaceEnabled: true,
        brandDocs: [],
        established: 2020,
        slotDuration: 60,
        capacity: 20,
        rating: 4.5,
        ratingCount: 12,
      },
    });

    // Mirror createGym's convention: a single morning→close window on all 7
    // days so getOperatingHours never needs its fallback.
    await prisma.gymOperatingHours.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        gymId: createdGym.id,
        dayOfWeek,
        morningStart: gym.openTime,
        morningEnd: gym.closeTime,
      })),
    });

    created++;
    console.log(
      `seed: created "${createdGym.name}" id=${createdGym.id} @ (${createdGym.lat}, ${createdGym.lng})`,
    );
  }

  const total = await prisma.gym.count({ where: { city: 'Gurugram' } });
  console.log(`seed done: ${created} created, ${existing} already existed; total Gurugram gyms = ${total}`);
}

main()
  .catch((err) => {
    console.error('seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());