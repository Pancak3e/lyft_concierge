const RIDE_KEY = "pendingLyftRide";
const STATUS_KEY = "lyftCaptureStatus";
const CRM_TOKEN_KEY = "crmAuthToken";
const COMPLETED_RIDES_KEY = "completedLyftRides";
const SETTINGS_KEY = "settings";
const CONTENT_SCRIPT_ID = "lyft-rides-configured-sites";
const RIDE_TTL_MS = 12 * 60 * 60 * 1000;
const COMPLETED_RIDE_TTL_MS = 12 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const activeCannedJobRequests = new Set();
let settingsCache = null;
let registrationQueue = Promise.resolve();

initializeExtension().catch((error) => console.warn("Lyft Rides initialization failed:", error));

chrome.runtime.onInstalled.addListener((details) => {
  initializeExtension().catch(() => {});
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  initializeExtension().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes[SETTINGS_KEY]) return;
  settingsCache = sanitizeSettings(changes[SETTINGS_KEY].newValue);
  queueContentScriptRegistration(settingsCache).catch(() => {});
});

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!settingsCache?.crmUrl || !urlUsesConfiguredOrigin(details.url, settingsCache.crmUrl)) return;
    const tokenHeader = details.requestHeaders?.find(
      (header) => header.name.toLowerCase() === "x-auth-token"
    );
    if (!tokenHeader?.value) return;
    chrome.storage.session.set({
      [CRM_TOKEN_KEY]: {
        value: tokenHeader.value,
        capturedAt: Date.now()
      }
    });
  },
  { urls: ["https://*/*", "http://*/*"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_SETTINGS") {
    getSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "SAVE_SETTINGS") {
    saveSettings(message.settings)
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    return true;
  }

  if (message?.type === "LYFT_CAPTURE_ACTIVE") {
    saveLyftCaptureStatus(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "GET_LYFT_STATUS") {
    chrome.storage.session.get(STATUS_KEY)
      .then((stored) => sendResponse({ ok: true, status: stored[STATUS_KEY] || null }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ADD_LYFT_CANNED_JOB") {
    addLyftCannedJob(message, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    return true;
  }

  if (message?.type === "SAVE_LYFT_RIDE") {
    saveRide(message.ride, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "GET_LYFT_RIDE") {
    getRide()
      .then((ride) => sendResponse({ ok: true, ride }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "CLEAR_LYFT_RIDE") {
    completePendingRide()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "SHOW_LYFT_MATCH_NOTIFICATION") {
    showMatchNotification(message.ride, message.matchedBy)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});

async function saveLyftCaptureStatus(message, sender) {
  const settings = await getSettings();
  const sourceUrl = message.url || sender.tab?.url || sender.url || "";
  if (!urlIsWithinConfiguredPath(sourceUrl, settings.lyftUrl)) {
    throw new Error("Ride capture was received from an unconfigured page.");
  }
  await chrome.storage.session.set({
    [STATUS_KEY]: {
      activeAt: Date.now(),
      url: sourceUrl,
      fieldCount: Number(message.fieldCount) || 0,
      capturedFields: Array.isArray(message.capturedFields) ? message.capturedFields : []
    }
  });
}

async function saveRide(rawRide) {
  const settings = await getSettings();
  if (!urlIsWithinConfiguredPath(rawRide?.sourceUrl, settings.lyftUrl)) {
    throw new Error("Ride details were received from an unconfigured page.");
  }
  const update = sanitizeRide(rawRide);
  if (
    !update.firstName && !update.lastName && !update.phone &&
    !update.pickup && !update.dropoff && !update.price && !update.distance
  ) {
    throw new Error("No customer or ride details were found on the Lyft page.");
  }

  const stored = await chrome.storage.session.get([RIDE_KEY, COMPLETED_RIDES_KEY]);
  const existing = stored[RIDE_KEY];
  const ride = {
    ...existing,
    ...Object.fromEntries(
      Object.entries(update).filter(([key, value]) => key === "sourceUrl" || Boolean(value))
    )
  };
  const fingerprint = rideFingerprint(ride);
  const completedRides = pruneCompletedRides(stored[COMPLETED_RIDES_KEY]);
  if (fingerprint && completedRides.some((entry) => entry.fingerprint === fingerprint)) {
    await chrome.storage.session.remove(RIDE_KEY);
    await chrome.storage.session.set({ [COMPLETED_RIDES_KEY]: completedRides });
    await chrome.action.setBadgeText({ text: "" });
    return { ride: null, ignored: true };
  }

  ride.capturedAt = Date.now();
  ride.id = existing?.id || `${ride.capturedAt}-${Math.random().toString(36).slice(2, 8)}`;
  await chrome.storage.session.set({ [RIDE_KEY]: ride });
  await chrome.action.setBadgeBackgroundColor({ color: "#5b21b6" });
  await chrome.action.setBadgeText({ text: "1" });
  return { ride, ignored: false };
}

async function completePendingRide() {
  const stored = await chrome.storage.session.get([RIDE_KEY, COMPLETED_RIDES_KEY]);
  const ride = stored[RIDE_KEY];
  const fingerprint = rideFingerprint(ride);
  const completedRides = pruneCompletedRides(stored[COMPLETED_RIDES_KEY]);
  if (fingerprint) {
    completedRides.unshift({ fingerprint, completedAt: Date.now() });
  }
  await chrome.storage.session.set({
    [COMPLETED_RIDES_KEY]: completedRides.slice(0, 20)
  });
  await chrome.storage.session.remove(RIDE_KEY);
  await chrome.action.setBadgeText({ text: "" });
}

function pruneCompletedRides(value) {
  if (!Array.isArray(value)) return [];
  const cutoff = Date.now() - COMPLETED_RIDE_TTL_MS;
  return value.filter((entry) =>
    entry && typeof entry.fingerprint === "string" && entry.completedAt >= cutoff
  );
}

function rideFingerprint(ride) {
  if (!ride) return "";
  const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const identity = [
    normalize(ride.firstName),
    normalize(ride.lastName),
    String(ride.phone || "").replace(/\D/g, "").slice(-10),
    normalize(ride.pickup),
    normalize(ride.dropoff)
  ];
  if (!identity.some(Boolean)) {
    identity.push(normalize(ride.price), normalize(ride.distance));
  }
  return identity.join("|");
}

async function getRide() {
  const stored = await chrome.storage.session.get(RIDE_KEY);
  const ride = stored[RIDE_KEY];
  if (!ride || Date.now() - ride.capturedAt > RIDE_TTL_MS) {
    await chrome.storage.session.remove(RIDE_KEY);
    await chrome.action.setBadgeText({ text: "" });
    return null;
  }
  return ride;
}

async function showMatchNotification(ride, matchedBy) {
  if (!ride?.id) return;

  const name = [ride.firstName, ride.lastName].filter(Boolean).join(" ") || "Customer";
  const details = [
    ride.price && `Estimated price: ${ride.price}`,
    ride.demandStatus && `Demand: ${ride.demandStatus}`,
    ride.distance && `Distance: ${ride.distance}`,
    ride.phone && `Phone: ${ride.phone}`,
    ride.pickup && `Pickup: ${ride.pickup}`,
    ride.dropoff && `Drop-off: ${ride.dropoff}`
  ].filter(Boolean);

  await chrome.notifications.create(`lyft-match-${ride.id}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title: `Add Lyft ride to ${name}'s ticket`,
    message: details.join("\n").slice(0, 480) || `Matched this repair order by ${matchedBy}.`,
    priority: 2
  });
}

async function addLyftCannedJob(message, sender) {
  const settings = await getSettings();
  if (!settings.crmUrl || !settings.lyftUrl || !settings.cannedJobId) {
    throw new Error("Open the extension settings and complete the CRM configuration first.");
  }
  const repairOrderId = String(message.repairOrderId || "");
  const rideId = String(message.rideId || "");
  const rideCostCents = parseRidePriceToCents(message.ridePrice);
  const tabId = sender.tab?.id;
  if (!/^\d+$/.test(repairOrderId) || !Number.isInteger(tabId)) {
    throw new Error("The CRM repair-order number could not be determined.");
  }
  const liveLocation = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => location.href
  });
  const liveUrl = new URL(liveLocation?.[0]?.result || "https://invalid.local");
  const configuredCrmUrl = new URL(settings.crmUrl);
  const liveRepairOrderId = liveUrl.pathname.match(/\/repair-orders\/(\d+)/i)?.[1];
  if (
    liveUrl.origin !== configuredCrmUrl.origin ||
    !pathIsWithin(liveUrl.pathname, configuredCrmUrl.pathname) ||
    liveRepairOrderId !== repairOrderId
  ) {
    throw new Error("The active CRM repair order does not match this request.");
  }
  if (!Number.isInteger(rideCostCents) || rideCostCents <= 0) {
    throw new Error("The Lyft price was not captured. Return to Lyft so the estimate can be read, then try again.");
  }

  const operationKey = `${repairOrderId}:${rideId || "pending"}`;
  const stored = await chrome.storage.session.get([CRM_TOKEN_KEY, "addedLyftJobs"]);
  const completed = stored.addedLyftJobs || {};
  const previousState = completed[operationKey];
  const operation = typeof previousState === "object" && previousState
    ? previousState
    : previousState
      ? { cannedAddedAt: previousState, costUpdatedAt: null, sublet: null }
      : { cannedAddedAt: null, costUpdatedAt: null, sublet: null };
  if (operation.costUpdatedAt) return { alreadyAdded: true, costCents: rideCostCents };
  if (activeCannedJobRequests.has(operationKey)) {
    throw new Error("The Lyft canned job and cost are already being added.");
  }

  const tokenRecord = stored[CRM_TOKEN_KEY];
  if (
    !tokenRecord?.value ||
    !tokenRecord.capturedAt ||
    Date.now() - tokenRecord.capturedAt > TOKEN_TTL_MS
  ) {
    throw new Error("CRM authentication is not ready. Refresh this CRM page and try again.");
  }

  activeCannedJobRequests.add(operationKey);
  try {
    if (!operation.cannedAddedAt) {
      const cannedResult = await postJsonInCrmTab({
        tabId,
        url: new URL(`/api/repair-order/${repairOrderId}/canned`, configuredCrmUrl.origin).href,
        token: tokenRecord.value,
        body: {
          jobs: [],
          sublets: [settings.cannedJobId],
          smartJobLabor: [],
          selectedFluidIds: []
        },
        repairOrderId,
        findCreatedSublet: true,
        jobKeyword: settings.jobKeyword
      });
      if (!cannedResult?.ok) {
        throw new Error(formatCrmError(cannedResult, "The Lyft canned job could not be added."));
      }

      operation.cannedAddedAt = Date.now();
      operation.sublet = cannedResult.sublet || null;
      completed[operationKey] = operation;
      await chrome.storage.session.set({ addedLyftJobs: completed });
    }

    if (!operation.sublet) {
      throw new Error(
        "The canned job was added, but the CRM did not return its new sublet details, so the cost was not changed. Do not click again; refresh the repair order and verify the Lyft job."
      );
    }

    const sublet = structuredClone(operation.sublet);
    const items = Array.isArray(sublet.items) ? sublet.items : [];
    const keyword = settings.jobKeyword.toLowerCase();
    const targetItem = items.find((item) => String(item?.name || "").toLowerCase().includes(keyword)) ||
      (items.length === 1 ? items[0] : null);
    if (!targetItem) {
      throw new Error("The Lyft canned job was added, but its cost item could not be identified.");
    }
    targetItem.cost = rideCostCents;

    const costResult = await postJsonInCrmTab({
      tabId,
      url: new URL("/api/sublet", configuredCrmUrl.origin).href,
      token: tokenRecord.value,
      body: sublet,
      repairOrderId,
      findCreatedSublet: false,
      jobKeyword: settings.jobKeyword
    });
    if (!costResult?.ok) {
      throw new Error(formatCrmError(
        costResult,
        "The Lyft job was added, but the CRM did not save its cost."
      ));
    }

    operation.costUpdatedAt = Date.now();
    operation.costCents = rideCostCents;
    operation.sublet = null;
    completed[operationKey] = operation;
    await chrome.storage.session.set({ addedLyftJobs: completed });
    return { alreadyAdded: false, status: costResult.status, costCents: rideCostCents };
  } finally {
    activeCannedJobRequests.delete(operationKey);
  }
}

async function postJsonInCrmTab({
  tabId,
  url,
  token,
  body,
  repairOrderId,
  findCreatedSublet,
  jobKeyword
}) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (
      requestUrl,
      authToken,
      requestBody,
      expectedRepairOrderId,
      shouldFindSublet,
      expectedKeyword
    ) => {
      try {
        const response = await fetch(requestUrl, {
          method: "POST",
          credentials: "include",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-auth-token": authToken
          },
          body: JSON.stringify(requestBody)
        });
        const responseText = await response.text();
        let responseData = null;
        try {
          responseData = responseText ? JSON.parse(responseText) : null;
        } catch (_) {
          responseData = null;
        }

        let sublet = null;
        if (response.ok && shouldFindSublet && responseData) {
          const stack = [responseData];
          let inspected = 0;
          while (stack.length && inspected < 15000) {
            const value = stack.pop();
            inspected += 1;
            if (!value || typeof value !== "object") continue;
            const itemNames = Array.isArray(value.items)
              ? value.items.map((item) => String(item?.name || "")).join(" ")
              : "";
            const isExpectedRepairOrder =
              !value.repairOrderId || String(value.repairOrderId) === String(expectedRepairOrderId);
            const looksLikeLyftSublet =
              Array.isArray(value.items) &&
              isExpectedRepairOrder &&
              `${value.name || ""} ${itemNames}`.toLowerCase().includes(
                String(expectedKeyword || "lyft").toLowerCase()
              );
            if (looksLikeLyftSublet) {
              sublet = value;
              break;
            }
            for (const child of Object.values(value)) {
              if (child && typeof child === "object") stack.push(child);
            }
          }
        }

        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          errorText: response.ok ? "" : responseText.slice(0, 300),
          sublet
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          statusText: error instanceof Error ? error.message : String(error),
          errorText: "",
          sublet: null
        };
      }
    },
    args: [url, token, body, repairOrderId, findCreatedSublet, jobKeyword]
  });
  return injection?.[0]?.result || null;
}

function parseRidePriceToCents(value) {
  const match = String(value || "").replace(/,/g, "").match(/\d+(?:\.\d{1,2})?/);
  if (!match) return null;
  const amount = Number(match[0]);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function formatCrmError(result, fallback) {
  if (!result) return fallback;
  if (result.status) {
    return `${fallback} The CRM returned ${result.status}${result.statusText ? ` ${result.statusText}` : ""}.`;
  }
  return `${fallback}${result.statusText ? ` ${result.statusText}` : ""}`;
}

async function initializeExtension() {
  settingsCache = await getSettings();
  await queueContentScriptRegistration(settingsCache);
}

async function getSettings() {
  if (settingsCache) return settingsCache;
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  settingsCache = sanitizeSettings(stored[SETTINGS_KEY]);
  return settingsCache;
}

async function saveSettings(value) {
  const settings = sanitizeSettings(value);
  if (!settings.crmUrl || !settings.lyftUrl) {
    throw new Error("Enter valid CRM and Lyft Concierge URLs.");
  }
  if (!Number.isInteger(settings.cannedJobId) || settings.cannedJobId <= 0) {
    throw new Error("Enter a valid canned job ID.");
  }
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
  await chrome.storage.session.remove([
    CRM_TOKEN_KEY,
    STATUS_KEY,
    RIDE_KEY,
    COMPLETED_RIDES_KEY,
    "addedLyftJobs"
  ]);
  await chrome.action.setBadgeText({ text: "" });
  settingsCache = settings;
  await queueContentScriptRegistration(settings);
  return settings;
}

function sanitizeSettings(value = {}) {
  return {
    crmUrl: normalizeConfiguredUrl(value.crmUrl, "crm"),
    lyftUrl: normalizeConfiguredUrl(value.lyftUrl, "lyft"),
    cannedJobId: Number.isInteger(Number(value.cannedJobId))
      ? Number(value.cannedJobId)
      : null,
    jobKeyword: String(value.jobKeyword || "Lyft").replace(/\s+/g, " ").trim().slice(0, 80) || "Lyft"
  };
}

function normalizeConfiguredUrl(value, kind) {
  try {
    const url = new URL(String(value || "").trim());
    if (!/^https?:$/.test(url.protocol)) return "";
    if (kind === "crm") {
      const repairOrderPrefix = url.pathname.match(/^(.*?)\/repair-orders(?:\/|$)/i)?.[1];
      if (repairOrderPrefix) url.pathname = repairOrderPrefix;
    }
    if (kind === "lyft") {
      const organizationPrefix = url.pathname.match(/^(\/concierge\/organization\/[^/]+)/i)?.[1];
      if (organizationPrefix) url.pathname = organizationPrefix;
    }
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch (_) {
    return "";
  }
}

async function registerConfiguredContentScript(settings) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  } catch (_) {
    // The script has not been registered yet.
  }
  const urls = [settings.crmUrl, settings.lyftUrl].filter(Boolean);
  if (!urls.length) return;
  const matches = [...new Set(urls.map(originPattern))];
  await chrome.scripting.registerContentScripts([{
    id: CONTENT_SCRIPT_ID,
    matches,
    js: ["content.js"],
    runAt: "document_idle",
    persistAcrossSessions: true
  }]);
}

function queueContentScriptRegistration(settings) {
  registrationQueue = registrationQueue
    .catch(() => {})
    .then(() => registerConfiguredContentScript(settings));
  return registrationQueue;
}

function originPattern(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.host}/*`;
}

function urlUsesConfiguredOrigin(candidate, configured) {
  try {
    return new URL(candidate).origin === new URL(configured).origin;
  } catch (_) {
    return false;
  }
}

function urlIsWithinConfiguredPath(candidate, configured) {
  if (!candidate || !configured) return false;
  try {
    const current = new URL(candidate);
    const expected = new URL(configured);
    return current.origin === expected.origin && pathIsWithin(current.pathname, expected.pathname);
  } catch (_) {
    return false;
  }
}

function pathIsWithin(candidatePath, configuredPath) {
  const prefix = configuredPath.replace(/\/$/, "");
  return !prefix || prefix === "/" || candidatePath === prefix || candidatePath.startsWith(`${prefix}/`);
}

function sanitizeRide(value = {}) {
  const clean = (input, maxLength) =>
    typeof input === "string" ? input.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";

  return {
    firstName: clean(value.firstName, 80),
    lastName: clean(value.lastName, 80),
    phone: clean(value.phone, 40),
    pickup: clean(value.pickup, 240),
    dropoff: clean(value.dropoff, 240),
    price: clean(value.price, 40),
    demandStatus: clean(value.demandStatus, 80),
    distance: clean(value.distance, 60),
    sourceUrl: clean(value.sourceUrl, 500)
  };
}
