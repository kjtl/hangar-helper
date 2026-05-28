# Security Notes

Hangar Helper is intentionally a content-script-only extension.

## Allowed Behavior

- Read visible pledge information from the current page DOM.
- Fetch RSI pledge HTML pages discovered from the built-in paginator using same-origin `GET` requests.
- Check RSI pledge page 1 once per minute for new pledge IDs and fetch additional top pages only while new IDs are found.
- Parse fetched pledge-page HTML locally in the browser.
- Cache fetched pledge HTML in `sessionStorage` for the current tab session.
- Add local presentation controls.
- Hide or show pledge details in the current page view.
- Hide pledge cards outside the selected local page size.

## Disallowed Behavior

- No account mutation API calls.
- No credential or cookie access.
- No account mutation.
- No form submission.
- No synthetic clicks on RSI controls.
- No network request interception.
- No telemetry.
- No long-term persistence of pledge contents or account data.

## Manifest Policy

The extension should keep `manifest.json` free of privileged permissions unless a future feature has a reviewed need for one. Any new permission should be treated as a security-relevant change.
