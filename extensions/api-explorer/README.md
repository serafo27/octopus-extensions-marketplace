# API explorer

A small Postman inside Octopus: send HTTP requests to any host and keep them in collections.

## What it does

- Sends requests with any method, query params, headers, body (JSON, text, form, URL-encoded) and auth
  (bearer token, basic, API key, inherited from the folder or collection).
- Shows the response: status, time, size, headers, and the body pretty-printed (JSON, XML, HTML) or raw;
  images inline.
- Collections with folders, drag and drop to reorder, and auth and variables per collection or folder.
- Environments of `{{variables}}` used in URLs, params, headers, bodies and auth, plus a few dynamic ones
  (`{{$guid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`).
- History of the last 200 requests sent, grouped by day.
- Imports Postman collections (v2.0 / v2.1) and environments, and curl commands; exports collections and
  environments as Postman JSON and any request as curl.
- Per-request settings: follow redirects, verify TLS certificates (off for self-signed or internal ones),
  timeout.

Not supported: Postman pre-request and test scripts (kept in the collection, so they survive an export,
but not run), file uploads in form bodies, auth types other than the ones above.

## What it needs

- **python3** on the Mac. Octopus only lets an extension reach the hosts its manifest lists, so requests
  go through a small local helper (`proxy.py`) that listens on `127.0.0.1` only (port 47871, or 47872 in
  another Octopus build) and needs a token only the page can read. Octopus asks you to allow it the
  first time.
- **Permissions**: `http` to that local helper only, and the `proxy` helper. No Claude, tasks, terminals
  or docs.
- **Network**: requests leave from your Mac, so the VPN applies — connect to it for internal hosts.
- **Accounts**: none. Credentials are whatever you put in requests or environments.
- **Data**: collections, environments, history and open tabs are kept in Octopus's storage on this Mac,
  in plain text (tokens and passwords included). Nothing is sent anywhere but the hosts you call.

## How to use it

1. Open **API explorer** in the activity bar. Click **+** (or ⌘T) for a new request.
2. Type a URL — or paste a curl command into the URL field — and press Enter or ⌘Enter to send.
3. ⌘S saves the request into a collection. ⌘W closes the tab.
4. To bring in Postman work, export a collection or environment from Postman as JSON and drop the file
   on the window, or use Import and paste it.
5. Create an environment in **Environments** (e.g. `baseUrl`, `token`), pick it in the selector at the
   top right, and write `{{baseUrl}}/items` in your requests.
6. Right-click a collection, folder or request for rename, duplicate, move, export or copy as curl.

If sending fails with "The API explorer helper didn't start", check that `python3` runs in a terminal.
