# SMS verification — Twilio Verify

The phone step now texts a 6-digit code, and the lead reaches the Google Sheet
only once that code checks out.

Nothing new is hosted for this. The Apps Script web app that already writes the
sheet does the Twilio calls as well, because the browser cannot be trusted with
a Twilio auth token — anything in `js/` is readable by everyone who loads the
page, and that token is a password to a billable account.

```
index.html  →  js/custom.js
                  │  {action:'send-code'}       {action:'verify-code'}
                  ▼
        Apps Script /exec   ← credentials live here, in Script Properties
                  │
                  ▼
        Twilio Verify API   ← generates, expires and rate-limits the code
```

---

## 1. Twilio: create a Verify service

1. Sign in at <https://console.twilio.com> — use the Optimal Transnational account.
2. **Explore products → Verify → Services → Create new**.
3. Friendly name: whatever appears in the message, e.g. `Optimal Transnational`.
4. Leave the code length at **6 digits** — `#verification-code` in `index.html`
   is `maxlength="6"`, and `testTwilioConfig` warns if the two disagree.
5. Copy the **Service SID**. It starts with `VA`.

Also copy, from the console home page:

- **Account SID** — starts with `AC`
- **Auth Token** — click to reveal. Treat it as a password.

> A trial account can only text numbers you have verified in the console
> (**Phone Numbers → Verified Caller IDs**). Every other number comes back as
> Twilio error 21608. Upgrade the account before going live.

## 2. Apps Script: store the three values

Open the sheet → **Extensions → Apps Script** → **⚙ Project Settings** →
**Script Properties** → **Add script property**, three times:

| Property | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | `AC…` |
| `TWILIO_AUTH_TOKEN` | the auth token |
| `TWILIO_VERIFY_SERVICE_SID` | `VA…` |

They live here and not in `Code.gs` for one reason: `Code.gs` is in the
repository and gets copied, pasted and shared. Script Properties are not.

## 3. Deploy and check

1. Paste the current `google-apps-script/Code.gs` over the script.
2. **Deploy → Manage deployments → ✏️ edit → Version: New version → Deploy.**
   Editing the file alone changes nothing about what the `/exec` URL runs.
3. In the editor, run **`testTwilioConfig`** and read the Execution log. It
   reads the three properties and asks Twilio for the service. It sends no
   message and costs nothing.

   ```
   OK — Verify service "Optimal Transnational" is reachable.
   Codes are 6 digits. The form expects 6.
   ```

4. Open `<your /exec URL>?ping=1` in a browser. It must report:

   ```json
   { "ok": true, "pong": true, "build": "otp-crm-2026-09-22", "otp": "configured",
     "crm": { "configured": true, "trigger": true } }
   ```

   `"otp": "not_configured"` means the Script Properties are missing or
   misspelled — `otp_error` says which. Every code request will fail until it
   says `configured`.

### The other editor functions

| Function | What it does |
|---|---|
| `testTwilioConfig` | Checks the credentials. Sends nothing, costs nothing. Run this first. |
| `testPhoneNormalising` | Prints how each number format is rewritten before Twilio sees it. Writes nothing. |
| `testSendCode` | Texts a real code. **Edit the number in the function first.** Costs one verification. |
| `testVerifyCode` | Checks the code `testSendCode` sent. Edit both the number and the code. |
| `testInsert` | The sheet check that predates all this — still writes a test row. |

## 4. Front-end switches (`index.html`)

| Setting | Meaning |
|---|---|
| `SKIP_OTP_VERIFICATION` | `false` = send and check a code. `true` = the old behaviour, straight to the sheet from the phone step. |
| `OTP_ENDPOINT_URL` | Blank = the same deployment as `GOOGLE_SHEET_WEBAPP_URL`. Only set it if you split them. |
| `OTP_RESEND_COOLDOWN_SECONDS` | How long the resend button counts down. The server keeps its own cooldown regardless. |
| `AU_PHONE_ALLOW_LANDLINE` | Set to `false` while verification is on — a landline cannot receive the code. |

---

## What happens on the page

1. The visitor enters a mobile number and presses **Next**.
2. `sendCode()` posts `{action:'send-code'}`. Twilio texts a code; the form
   moves to the code step and the resend button counts down.
3. They type the code and press **Check my eligibility**.
4. `verifyCode()` posts `{action:'verify-code'}`. Twilio approves it, the
   script mints a short-lived token, and the same submission pipeline as
   before writes the row — now carrying that token.
5. `thanks.html`.

A failed send leaves them on the phone step with the reason, and **writes
nothing**. That is the point of the step: the number is the one field that just
failed, and a lead whose phone number may not exist is what verification is
there to prevent.

## What the token is for

`handleLead` in `Code.gs` will not write a lead that carries a phone number
without a valid token. Without that check, the OTP step would only be an
obstacle in the browser — anyone could `curl` the `/exec` URL and fill the
sheet with numbers nobody ever answered.

Two deliberate exceptions, both documented at `checkOtpGate`:

- **Twilio not configured** — every lead goes through. A half-finished setup
  should not silently reject a day of leads; `?ping=1` and the `?debug=1` panel
  are where that is meant to show up.
- **No phone number on the lead** — goes through. That is the renter referral,
  which ends before the phone step exists. Nothing to verify, nothing to call.

## Limits, and where they are set

| Limit | Value | Where |
|---|---|---|
| Wait between two codes to one number | 30s | `OTP_SEND_COOLDOWN_SECONDS`, `Code.gs` |
| Codes per number per hour | 5 | `OTP_MAX_SENDS_PER_HOUR`, `Code.gs` |
| Wrong guesses before a new code is needed | 5 | `OTP_MAX_CHECKS`, `Code.gs` |
| How long a verification stays good for | 24 hours | `OTP_TOKEN_TTL_SECONDS`, `Code.gs` |
| Code expiry, attempts per code, carrier limits | Twilio's own | Verify service settings |

These sit in front of Twilio's own limits rather than replacing them. Verify
bills per attempt, so a script hammering the endpoint is a bill as well as a
nuisance, and the cheapest place to stop it is before the outbound request.

## When something goes wrong

Add `?debug=1` to the form URL. The panel checks the deployment, the sheet
columns and, now, whether the endpoint can actually send a code.

| What you see | What it means |
|---|---|
| `SMS verification: on, but sendCode/verifyCode are undefined` | The `js/` on the server is older than this build. Upload the whole folder. |
| `SMS verification is ON but the deployment cannot send codes` | Script Properties missing. The line names which. |
| `deployed script is build …, this site expects …` | `Code.gs` was edited but not redeployed as a **New version**. |
| `Verification is unavailable right now` on the page | Same as above, as the visitor sees it. The console has the real reason. |
| Twilio error 21608 in the log | Trial account, unverified destination number. |
| Twilio error 60200 | The number was rejected — usually not a real mobile. |
| Twilio error 60203 | Too many sends for that number at Twilio's end. Wait it out. |

Failures are also visible in the Twilio console under **Monitor → Logs → Verify**,
and in Apps Script under **Executions**.
