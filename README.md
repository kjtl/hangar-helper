# Hangar Helper

Hangar Helper is a read-only Chrome extension for the authenticated RSI pledge page:

`https://robertsspaceindustries.com/en/account/pledges`

The extension makes the pledge list more compact by grouping pledges with the same name, sorting groups by creation date, and showing a local page-size control for 10, 25, 50, or 100 grouped rows. Pledge pages are loaded in small read-only batches and cached in the current tab session to avoid repeated full reloads. Once loaded, Hangar Helper checks page 1 once per minute and only fetches additional top pages while it finds unknown pledge IDs. Use **Reload pledges** to clear the Hangar Helper session cache and fetch all pledge pages again.

## Security Model

- The extension only runs on `https://robertsspaceindustries.com/en/account/pledges*`.
- The manifest requests no extension permissions.
- The extension has no background service worker.
- The extension performs read-only same-origin `GET` requests for RSI pledge HTML pages discovered from the built-in paginator.
- The extension does not call account mutation APIs.
- The extension does not read cookies, tokens, credentials, or browser tabs.
- The extension does not submit forms, click RSI controls, dispatch account actions, or modify network traffic.
- All changes are local DOM presentation changes in the current browser tab after parsing fetched pledge-page HTML.

## Install Locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select this folder: `C:\Users\KjetilPedersen\dev\hangar-helper`.
5. Open the RSI pledges page while logged in.

## Development Notes

The RSI page is authenticated, so the implementation uses the page's existing pledge markup and built-in paginator URLs. If the page structure differs from the current selectors, adjust `src/content.js` after inspecting sanitized markup only.
