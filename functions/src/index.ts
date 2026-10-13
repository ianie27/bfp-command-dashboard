import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { logger } from "firebase-functions";

// ⭐ CRITICAL: Set region to match your Firestore location.
// If your Firestore is in asia-southeast1, this MUST match.
// Change to match your project's Firestore region.
setGlobalOptions({
  maxInstances: 10,
  region: "asia-southeast1", // ⭐ CHANGE THIS to your Firestore region
});

initializeApp();
const db = getFirestore();

/**
 * Triggers when a dispatcher creates a unit_dispatch document.
 * Sends FCM push notification to the target response unit.
 */
export const sendDispatchNotification = onDocumentCreated(
  {
    document: "unit_dispatches/{dispatchId}",
    region: "asia-southeast1", // ⭐ MUST match Firestore region
  },
  async (event) => {
    const snapshot = event.data;
    const dispatchId = event.params.dispatchId;

    if (!snapshot) {
      logger.error("❌ No dispatch document data for", dispatchId);
      return;
    }

    const dispatch = snapshot.data();
    const unitId = dispatch.target_unit_id;
    const incidentId = dispatch.incident_id;

    logger.info(`📨 Dispatch created: ${dispatchId}`, {
      unitId,
      incidentId,
      targetUnitName: dispatch.target_unit_name,
      routeDist: dispatch.route_distance_text,
      routeEta: dispatch.route_eta_text,
    });

    if (!unitId || !incidentId) {
      logger.error("❌ Missing unitId or incidentId", { unitId, incidentId });
      await snapshot.ref.update({
        notification_status: "invalid_dispatch",
        notification_error: "Missing unitId or incidentId",
        notification_attempted_at: new Date(),
      });
      return;
    }

    // ------------------------------------------------------------
    // FETCH UNIT — try BOTH document ID and unit_id field
    // ------------------------------------------------------------
    let unitSnap = await db.collection("units").doc(unitId).get();
    let unitData: FirebaseFirestore.DocumentData | undefined;

    if (unitSnap.exists) {
      unitData = unitSnap.data();
      logger.info(`✅ Found unit by doc ID: ${unitId}`);
    } else {
      // Fallback: query by unit_id field
      logger.warn(`⚠️ Unit doc ${unitId} not found by ID — querying by unit_id field`);
      const q = await db
        .collection("units")
        .where("unit_id", "==", unitId)
        .limit(1)
        .get();

      if (!q.empty) {
        unitSnap = q.docs[0];
        unitData = unitSnap.data();
        logger.info(`✅ Found unit by field query: ${unitSnap.id}`);
      }
    }

    if (!unitData) {
      logger.error(`❌ Unit ${unitId} does not exist in Firestore`);
      await snapshot.ref.update({
        notification_status: "unit_not_found",
        notification_error: `Unit ${unitId} not found`,
        notification_attempted_at: new Date(),
      });
      return;
    }

    const fcmToken = unitData.fcm_token as string | undefined;

    if (!fcmToken || fcmToken.trim() === "") {
      logger.warn(`⚠️ No FCM token for unit ${unitId}`);
      await snapshot.ref.update({
        notification_status: "no_token",
        notification_error: "Response unit has no FCM token. App must be opened and permissions granted.",
        notification_attempted_at: new Date(),
      });
      return;
    }

    // ------------------------------------------------------------
    // BUILD NOTIFICATION
    // ------------------------------------------------------------
    const unitName = dispatch.target_unit_name || unitData.unit_name || unitId;
    const routeDist = dispatch.route_distance_text || "—";
    const routeEta = dispatch.route_eta_text || "—";

    const title = "🚨 EMBERNET DISPATCH";
    const body = `${unitName} → ${incidentId} (${routeDist}, ETA ${routeEta})`;

    const data: Record<string, string> = {
      type: "DISPATCH",
      dispatch_id: dispatchId,
      incident_id: String(incidentId),
      unit_id: String(unitId),

      latitude: String(dispatch.latitude ?? ""),
      longitude: String(dispatch.longitude ?? ""),
      location_address: String(dispatch.location_address ?? ""),
      threat_level: String(dispatch.threat_level ?? "RED"),
      caller_name: String(dispatch.caller_name ?? ""),
      caller_phone: String(dispatch.caller_phone ?? ""),
      dispatcher_name: String(dispatch.dispatcher_name ?? ""),

      route_distance_text: String(routeDist),
      route_eta_text: String(routeEta),
      route_distance_km: String(dispatch.route_distance_km ?? ""),
      route_eta_minutes: String(dispatch.route_eta_minutes ?? ""),

      status: "pending",
      dispatched_at: String(dispatch.dispatched_at?.toMillis?.() ?? Date.now()),
    };

    // ------------------------------------------------------------
    // SEND FCM
    // ------------------------------------------------------------
    try {
      const message = {
        token: fcmToken,
        notification: { title, body },
        data,
        android: {
          priority: "high" as const,
          ttl: 300000, // 5 minutes
          notification: {
            channelId: "dispatch_channel",
            priority: "max" as const,
            sound: "default",
            defaultVibrateTimings: true,
            visibility: "public" as const,
          },
        },
      };

      const response = await getMessaging().send(message);

      logger.info(`✅ FCM sent to ${unitName} (${unitId}): ${response}`);

      await snapshot.ref.update({
        notification_status: "sent",
        notification_sent_at: new Date(),
        notification_message_id: response,
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);

      // ⭐ If token is stale/invalid, clear it so app re-registers
      if (
        errMsg.includes("registration-token-not-registered") ||
        errMsg.includes("invalid-registration-token") ||
        errMsg.includes("Requested entity was not found")
      ) {
        logger.warn(`🧹 Clearing stale FCM token for ${unitId}`);
        try {
          await unitSnap.ref.update({
            fcm_token: null,
            fcm_token_cleared_at: new Date(),
          });
        } catch (clearErr) {
          logger.error("Failed to clear stale token:", clearErr);
        }
      }

      logger.error(`❌ FCM failed for ${unitId}:`, error);

      await snapshot.ref.update({
        notification_status: "failed",
        notification_error: errMsg,
        notification_failed_at: new Date(),
      });
    }
  }
);