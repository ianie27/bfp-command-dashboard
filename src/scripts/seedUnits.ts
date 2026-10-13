// src/scripts/seedUnits.ts
import { firestore } from '../services/firebase';
import { collection, addDoc, getDocs, serverTimestamp } from 'firebase/firestore';

const FIRE_STATION_LOCATION = {
  lat: 18.26031900849349,
  lng: 121.99689251349221,
};

export const seedDefaultUnits = async () => {
  const unitsRef = collection(firestore, 'units');
  const existing = await getDocs(unitsRef);

  // Only seed if empty — avoids duplicates
  if (!existing.empty) {
    console.log('✅ Units already exist — skipping seed');
    return;
  }

  const defaultUnits = [
    {
      unit_id: 'UNIT-001',
      unit_code: 'U1',
      unit_name: 'Unit 1',
      status: 'Available',
      latitude: FIRE_STATION_LOCATION.lat,
      longitude: FIRE_STATION_LOCATION.lng,
      current_incident_id: null,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    },
    {
      unit_id: 'UNIT-002',
      unit_code: 'U2',
      unit_name: 'Unit 2',
      status: 'Available',
      latitude: FIRE_STATION_LOCATION.lat,
      longitude: FIRE_STATION_LOCATION.lng,
      current_incident_id: null,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    },
  ];

  for (const unit of defaultUnits) {
    await addDoc(unitsRef, unit);
    console.log(`🚒 Seeded ${unit.unit_name}`);
  }

  console.log('✅ Default units seeded');
};