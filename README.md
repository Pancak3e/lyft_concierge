# Lyft Rides

Lyft Rides is a configurable Chrome extension that connects a Lyft Concierge
workflow with repair orders in a compatible automotive CRM. It captures customer
and trip details, identifies the matching repair order, and lets an advisor add a
configured ride-share sublet with the estimated ride cost.

## Highlights

- Captures customer name, phone, pickup, drop-off, fare, mileage, and demand status.
- Handles typed, pasted, auto-completed, and dynamically rendered form values.
- Normalizes phone formats and fuzzily matches names and addresses.
- Shows a focused reminder only on a strongly matching repair order.
- Adds a configurable canned sublet and updates its item cost in cents.
- Prevents duplicate submissions and suppresses completed ride reminders.
- Requests access only to the CRM and Lyft origins configured by the user.
- Keeps authentication tokens and ride details in temporary Chrome session storage.

## Compatibility

The included CRM adapter expects the workflow used by Tekmetric-compatible pages:

- Repair-order URLs contain `/repair-orders/{id}`.
- Authentication is sent in an `x-auth-token` request header.
- A canned sublet is added with `POST /api/repair-order/{id}/canned`.
- Its item cost is saved with `POST /api/sublet`.

The site URLs, canned-job ID, and ride item keyword are configured in the extension
settings. No organization URL, canned-job ID, vendor ID, user account, or token is
included in this repository.

## Install locally

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the `Lyft-Rides` folder.
5. Open the extension's **Settings** page.
6. Enter your CRM shop URL, Lyft Concierge organization URL, canned-job ID, and
   ride item keyword.
7. Click **Save and grant site access**, then refresh open CRM and Lyft tabs once.

Pasting a full repair-order URL or a deeper Lyft organization URL is fine; the
settings page automatically reduces it to the appropriate shop or organization base.

## How it works

1. On the configured Lyft page, the extension starts capturing immediately and
   updates the pending ride as the form or estimate changes.
2. On CRM repair-order pages, visible content and populated fields are searched in
   memory for the customer's full name, normalized phone number, and addresses.
3. A confidence score determines whether the reminder should appear.
4. **Marked on ticket** reads the live repair-order ID, adds the configured canned
   sublet, extracts the newly created sublet from the response, converts the Lyft
   fare to cents, and updates the ride item cost.
5. The completed ride fingerprint is remembered for 12 hours so an unchanged Lyft
   tab cannot re-create the same reminder.

## Data handling

- Configuration is stored with `chrome.storage.sync`.
- Ride details, completion fingerprints, and captured CRM authentication are stored
  with `chrome.storage.session` and expire or disappear when the browser session or
  extension context ends.
- The extension does not send data to analytics, advertising, or developer-owned
  servers.
- Normal paste events are captured from form fields; unrestricted clipboard access
  is not requested.

See [PRIVACY.md](PRIVACY.md) for the complete privacy summary.

## Development

The project uses plain Manifest V3 JavaScript, HTML, and CSS and does not require a
build step. After making changes, reload the unpacked extension and refresh affected
tabs. JavaScript syntax can be checked with Node:

```sh
node --check background.js
node --check content.js
node --check options.js
node --check popup.js
```

## Important note

CRM and Lyft page structures and private endpoints can change without notice. Test
the extension in a non-critical repair order before production use. Users are
responsible for confirming that their account permissions and CRM terms allow this
automation.

## License

MIT — see [LICENSE](LICENSE).

Lyft Rides is an independent project and is not affiliated with, endorsed by, or
sponsored by Lyft or Tekmetric. Product names are used only to describe compatibility.
