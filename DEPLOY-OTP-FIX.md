# OTP fix — deploy checklist

## What this build does differently

"Check my eligibility" now sends the code **and the whole lead in one request**. The
script checks the code with Twilio and appends the row in the same execution, then the
page redirects to thanks.html. There is no token round-trip and nothing to lose between
verify and submit.

- Correct code → row written, `Phone verified = Verified (SMS)`, thank-you page.
- Wrong code → "That code is not right", nothing written, 5 tries per code.
- Twilio's fault (down, credentials, code vanished) → row **still written**, marked
  `Not verified — <reason>`, thank-you page. Set `OTP_FAIL_OPEN = false` in Code.gs to refuse instead.
- Phone step → moves to the code step **instantly** on Next; the server reply only updates the
  status line under the code box. No more "did not answer within 12 seconds".
- Both transports (fetch + JSONP) fire in parallel with one request ID; the first readable
  reply wins, the server dedupes the other. One server trip instead of two.
- Resend → cancels the pending code on Twilio first, so a genuinely new code arrives.
- Every send/check is logged to a new **OTP Log** tab in the sheet.
- A 16th column, **Phone verified**, is added to Sheet1 automatically. Your 15 columns are untouched.


Build stamp: `otp-fast-redirect-2026-09-18` (Code.gs, custom.js, maps-autocomplete.js, diagnostics.js all carry it).

## 0. Rotate the Twilio auth token — first

`21df4936632c12a8a19a5d3833c3f8a8` was in the screenshot, so treat it as public.

Twilio console → Account → API keys & tokens → Auth tokens → **Create secondary token** →
test with it → **Promote to primary**. Then update `TWILIO_AUTH_TOKEN` in Script Properties.

## 1. Apps Script

1. Extensions → Apps Script → replace all of `Code.gs` with `google-apps-script/Code.gs`.
2. ⚙ Project Settings → Script Properties. Confirm these three exist:
   - `TWILIO_ACCOUNT_SID` → `YOUR_TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN` → the **new** token
   - `TWILIO_VERIFY_SERVICE_SID` → `VA83fd646930a1db0971167cf363106fed`

   A fourth, `OTP_TOKEN_SECRET`, is created automatically on first use. Don't delete it —
   doing so invalidates every token issued before.
3. Run **`testEverything`**. It sends no SMS and writes no row. Read the log:
   - Verify service reachable, 6-digit codes
   - Every header maps to a value
   - Tokens resolve; tampered ones rejected
4. **Deploy → Manage deployments → ✏️ → Version: New version → Deploy.**
   Do not skip this. Editing the file changes nothing about what `/exec` runs.

## 2. Confirm the deployment actually moved

Open in a browser:

```
https://script.google.com/macros/s/AKfycbxOkKYVhcq6lD41pY8D3xf9WqvdgE0ZMQsLVq95hD5aG9Eb8Rw859sXfYPqmbhQmfUYqQ/exec?ping=1
```

All four must be true:

| field | must read |
|---|---|
| `build` | `otp-fast-redirect-2026-09-18` |
| `otp` | `configured` |
| `sheet_id` | `1WUbokw-GVK5hnt1ZLi3HQ1lhObN43aMCEHCpP1fnO0c` |
| `unmapped` | `[]` |

A different `build`, or no `build` field, means the deployment is still pinned to the old
version — that alone reproduces the "expired" bug.

## 3. Upload the site files

Replace on `australia.usadailyfinance.com/solar1-testing/`:

```
index.html
css/style.css
js/custom.js
js/diagnostics.js
js/maps-autocomplete.js
```

The `?v=` stamps in `index.html` were regenerated, so browsers pick the new files up.
**Turn Cloudflare Rocket Loader OFF and purge the cache** — it rewrites `onclick`
handlers and breaks `verifyCode()` / `resendCode()`.

## 4. End-to-end test

1. Load `/solar1-testing/?debug=1`. The panel should report the server build matching
   the page build.
2. Run the form with a real number, enter the real code once.
3. Expect: "Number verified. Submitting your details…" then the thank-you page, and one
   row in the sheet.
4. Console should show `[OTP] verify-code:` with `verified: true`. If the fetch was
   blocked you'll also see `Direct POST failed, retrying over JSONP` followed by a reply
   carrying `idempotent: true` — that is the fix working, not an error.

## 5. Before going live

`index.html` still has `PHONE_COUNTRIES = ['AU', 'IN', 'US', 'AE']` for testing.
Set it back to `['AU']`. Every code sent abroad is billed, and a +91 number is not an
Australian solar lead.

## Regression test in the editor

After sending a real code, put it in `TEST_CODE` and run **`testDoubleVerify`** instead of
`testVerifyCode`. It fires the same request twice, exactly as the browser does. Both lines
must read `verified: true`, and the second must carry `idempotent: true`. That is the
reported bug, caught in the editor.
