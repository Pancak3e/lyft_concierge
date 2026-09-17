# Security Policy

## Reporting a vulnerability

Please report security issues privately to the repository owner rather than opening
a public issue containing tokens, cookies, customer records, or repair-order data.

## Credential handling

Never include live `x-auth-token` values, cookies, request authorization headers, or
customer information in bug reports. Revoke or rotate any credential that is
accidentally shared.

This project intentionally contains no account credentials. Runtime authentication
is observed from the user's configured CRM session and held only in Chrome session
storage.
