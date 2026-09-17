# Privacy

Lyft Rides processes ride and repair-order information locally in the browser.

## Data processed

The extension may process customer names, phone numbers, pickup and drop-off
addresses, ride estimates, mileage, demand status, repair-order content, and the CRM
authentication header required to perform the user-requested update.

## Storage

- Site URLs and canned-job configuration are stored in Chrome synchronized storage.
- Pending ride details, CRM authentication, completion history, and duplicate-
  prevention state are stored in Chrome session storage.
- Session data is not intentionally retained as permanent extension data.

## Network activity

The extension communicates only with the CRM and Lyft sites configured by the user.
It does not transmit data to the developer, analytics services, or advertising
networks.

## Permissions

Site permissions are optional and requested only for the origins entered on the
settings page. The extension observes CRM request headers solely to obtain the
current `x-auth-token` needed for the requested canned-job update.

## Clipboard

The extension does not request clipboard permissions. Text is processed only after
the user types or pastes it into a monitored form field.
