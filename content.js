(() => {
  const TOAST_ID = "lyft-rides-ticket-reminder";
  let lastMatchKey = null;
  let captureTimer = null;
  let captureToastShown = false;
  let extensionContextValid = true;

  initialize();

  async function initialize() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await safeSendMessage({ type: "GET_SETTINGS" });
      const settings = response?.settings;
      if (settings) {
        if (urlIsWithin(location.href, settings.lyftUrl)) watchLyftRideForm();
        else if (urlIsWithin(location.href, settings.crmUrl)) watchCrmPage();
        return;
      }
      await delay(400);
    }
  }

  function watchLyftRideForm() {
    const queueCapture = (showConfirmation = false) => {
      window.clearTimeout(captureTimer);
      captureTimer = window.setTimeout(
        () => captureCurrentRide(showConfirmation),
        showConfirmation ? 100 : 450
      );
    };

    document.addEventListener("input", () => queueCapture(false), true);
    document.addEventListener("change", () => queueCapture(false), true);
    document.addEventListener("paste", () => queueCapture(false), true);

    document.addEventListener("click", (event) => {
      const control = event.target.closest("button, [role='button'], input[type='submit']");
      if (!control) return;

      const text = controlText(control);
      if (!/(find|request|schedule|book|order|search).{0,18}ride|ride.{0,18}(find|request|schedule|book|order|search)/i.test(text)) {
        return;
      }

      queueCapture(true);
    }, true);

    const observer = new MutationObserver(() => {
      queueCapture(false);
      const text = visiblePageText();
      if (
        !captureToastShown &&
        /(looking for|finding|searching for|ride requested|ride scheduled|request confirmed|driver requested)/i.test(text)
      ) queueCapture(true);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    queueCapture(false);
    window.setTimeout(() => queueCapture(false), 1500);
    window.setInterval(() => queueCapture(false), 2500);
  }

  async function captureCurrentRide(showConfirmation = false) {
    const fields = Array.from(document.querySelectorAll("input, textarea, [role='combobox']"))
      .filter(isVisible)
      .map((element) => ({
        element,
        value: fieldValue(element),
        directContext: directFieldContext(element),
        nearbyContext: nearbyFieldContext(element)
      }))
      .filter((field) => field.value);

    const estimate = extractRideEstimate();
    const ride = {
      firstName: pickBestField(fields, "firstName"),
      lastName: pickBestField(fields, "lastName"),
      phone: pickBestField(fields, "phone"),
      pickup: pickBestField(fields, "pickup"),
      dropoff: pickBestField(fields, "dropoff"),
      price: estimate.price,
      demandStatus: estimate.demandStatus,
      distance: estimate.distance,
      sourceUrl: location.href
    };

    if (!ride.firstName && !ride.lastName) {
      const fullName = pickBestField(fields, "fullName");
      const parts = fullName.trim().split(/\s+/);
      if (parts.length > 1) {
        ride.firstName = parts.shift();
        ride.lastName = parts.join(" ");
      } else {
        ride.firstName = fullName;
      }
    }

    applyUnlabeledFieldFallbacks(ride, fields);

    const capturedFields = Object.entries(ride)
      .filter(([key, value]) => key !== "sourceUrl" && Boolean(value))
      .map(([key]) => key);
    safeSendMessage({
      type: "LYFT_CAPTURE_ACTIVE",
      url: location.href,
      fieldCount: fields.length,
      capturedFields
    });

    if (!capturedFields.length) return;

    try {
      const response = await safeSendMessage({ type: "SAVE_LYFT_RIDE", ride });
      if (response?.ok && response.ride && showConfirmation) {
        captureToastShown = true;
        showCaptureToast(response.ride);
      }
    } catch (error) {
      console.warn("Lyft Rides could not save the ride details:", error);
    }
  }

  function watchCrmPage() {
    let queued = false;
    const check = () => {
      if (queued) return;
      queued = true;
      window.setTimeout(async () => {
        queued = false;
        await checkForMatchingRepairOrder();
      }, 400);
    };

    check();
    window.setTimeout(check, 750);
    window.setTimeout(check, 1800);
    new MutationObserver(check).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    window.addEventListener("popstate", check);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) check();
    });
    window.setInterval(check, 2000);
  }

  async function checkForMatchingRepairOrder() {
    if (!/\/repair-orders\//i.test(location.pathname)) return;

    const response = await safeSendMessage({ type: "GET_LYFT_RIDE" });
    const ride = response?.ride;
    if (!ride || document.getElementById(TOAST_ID)) return;

    const searchableText = normalizeText([
      visiblePageText(),
      ...Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']"))
        .map(fieldValue)
    ].join(" "));
    const result = scoreMatch(ride, searchableText);
    if (!result.isStrongMatch) return;

    const matchKey = `${ride.id}:${location.href}`;
    if (matchKey === lastMatchKey) return;
    lastMatchKey = matchKey;
    showCrmReminder(ride, result);
    safeSendMessage({
      type: "SHOW_LYFT_MATCH_NOTIFICATION",
      ride,
      matchedBy: result.matches.join(", ")
    });
  }

  function scoreMatch(ride, pageText) {
    const matches = [];
    let score = 0;
    const fullName = normalizeText([ride.firstName, ride.lastName].filter(Boolean).join(" "));
    const phone = digitsOnly(ride.phone);

    if (ride.firstName && ride.lastName && fullName.length >= 5 && pageText.includes(fullName)) {
      matches.push("full customer name");
      score += 7;
    } else if (fuzzyFullNameMatch(ride.firstName, ride.lastName, pageText)) {
      matches.push("customer name (fuzzy match)");
      score += 6;
    }

    const pageDigits = digitsOnly(pageText);
    if (phone.length >= 10 && pageDigits.includes(phone.slice(-10))) {
      matches.push("full phone number");
      score += 7;
    } else if (phone.length >= 7 && pageDigits.includes(phone.slice(-7))) {
      matches.push("last 7 phone digits");
      score += 4;
    }

    for (const [label, address] of [["pickup address", ride.pickup], ["drop-off address", ride.dropoff]]) {
      const normalized = normalizeAddress(address);
      const addressResult = addressSimilarity(normalized, pageText);
      if (normalized.length >= 6 && pageText.includes(normalized)) {
        matches.push(label);
        score += 7;
      } else if (addressResult.isMatch) {
        matches.push(`${label} (${addressResult.percent}% fuzzy match)`);
        score += addressResult.percent >= 80 ? 6 : 5;
      }
    }

    return {
      matches,
      score,
      confidence: score >= 10 ? "Very strong" : score >= 7 ? "Strong" : "Likely",
      isStrongMatch: score >= 6
    };
  }

  function fuzzyFullNameMatch(firstName, lastName, pageText) {
    const pageTokens = new Set(pageText.split(" ").filter(Boolean));
    return [firstName, lastName].every((name) => {
      const normalized = normalizeText(name);
      if (normalized.length < 2) return false;
      return Array.from(pageTokens).some((token) => fuzzyTokenEqual(normalized, token));
    });
  }

  function addressSimilarity(address, pageText) {
    const addressTokens = meaningfulAddressTokens(address);
    const pageTokens = new Set(normalizeAddress(pageText).split(" ").filter(Boolean));
    const pageCollapsed = normalizeAddress(pageText).replace(/\s/g, "");
    const houseNumber = addressTokens.find((token) => /^\d+[a-z]?$/.test(token));
    const words = addressTokens.filter((token) => !/^\d+[a-z]?$/.test(token));

    if (houseNumber && !pageTokens.has(houseNumber)) {
      return { isMatch: false, percent: 0 };
    }

    const matchedWords = words.filter((word) =>
      Array.from(pageTokens).some((pageToken) => fuzzyTokenEqual(word, pageToken)) ||
      (word.length >= 5 && pageCollapsed.includes(word))
    );
    const denominator = Math.max(1, Math.min(words.length, 4));
    const collapsedStreetMatch = words.join("").length >= 5 && pageCollapsed.includes(words.join(""));
    const matchedCount = collapsedStreetMatch ? denominator : Math.min(matchedWords.length, denominator);
    const percent = Math.round((matchedCount / denominator) * 100);
    const enoughStreetEvidence = collapsedStreetMatch ||
      (words.length === 1 ? matchedWords.length === 1 : matchedWords.length >= 2);

    return {
      isMatch: Boolean((houseNumber || words.length >= 3) && enoughStreetEvidence && percent >= 50),
      percent
    };
  }

  function showCrmReminder(ride, result) {
    const name = [ride.firstName, ride.lastName].filter(Boolean).join(" ") || "this customer";
    const reminder = document.createElement("aside");
    reminder.id = TOAST_ID;
    reminder.setAttribute("role", "alertdialog");
    reminder.setAttribute("aria-label", "Lyft ride reminder");
    reminder.innerHTML = `
      <button data-close aria-label="Close Lyft reminder">×</button>
      <div class="lr-kicker">LYFT RIDE REMINDER</div>
      <div class="lr-title">Add the ride to ${escapeHtml(name)}'s ticket</div>
      <div class="lr-match">${escapeHtml(result.confidence)} match · ${escapeHtml(result.matches.join(", "))}</div>
      ${rideEstimateCard(ride)}
      ${detailRow("Phone", ride.phone)}
      ${detailRow("Pickup", ride.pickup)}
      ${detailRow("Drop-off", ride.dropoff)}
      <div class="lr-error" data-error hidden></div>
      <button data-complete class="lr-complete">Marked on ticket</button>`;

    const style = document.createElement("style");
    style.textContent = `
      #${TOAST_ID}{position:fixed;right:22px;bottom:22px;z-index:2147483647;width:min(390px,calc(100vw - 44px));box-sizing:border-box;padding:20px;border:1px solid #ddd6fe;border-radius:16px;background:#fff;color:#171717;box-shadow:0 18px 55px rgba(31,20,51,.28);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      #${TOAST_ID} [data-close]{position:absolute;right:12px;top:8px;border:0;background:transparent;color:#6b7280;font-size:26px;cursor:pointer}
      #${TOAST_ID} .lr-kicker{color:#6d28d9;font-size:11px;font-weight:800;letter-spacing:.12em}
      #${TOAST_ID} .lr-title{margin:5px 25px 4px 0;font-size:18px;font-weight:750}
      #${TOAST_ID} .lr-match{margin-bottom:12px;color:#6b7280;font-size:12px}
      #${TOAST_ID} .lr-estimate{margin:12px 0;padding:12px;border-radius:10px;background:#f5f3ff;color:#4c1d95;font-weight:700}
      #${TOAST_ID} .lr-estimate small{display:block;margin-top:3px;color:#6d28d9;font-weight:500}
      #${TOAST_ID} .lr-row{margin:7px 0;color:#374151}.lr-row b{color:#111827}
      #${TOAST_ID} .lr-error{margin-top:12px;padding:9px;border-radius:8px;background:#fef2f2;color:#991b1b;font-size:12px}
      #${TOAST_ID} .lr-complete{width:100%;margin-top:14px;padding:10px 12px;border:0;border-radius:9px;background:#5b21b6;color:#fff;font-weight:700;cursor:pointer}
      #${TOAST_ID} .lr-complete:disabled{cursor:wait;opacity:.68}
    `;

    reminder.querySelector("[data-close]").addEventListener("click", () => reminder.remove());
    reminder.querySelector("[data-complete]").addEventListener("click", async () => {
      const button = reminder.querySelector("[data-complete]");
      const errorBox = reminder.querySelector("[data-error]");
      const repairOrderId = location.pathname.match(/\/repair-orders\/(\d+)/i)?.[1];
      button.disabled = true;
      button.textContent = "Checking latest Lyft details…";
      errorBox.hidden = true;

      let latestRide = ride;
      for (let attempt = 0; attempt < 5 && !latestRide.price; attempt += 1) {
        const latestResponse = await safeSendMessage({ type: "GET_LYFT_RIDE" });
        if (latestResponse?.ride?.id === ride.id) latestRide = latestResponse.ride;
        if (latestRide.price) break;
        await delay(650);
      }

      if (latestRide.price && !reminder.querySelector(".lr-estimate")) {
        reminder.querySelector(".lr-match")?.insertAdjacentHTML(
          "afterend",
          rideEstimateCard(latestRide)
        );
      }
      button.textContent = "Adding Lyft job and cost…";

      const response = await safeSendMessage({
        type: "ADD_LYFT_CANNED_JOB",
        repairOrderId,
        rideId: latestRide.id,
        ridePrice: latestRide.price
      });

      if (!response?.ok) {
        button.disabled = false;
        button.textContent = "Try adding again";
        errorBox.textContent = response?.error || "The Lyft job could not be added to the CRM.";
        errorBox.hidden = false;
        return;
      }

      const savedCost = Number.isInteger(response.costCents)
        ? `$${(response.costCents / 100).toFixed(2)}`
        : ride.price;
      button.textContent = response.alreadyAdded
        ? "Already added ✓"
        : `Added with ${savedCost} cost ✓`;
      await safeSendMessage({ type: "CLEAR_LYFT_RIDE" });
      window.setTimeout(() => location.reload(), 900);
    });
    (document.head || document.documentElement).appendChild(style);
    (document.body || document.documentElement).appendChild(reminder);
  }

  function showCaptureToast(ride) {
    const existing = document.getElementById("lyft-rides-captured");
    existing?.remove();
    const toast = document.createElement("div");
    toast.id = "lyft-rides-captured";
    toast.textContent = `Ride reminder saved for ${[ride.firstName, ride.lastName].filter(Boolean).join(" ") || "customer"}`;
    Object.assign(toast.style, {
      position: "fixed", right: "20px", bottom: "20px", zIndex: "2147483647",
      padding: "12px 16px", borderRadius: "10px", background: "#252525", color: "white",
      boxShadow: "0 8px 30px rgba(0,0,0,.28)", font: "600 14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
    });
    document.body.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3500);
  }

  function extractRideEstimate() {
    const text = visiblePageText().replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ");
    const combinedPattern = /(\$\s?\d{1,4}(?:,\d{3})*(?:\.\d{2})?)\s*(?:\(\s*([^()\n]{2,80}?)\s*\))?\s*(?:\/|\||·|—|-)\s*(\d+(?:\.\d+)?)\s*(mi|mile|miles)\b/i;
    const combined = text.match(combinedPattern);
    if (combined) {
      return {
        price: combined[1].replace(/\s/g, ""),
        demandStatus: String(combined[2] || "").trim(),
        distance: `${combined[3]} miles`
      };
    }

    for (const line of text.split(/\n+/).map((value) => value.trim()).filter(Boolean)) {
      if (line.length > 180) continue;
      const price = line.match(/\$\s?\d{1,4}(?:,\d{3})*(?:\.\d{2})?/);
      const distance = line.match(/\b\d+(?:\.\d+)?\s*(?:mi|mile|miles)\b/i);
      if (!price || !distance) continue;
      const demand = line.match(/\(\s*([^()]{2,80}?)\s*\)/);
      return {
        price: price[0].replace(/\s/g, ""),
        demandStatus: String(demand?.[1] || "").trim(),
        distance: distance[0].replace(/\bmi\b/i, "miles")
      };
    }
    return { price: "", demandStatus: "", distance: "" };
  }

  function rideEstimateCard(ride) {
    if (!ride.price && !ride.distance && !ride.demandStatus) return "";
    const headline = [ride.price, ride.distance].filter(Boolean).join(" · ");
    const status = ride.demandStatus ? `<small>${escapeHtml(ride.demandStatus)}</small>` : "";
    return `<div class="lr-estimate">${escapeHtml(headline || "Ride estimate")}${status}</div>`;
  }

  function pickBestField(fields, kind) {
    const candidates = fields
      .map((field) => ({ field, score: fieldKindScore(field, kind) }))
      .filter((candidate) => candidate.score >= 4)
      .sort((first, second) => second.score - first.score);
    return candidates[0]?.field.value || "";
  }

  function applyUnlabeledFieldFallbacks(ride, fields) {
    if (!ride.pickup || !ride.dropoff) {
      const addressCandidates = fields.filter((field) => isLikelyAddress(field.value));
      if (!ride.pickup && addressCandidates[0]) ride.pickup = addressCandidates[0].value;
      if (!ride.dropoff && addressCandidates[1]) ride.dropoff = addressCandidates[1].value;
    }

    if (!ride.firstName || !ride.lastName) {
      const phoneIndex = fields.findIndex((field) => digitsOnly(field.value).length >= 7);
      const nameCandidates = fields
        .map((field, index) => ({ ...field, index }))
        .filter((field) => isLikelyPersonName(field.value))
        .sort((first, second) => {
          const firstBeforePhone = phoneIndex < 0 || first.index < phoneIndex ? 1 : 0;
          const secondBeforePhone = phoneIndex < 0 || second.index < phoneIndex ? 1 : 0;
          if (firstBeforePhone !== secondBeforePhone) return secondBeforePhone - firstBeforePhone;
          return first.index - second.index;
        });

      const alreadyUsed = new Set([ride.firstName, ride.lastName].filter(Boolean).map(normalizeText));
      const unusedNames = nameCandidates.filter((field) => !alreadyUsed.has(normalizeText(field.value)));
      if (!ride.firstName && unusedNames[0]) ride.firstName = unusedNames.shift().value;
      if (!ride.lastName && unusedNames[0]) ride.lastName = unusedNames.shift().value;
    }
  }

  function isLikelyAddress(value) {
    const text = String(value || "").trim();
    return (
      /^\d+[a-z]?[\s,.-]+[a-z]/i.test(text) &&
      /[a-z]{3,}/i.test(text) &&
      text.length >= 6
    );
  }

  function isLikelyPersonName(value) {
    const text = String(value || "").trim();
    if (!/^[a-z][a-z .'-]{1,79}$/i.test(text) || /\d/.test(text)) return false;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > 3) return false;
    return !/(address|pickup|dropoff|destination|phone|mobile|select|search|ride|business|personal)/i.test(text);
  }

  function fieldKindScore(field, kind) {
    const direct = normalizeText(field.directContext);
    const nearby = normalizeText(field.nearbyContext);
    const element = field.element;
    const rules = {
      firstName: [/\bfirst name\b/, /\bfirstname\b/, /\bgiven name\b/, /\bgivenname\b/, /\brider first\b/, /\briderfirst\b/, /\bpassenger first\b/],
      lastName: [/\blast name\b/, /\blastname\b/, /\bsurname\b/, /\bfamily name\b/, /\bfamilyname\b/, /\brider last\b/, /\briderlast\b/, /\bpassenger last\b/],
      fullName: [/\bfull name\b/, /\bfullname\b/, /\brider name\b/, /\bridername\b/, /\bpassenger name\b/, /\bcustomer name\b/, /\bguest name\b/],
      phone: [/\bphone\b/, /\bphone number\b/, /\bphonenumber\b/, /\bmobile\b/, /\bcell\b/, /\btelephone\b/],
      pickup: [/\bpick up\b/, /\bpickup\b/, /\bpickup address\b/, /\bpickupaddress\b/, /\borigin\b/, /\boriginaddress\b/, /\bfrom address\b/, /\bstarting address\b/],
      dropoff: [/\bdrop off\b/, /\bdropoff\b/, /\bdropoff address\b/, /\bdropoffaddress\b/, /\bdestination\b/, /\bdestinationaddress\b/, /\bto address\b/, /\bending address\b/]
    };
    const negatives = {
      firstName: [/\blast name\b/, /\bsurname\b/],
      lastName: [/\bfirst name\b/, /\bgiven name\b/],
      fullName: [/\bfirst name\b/, /\blast name\b/],
      phone: [/\baddress\b/],
      pickup: [/\bdrop off\b/, /\bdropoff\b/, /\bdestination\b/],
      dropoff: [/\bpick up\b/, /\bpickup\b/, /\borigin\b/]
    };

    let score = 0;
    for (const pattern of rules[kind]) {
      if (pattern.test(direct)) score += 8;
      else if (pattern.test(nearby)) score += 3;
    }
    for (const pattern of negatives[kind]) {
      if (pattern.test(direct)) score -= 10;
      else if (pattern.test(nearby)) score -= 3;
    }

    if (kind === "phone") {
      if (element.type === "tel") score += 8;
      if (/^tel/.test(element.autocomplete || "")) score += 8;
      if (digitsOnly(field.value).length >= 7) score += 2;
    }
    if (kind === "firstName" && element.autocomplete === "given-name") score += 10;
    if (kind === "lastName" && element.autocomplete === "family-name") score += 10;
    if ((kind === "pickup" || kind === "dropoff") && element.autocomplete === "street-address") score += 2;
    return score;
  }

  function fieldValue(element) {
    return String(element.value || element.getAttribute("value") || element.textContent || "").trim();
  }

  function directFieldContext(element) {
    const label = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`) : null;
    return [
      element.id, element.name, element.getAttribute("aria-label"), element.getAttribute("placeholder"),
      element.getAttribute("autocomplete"), label?.textContent, element.closest("label")?.textContent
    ].filter(Boolean).join(" ");
  }

  function nearbyFieldContext(element) {
    let current = element.parentElement;
    for (let level = 0; current && level < 3; level += 1, current = current.parentElement) {
      const text = String(current.textContent || "").replace(/\s+/g, " ").trim();
      if (text && text.length <= 220) return text;
    }
    return "";
  }

  function controlText(element) {
    return [element.textContent, element.value, element.getAttribute("aria-label"), element.title]
      .filter(Boolean).join(" ").trim();
  }

  function visiblePageText() {
    return document.body?.innerText || document.body?.textContent || "";
  }

  function normalizeText(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function normalizeAddress(value) {
    return normalizeText(value)
      .replace(/\b(court|ct)\b/g, "ct")
      .replace(/\b(street|st)\b/g, "st")
      .replace(/\b(road|rd)\b/g, "rd")
      .replace(/\b(avenue|ave)\b/g, "ave")
      .replace(/\b(boulevard|blvd)\b/g, "blvd")
      .replace(/\b(drive|dr)\b/g, "dr")
      .replace(/\b(lane|ln)\b/g, "ln")
      .replace(/\b(highway|hwy)\b/g, "hwy")
      .replace(/\b(parkway|pkwy)\b/g, "pkwy")
      .replace(/\b(place|pl)\b/g, "pl")
      .replace(/\b(terrace|ter)\b/g, "ter")
      .replace(/\b(apartment|apt)\b/g, "apt")
      .replace(/\b(suite|ste)\b/g, "ste")
      .replace(/\b(maryland)\b/g, "md")
      .replace(/\b(united states of america|united states|usa)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function meaningfulAddressTokens(value) {
    const ignored = new Set(["st", "rd", "ave", "blvd", "dr", "ln", "ct", "hwy", "pkwy", "pl", "ter", "apt", "ste", "md"]);
    const tokens = normalizeAddress(value).split(" ").filter(Boolean);
    return [...new Set(tokens.filter((token) => !ignored.has(token) && (token.length >= 3 || /^\d+[a-z]?$/.test(token))))];
  }

  function fuzzyTokenEqual(first, second) {
    if (first === second) return true;
    if (first.length >= 5 && second.length >= 5 && (first.includes(second) || second.includes(first))) return true;
    if (first.length < 4 || second.length < 4 || Math.abs(first.length - second.length) > 1) return false;
    return editDistanceAtMostOne(first, second);
  }

  function editDistanceAtMostOne(first, second) {
    if (first === second) return true;
    if (Math.abs(first.length - second.length) > 1) return false;
    let firstIndex = 0;
    let secondIndex = 0;
    let edits = 0;
    while (firstIndex < first.length && secondIndex < second.length) {
      if (first[firstIndex] === second[secondIndex]) {
        firstIndex += 1;
        secondIndex += 1;
        continue;
      }
      edits += 1;
      if (edits > 1) return false;
      if (first.length > second.length) firstIndex += 1;
      else if (second.length > first.length) secondIndex += 1;
      else {
        firstIndex += 1;
        secondIndex += 1;
      }
    }
    return true;
  }

  function digitsOnly(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function urlIsWithin(candidate, configured) {
    if (!configured) return false;
    try {
      const current = new URL(candidate);
      const expected = new URL(configured);
      const prefix = expected.pathname.replace(/\/$/, "");
      return current.origin === expected.origin &&
        (!prefix || prefix === "/" || current.pathname === prefix || current.pathname.startsWith(`${prefix}/`));
    } catch (_) {
      return false;
    }
  }

  async function safeSendMessage(message) {
    if (!extensionContextValid || !globalThis.chrome?.runtime?.id) return null;
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (/extension context invalidated/i.test(text)) {
        extensionContextValid = false;
        window.clearTimeout(captureTimer);
        return null;
      }
      if (/receiving end does not exist/i.test(text)) return null;
      console.warn("Lyft Rides message failed:", error);
      return null;
    }
  }

  function detailRow(label, value) {
    return value ? `<div class="lr-row"><b>${label}:</b> ${escapeHtml(value)}</div>` : "";
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[character]);
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }
})();
