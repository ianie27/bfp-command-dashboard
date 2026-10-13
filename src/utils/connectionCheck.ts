// src/utils/connectionCheck.ts
import { firestore, doc, getDoc } from '../services/firebase';

export const checkFirestoreConnection = async (): Promise<boolean> => {
  try {
    const testDoc = doc(firestore, 'test', 'connection_test');
    await getDoc(testDoc);
    return true;
  } catch (error) {
    console.warn('Firestore connection check failed:', error);
    return false;
  }
};

export const checkMobileAppConnection = async (): Promise<boolean> => {
  try {
    // Check if there are any fire_reports in the last 5 minutes
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const reportsRef = collection(firestore, 'fire_reports');
    const q = query(reportsRef, where('timestamp', '>=', fiveMinutesAgo));
    const snapshot = await getDocs(q);
    return true; // If we can query, we're connected
  } catch (error) {
    console.warn('Mobile app connection check failed:', error);
    return false;
  }
};

import { collection, query, where, getDocs } from '../services/firebase';