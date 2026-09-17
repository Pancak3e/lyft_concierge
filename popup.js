document.addEventListener("DOMContentLoaded", loadRide);
document.getElementById("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

async function loadRide() {
  const [response, statusResponse, settingsResponse] = await Promise.all([
    chrome.runtime.sendMessage({ type: "GET_LYFT_RIDE" }),
    chrome.runtime.sendMessage({ type: "GET_LYFT_STATUS" }),
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" })
  ]);
  const ride = response?.ride;
  document.getElementById(ride ? "ride" : "empty").hidden = false;
  if (!ride) {
    renderCaptureStatus(statusResponse?.status, settingsResponse?.settings);
    return;
  }

  document.getElementById("name").textContent =
    [ride.firstName, ride.lastName].filter(Boolean).join(" ") || "Pending customer";
  if (ride.price || ride.distance || ride.demandStatus) {
    document.getElementById("estimate").hidden = false;
    document.getElementById("estimate-main").textContent =
      [ride.price, ride.distance].filter(Boolean).join(" · ") || "Ride estimate";
    document.getElementById("demand").textContent = ride.demandStatus || "";
  }
  setValue("phone", ride.phone);
  setValue("pickup", ride.pickup);
  setValue("dropoff", ride.dropoff);
  document.getElementById("age").textContent = `Saved ${formatAge(Date.now() - ride.capturedAt)} ago`;
  document.getElementById("clear").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "CLEAR_LYFT_RIDE" });
    window.close();
  });
}

function renderCaptureStatus(status, settings) {
  const target = document.getElementById("capture-status");
  if (!settings?.crmUrl || !settings?.lyftUrl || !settings?.cannedJobId) {
    target.textContent = "Open Settings to configure your CRM, Lyft Concierge page, and canned job.";
    return;
  }
  if (!status || Date.now() - status.activeAt > 15000) {
    target.textContent = "The extension is not connected to Lyft yet. Refresh the Lyft Concierge tab once.";
    return;
  }

  if (!status.fieldCount) {
    target.textContent = "Connected to Lyft, but no populated ride fields are visible yet.";
    return;
  }

  const labels = {
    firstName: "first name", lastName: "last name", phone: "phone",
    pickup: "pickup", dropoff: "drop-off", price: "price",
    demandStatus: "demand status", distance: "distance"
  };
  const found = status.capturedFields.map((key) => labels[key] || key);
  target.textContent = found.length
    ? `Connected to Lyft. Found ${found.join(", ")}, but not enough information has been saved yet.`
    : `Connected to Lyft and found ${status.fieldCount} populated field${status.fieldCount === 1 ? "" : "s"}, but their labels were not recognized.`;
}

function setValue(id, value) {
  const row = document.getElementById(`${id}-row`);
  if (!value) row.hidden = true;
  else document.getElementById(id).textContent = value;
}

function formatAge(milliseconds) {
  const minutes = Math.max(1, Math.floor(milliseconds / 60000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} hr`;
}
