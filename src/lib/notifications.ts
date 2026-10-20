import type { AgentStatus } from "../../shared/protocol.ts";
import { ENDED_NOTIFICATION_BODY, paneNotificationTag, statusNotificationBody } from "../../shared/notify-policy.ts";

/**
 * Tab alerts: Web Notifications for pane status transitions while this page is open
 * but hidden. A device with a push subscription (lib/push.ts) gets the same alerts from
 * the server instead, and App skips these. Notification exists only in secure contexts
 * (https or localhost) - a plain-http LAN deployment reports "unsupported", and the bell
 * there switches only the in-app alerts.
 *
 * The transition policy is shared with the server (shared/notify-policy.ts).
 */

export { alertStatus, alertsAllow, shouldNotifyStatus } from "../../shared/notify-policy.ts";

export type NotificationState = "unsupported" | "default" | "granted" | "denied";

export function notificationState(): NotificationState {
  if (typeof globalThis.Notification === "undefined") return "unsupported";
  return globalThis.Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationState> {
  if (typeof globalThis.Notification === "undefined") return "unsupported";
  const permission = await globalThis.Notification.requestPermission();
  return permission === "granted" ? "granted" : permission === "denied" ? "denied" : "default";
}

/**
 * Shown through the service worker when there is one: Android Chrome has no
 * `new Notification()`, and the worker's notificationclick (public/sw.js) selects the
 * pane. The constructor is the fallback for a page without a worker.
 */
async function show(paneId: string, title: string, body: string, onClick?: () => void, machineId = "local", workspaceId?: string): Promise<void> {
  if (typeof globalThis.Notification === "undefined") return;
  if (globalThis.Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && !document.hidden) return; // visible tab: the UI already shows it
  const tag = paneNotificationTag(paneId, machineId);
  const alertId = crypto.randomUUID();
  const options: NotificationOptions = { body, tag, data: { pane_id: paneId, machine_id: machineId, ...(workspaceId ? { workspace_id: workspaceId } : {}), alert_id: alertId }, icon: "/icons/icon-192.png?v=ram1" };
  try {
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (registration?.active) {
      await registration.showNotification(title, options);
      // iOS keeps the pane's earlier alerts despite the tag: close them as a push does (public/sw.js)
      for (const older of await registration.getNotifications({ tag })) {
        if ((older.data as { alert_id?: string } | null)?.alert_id !== alertId) older.close();
      }
      return;
    }
    const notification = new globalThis.Notification(title, options);
    notification.addEventListener("click", () => {
      window.focus();
      onClick?.();
    });
  } catch {
    /* no way to show it here: the sidebar badge still carries the change */
  }
}

/**
 * The workspace on screen has been seen: close the delivered alerts (pushed or shown by a
 * tab) about its panes, by the machine and workspace they name, and leave the rest. Native
 * apps clear what was read; on iOS nothing else does, and it refuses to close an alert for
 * 30 s after showing it.
 */
export async function clearWorkspaceNotifications(machineId: string, workspaceId: string): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    for (const notification of (await registration?.getNotifications()) ?? []) {
      const data = notification.data as { machine_id?: string; workspace_id?: string | null } | null;
      if ((data?.machine_id || "local") === machineId && data?.workspace_id === workspaceId) notification.close();
    }
  } catch {
    /* no worker or no getNotifications here: nothing to clear */
  }
}

/** `workspaceId`: the pane's workspace, as the server's push names it (server/push.ts), so a tap after the pane ends opens it. */
export function showPaneStatusNotification(paneId: string, title: string, status: AgentStatus, onClick?: () => void, machineId = "local", workspaceId?: string): Promise<void> {
  return show(paneId, title, statusNotificationBody(status), onClick, machineId, workspaceId);
}

export function showPaneEndedNotification(paneId: string, title: string, onClick?: () => void, machineId = "local", workspaceId?: string): Promise<void> {
  return show(paneId, title, ENDED_NOTIFICATION_BODY, onClick, machineId, workspaceId);
}
