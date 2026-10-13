// ============================================================
// Admin Sensors Page — uses the SensorDetailsModal
// ============================================================

import React, { useEffect, useState } from 'react';

// ⭐ Firebase imports from your actual bootstrap
import {
  firestore,
  collection,
  onSnapshot,
  query,
  orderBy,
} from '../../services/firebase/firebase';

import { SensorDetailsModal, ThreatBadge } from '../../components/sensor';

export default function AdminSensors() {
  const [sensors, setSensors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedSensorId, setSelectedSensorId] = useState(null);

  // Real-time list of sensors
  useEffect(() => {
    const q = query(collection(firestore, 'iot_sensors'), orderBy('sensor_id'));
    const unsub = onSnapshot(q, (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setSensors(list);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  return (
    <div className="p-6 bg-slate-950 min-h-screen text-slate-100">
      <h1 className="text-2xl font-semibold mb-6">IoT Sensors</h1>

      {loading ? (
        <p className="text-slate-400">Loading sensors…</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {sensors.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedSensorId(s.sensor_id || s.id)}
              className="text-left rounded-lg border border-slate-700 bg-slate-800/50 p-4 hover:border-orange-400 transition-colors"
            >
              <div className="flex justify-between items-start">
                <div>
                  <p className="font-semibold text-white">
                    {s.sensor_id || s.id}
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {s.sensor_type || 'fire_gas_sensor'}
                  </p>
                </div>
                <ThreatBadge level={s.threat_level} />
              </div>

              <div className="mt-3 text-xs text-slate-400 space-y-1">
                <p>📍 {s.location_name || s.location || 'Unknown'}</p>
                {s.admin_name && <p>👤 {s.admin_name}</p>}
                {s.admin_phone && <p>📞 {s.admin_phone}</p>}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* ===================== MODAL ===================== */}
      {selectedSensorId && (
        <SensorDetailsModal
          sensorId={selectedSensorId}
          onClose={() => setSelectedSensorId(null)}
        />
      )}
    </div>
  );
}