const form = document.getElementById("settings-form");
const status = document.getElementById("status");

document.addEventListener("DOMContentLoaded", loadSettings);
form.addEventListener("submit", saveSettings);

async function loadSettings() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  const settings = response?.settings || {};
  form.elements.crmUrl.value = settings.crmUrl || "";
  form.elements.lyftUrl.value = settings.lyftUrl || "";
  form.elements.cannedJobId.value = settings.cannedJobId || "";
  form.elements.jobKeyword.value = settings.jobKeyword || "Lyft";
}

async function saveSettings(event) {
  event.preventDefault();
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  status.className = "";
  status.textContent = "Validating settings…";

  try {
    const crmUrl = normalizeUrl(form.elements.crmUrl.value, "crm");
    const lyftUrl = normalizeUrl(form.elements.lyftUrl.value, "lyft");
    const cannedJobId = Number(form.elements.cannedJobId.value);
    const jobKeyword = form.elements.jobKeyword.value.trim() || "Lyft";
    if (!Number.isInteger(cannedJobId) || cannedJobId <= 0) {
      throw new Error("Enter a valid positive canned job ID.");
    }

    const origins = [...new Set([originPattern(crmUrl), originPattern(lyftUrl)])];
    const granted = await chrome.permissions.request({ origins });
    if (!granted) throw new Error("Site access is required for the extension to run on these pages.");

    const response = await chrome.runtime.sendMessage({
      type: "SAVE_SETTINGS",
      settings: { crmUrl, lyftUrl, cannedJobId, jobKeyword }
    });
    if (!response?.ok) throw new Error(response?.error || "Settings could not be saved.");
    form.elements.crmUrl.value = response.settings.crmUrl;
    form.elements.lyftUrl.value = response.settings.lyftUrl;
    status.textContent = "Saved. Refresh open CRM and Lyft tabs once to activate the new configuration.";
  } catch (error) {
    status.className = "error";
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = false;
  }
}

function normalizeUrl(value, kind) {
  const url = new URL(String(value || "").trim());
  if (!/^https?:$/.test(url.protocol)) throw new Error("URLs must begin with http:// or https://.");
  if (kind === "crm") {
    const repairOrderPrefix = url.pathname.match(/^(.*?)\/repair-orders(?:\/|$)/i)?.[1];
    if (repairOrderPrefix) url.pathname = repairOrderPrefix;
  }
  if (kind === "lyft") {
    const organizationPrefix = url.pathname.match(/^(\/concierge\/organization\/[^/]+)/i)?.[1];
    if (organizationPrefix) url.pathname = organizationPrefix;
  }
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/$/, "");
}

function originPattern(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.host}/*`;
}
