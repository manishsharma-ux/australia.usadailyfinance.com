# Deploy checklist — SMS verification added to the live build

Build stamp: `otp-crm-2026-09-22` (Code.gs, custom.js, maps-autocomplete.js, diagnostics.js all carry it).

## What changed

SMS verification was grafted onto the live sheet + CRM build. **Nothing about the
sheet layout or the CRM forwarding changed** — same spreadsheet, same 15 columns,
same outbox, same signing, same every-minute trigger.

What is new:

- "Check my eligibility" now sends the code **and the whole lead in one request**.
  The script checks the code with Twilio, appends the row and queues the CRM
  payload in the same execution. There is no token round-trip to lose.
- A 16th column, **Phone verified**, is added to Sheet1 automatically on first
  run. Your 15 columns are untouched.
- Every forwarded CRM payload now carries `otp_verified`. The six digits and the
  internal verification token are stripped and never reach the outbox or the CRM.
- A new **OTP Log** tab records every send and check, with the phone and code masked.
- `?ping=1` now reports `otp` alongside `crm`, and the `?debug=1` panel fails
  loudly if either is misconfigured.

Outcomes:

| What happens | Result |
|---|---|
| Correct code | Row written, `Phone verified = Verified (SMS)`, CRM queued, thank-you page |
| Wrong code | "That code is not right", **nothing written**, 5 tries per code |
| Twilio down / credentials broken | Row **still written** and CRM **still queued**, both marked `Not verified — <reason>`. Set `OTP_FAIL_OPEN = false` in Code.gs to refuse instead. |
| Renter referral | Unchanged: no phone, so no verification; `N/A — no phone number`, still not sent to the CRM |

## 1. Twilio — create or reuse a Verify service

Console → **Verify → Services**. Code length must be **6 digits**
(`#verification-code` is `maxlength="6"`, and `testTwilioConfig` warns if they disagree).

Copy the **Service SID** (`VA…`), plus the **Account SID** (`AC…`) and **Auth Token**
from the console home.

> A trial account can only text numbers verified under **Phone Numbers → Verified
> Caller IDs**. Everything else comes back as error 21608. Upgrade before going live.

## 2. Apps Script — properties, then the file

Open the lead sheet → **Extensions → Apps Script**.

1. ⚙ **Project Settings → Script Properties.** You already have `CRM_URL` and
   `CRM_SECRET`. Add three more:

   | Property | Value |
   |---|---|
   | `TWILIO_ACCOUNT_SID` | `AC…` |
   | `TWILIO_AUTH_TOKEN` | the auth token — treat as a password |
   | `TWILIO_VERIFY_SERVICE_SID` | `VA…` |

   A fourth, `OTP_TOKEN_SECRET`, is created automatically on first use.
   **Don't delete it** — doing so invalidates every token already issued.

   If the screen is read-only ("more than 50 properties"), run
   **`pruneEventIdProperties`** once and reload it.

2. Replace all of `Code.gs` with `google-apps-script/Code.gs` from this folder.

3. Run **`testEverything`**. It sends no SMS and writes no row. Read the log:
   - Verify service reachable, 6-digit codes
   - Every header maps to a value, every value has a column
   - Tokens resolve; tampered ones rejected
   - CRM still reports `configured: true, trigger: true`

4. **Deploy → Manage deployments → ✏️ → Version: New version → Deploy.**
   Do not skip this. Editing the file changes nothing about what `/exec` runs.

## 3. Confirm the deployment actually moved

In a **private window**:

```
https://script.google.com/macros/s/AKfycbw0B4JnHE4t6IUgYSXs5Xvp3V_wFv7n8BkTWop9z9H6LQe3ADL5poorLsCRdka8-ErrLg/exec?ping=1
```

Raw JSON, not a Google sign-in page. All five must be true:

| field | must read |
|---|---|
| `build` | `otp-crm-2026-09-22` |
| `otp` | `configured` |
| `crm` | `{"configured":true,"trigger":true,…}` |
| `sheet_id` | `1jSAombFpIwvjqH0JWJmidKC5U50nDYxVaiDQgEzWkbo` |
| `unmapped` | `[]` |

A sign-in page means "Who has access" is not set to **Anyone**, and every visitor
who is not signed into Google loses their lead with no error on screen.

A different `build`, or no `build` field, means the deployment is still pinned to
an old version — that alone reproduces the "correct code says expired" bug.

## 4. Upload the site files

Replace the whole folder rather than merging individual files:

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

## 5. End-to-end test

1. Load the form with `?debug=1`. The panel must report the server build matching
   the page build, `otp` configured and the CRM outbox counts.
2. Run the form with a real Australian mobile; enter the real code once.
3. Expect: "Checking your code…", then the thank-you page.
4. Check all three land:
   - one row in **Sheet1** with `Phone verified = Verified (SMS)`
   - one row in **CRM outbox**, going `pending` → `sent` within a minute
   - one row in **OTP Log** reading `ok`
5. Console shows `[OTP] verify-and-submit:` with `verified: true`. If the fetch was
   blocked you will also see a reply carrying `idempotent: true` — that is the
   design working, not an error.

## 6. Regression test in the editor

After sending a real code, put it in `TEST_CODE` and run **`testDoubleVerify`**
instead of `testVerifyCode`. It fires the same request twice, exactly as the browser
does. Both lines must read `verified: true`, and the second must carry
`idempotent: true`.

## Settings you may want to change

All in `index.html`:

| Setting | Now | Meaning |
|---|---|---|
| `SKIP_OTP_VERIFICATION` | `false` | `true` puts the site back to the no-OTP behaviour instantly, without touching Code.gs |
| `PHONE_COUNTRIES` | `['AU']` | Leave it. Widen only on a staging URL — every code sent abroad is billed |
| `AU_PHONE_ALLOW_LANDLINE` | `false` | A landline cannot receive the code, so it is rejected at the phone step rather than at the code step |
| `OTP_RESEND_COOLDOWN_SECONDS` | `30` | Cosmetic; the server keeps its own cooldown regardless |
| `SUBMIT_REDIRECT_AFTER_MS` | `10000` | How long the code step waits for a verdict before going to the thank-you page anyway |

And in `Code.gs`:

| Limit | Value |
|---|---|
| Wait between two codes to one number | 30s (`OTP_SEND_COOLDOWN_SECONDS`) |
| Codes per number per hour | 5 (`OTP_MAX_SENDS_PER_HOUR`) |
| Wrong guesses before a new code is needed | 5 (`OTP_MAX_CHECKS`) |
| How long a verification stays good for | 24h (`OTP_TOKEN_TTL_SECONDS`) |
| Write the lead anyway when Twilio fails | `true` (`OTP_FAIL_OPEN`) |

## Rolling back

`.backup-pre-otp/` holds the exact files this replaced. Restoring
`google-apps-script/Code.gs` from it and redeploying as a New version puts the
endpoint back to `au-e164-sheet-crm-2026-09-19`. The "Phone verified" column and
the "OTP Log" tab can stay — the old build ignores both.
