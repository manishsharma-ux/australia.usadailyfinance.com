# Solar Rebates form — Google Sheet + thank-you page

The form now skips SMS verification. When the phone number is entered and the
user clicks Next, every answer is written to your Google Sheet and the browser
lands on `thanks.html`.

---

## 1. Deploy the Apps Script

1. Open the sheet → **Extensions → Apps Script**.
2. Delete the placeholder and paste all of `google-apps-script/Code.gs`.
3. Run `testInsert` once from the editor and approve the permission prompt. A test
   row should appear — delete it afterwards.
4. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the `/exec` URL.

> After any edit to `Code.gs`, use **Deploy → Manage deployments → edit → New version**.
> Without this the live URL keeps serving the old code.

### The functions you can run from the editor

Pick one from the dropdown at the top of the Apps Script editor and press **Run**,
then read **Execution log**.

| Function | What it does |
|---|---|
| `testHeaderMapping` | **Writes nothing.** Prints every header in your sheet next to the value that will fill it, and flags any it does not recognise. Run this first after renaming, adding or reordering a column. |
| `testInsert` | Writes one residential row, existing solar + age. Delete the row afterwards. |
| `testNoExistingSolar` | Writes one residential row with no existing solar — the path that now also fills Roof Type, Home Age and Roof Shade. |
| `testRenterReferral` | Writes one renter row: Home Ownership plus the two landlord columns, everything else blank. |

`testHeaderMapping` on the current sheet should print `Every header maps to a
value.` and `Every value has a column.` Anything else names the column at fault.

## 2. Point the form at it

In `index.html`, in the config `<script>` block near the bottom:

```js
var GOOGLE_SHEET_WEBAPP_URL = 'https://script.google.com/macros/s/AKfy.../exec';
var SKIP_OTP_VERIFICATION   = true;    // false restores the SMS flow
var USE_LOCAL_THANK_YOU     = true;    // false uses the URLs in LEAD_TYPE_CONFIG
var LOCAL_THANK_YOU_URL     = 'thanks.html';
var ALSO_SEND_TO_ZAPIER     = false;
var MAPS_API_KEY            = 'AIzaSy...';
var MAPS_COUNTRIES          = ['au'];  // [] for worldwide while testing
```

That block is the only place you need to edit.

---

## 3. Sheet layout

Row 1 is these fifteen headers:

| Date | Name | Phone number | Property address | Email address | Home Ownership | Energy System | Existing Solar | Solar Age | Roof Type | Home Age | Roof Shade | Bill range - quarterly | Landload Name | Landload Phone |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

If the sheet is empty the script writes them for itself, bolds them and freezes
row 1. If row 1 already has content the script leaves it alone and matches
columns by header text, case-insensitively — so **clear any leftover rows from
earlier testing** before going live, or new leads will be mapped against stale
headers.

Because the match is on header text, the columns can be **reordered or renamed
in the sheet without touching `Code.gs`**. Common rewordings are already
understood (`Homeowner`, `Product Type`, `Shading`, `Bill Range`, `Mobile`,
`Landlord's Phone`…) — see `HEADER_ALIASES` in the script. A header the script
does not recognise simply stays blank; nothing breaks and no other column
shifts.

### How each column is filled

| Column | Source |
|---|---|
| Date | Server time at write, `dd/MM/yyyy HH:mm`, in `TIMEZONE` (default `Australia/Sydney`) |
| Name | `FirstName` + `LastName` |
| Phone number | `PhoneNumber` in E.164, `+61412345678`, prefixed with `'` so Sheets stores it as text rather than reading the `+` as a formula |
| Property address | `Street`, `City`, `Postcode` joined with commas |
| Email address | `EmailAddress` |
| Home Ownership | `Homeowner` (Own / Rent); falls back to `OwnOrLease` on the commercial path |
| Energy System | `ProductType` — Solar Only / Solar & Battery / Battery Only |
| Existing Solar | `ExistingSolar` — Yes / No |
| Solar Age | `ExistingSolarAge` — only asked of someone who answered Yes above, so blank otherwise |
| Roof Type | `RoofType` — Tin / Tile / Other |
| Home Age | `HomeAge` — 0-10 / 10-20 / 20+ Years |
| Roof Shade | `ShadingIssues` — No / Minor / Major Shading Issues, or I'm Not Sure |
| Bill range - quarterly | `BillSizeCommercial` if present, otherwise `BillSize` — both questions ask about the quarterly bill |
| Landload Name | `LandlordName` — renter branch only |
| Landload Phone | `LandlordPhone` in E.164 — renter branch only |

**Blank cells are answers the funnel never asked for, not dropped data.** A
renter is taken out of the funnel at question two and asked for their landlord's
details instead, so their row carries the two landlord columns and nothing else.
Someone without existing solar is never asked its age.

### Verified end-to-end

The form was driven through a full residential run in a headless browser and the
captured payload mapped to:

```
Date                    | 17/09/2026 18:52
Name                    | Test Lead
Phone number            | '+61412345678
Property address        | 12 Smith Street, Bondi, 2026
Email address           | test@example.com
Home Ownership          | Own
Energy System           | Solar & Battery
Existing Solar          | Yes
Solar Age               | More Than 5 Years
Roof Type               | Tin
Home Age                | 10 - 20 Years
Roof Shade              | Minor Shading Issues
Bill range - quarterly  | $900 - $1,200
Landload Name           | (blank - not a renter)
Landload Phone          | (blank - not a renter)
```

And the renter branch:

```
Home Ownership          | Rent
Landload Name           | Jane Landlord
Landload Phone          | '+61498765432

every other column blank - the funnel ends before it asks
```

---

## 4. Thank-you page

`thanks.html` ships with the form and reuses the site's nav, footer and
`css/style.css`, so it matches the enquiry page rather than looking bolted on.

It reads `sessionStorage['solarrebates_lead_data']` — written just before the
redirect — and personalises the heading with the first name, names the phone
number the specialist will call, and lists back what was submitted. Opened
directly, with no session data, it falls back to the generic confirmation
instead of showing an empty panel.

To use your live external thank-you pages instead, set
`USE_LOCAL_THANK_YOU = false` and the `LEAD_TYPE_CONFIG` URLs take over
(different page per lead type, as before).

---

## 5. Reliability notes

**CORS.** The POST goes out as `text/plain;charset=utf-8` so the browser treats
it as a simple request and skips the preflight Apps Script cannot answer.
`Code.gs` reads the body with `JSON.parse(e.postData.contents)`.

**No lost leads.** If the fetch is blocked or slow, `navigator.sendBeacon` sends
the same payload — beacons survive page unload, so the redirect can't cancel it.
`Code.gs` de-dupes on `event_id` (held in script properties, pruned after 7
days) so the belt-and-braces sending can't produce duplicate rows. Script
properties are used rather than a sheet column so your seven columns stay
exactly as specified.

**Zapier.** With OTP skipped, `process.php` never runs, so the Zapier webhooks
and notification email no longer fire. Set `ALSO_SEND_TO_ZAPIER = true` to POST
the payload straight from the browser to the URLs already in `LEAD_TYPE_CONFIG`.

---

## 6. Before this goes live

- **The endpoint is unauthenticated.** Anyone reading your page source can POST
  junk rows. Add a shared token: put `var FORM_TOKEN = 'something-random'` in the
  config, include it in the payload, and reject mismatches in `doPost`. It won't
  stop a determined attacker but it filters drive-by spam.
- **No OTP means no phone validation.** The inputmask still enforces the AU
  mobile format, but nothing proves the number is real. Expect lead quality to
  drop on paid traffic.
- **Apps Script quotas** are roughly 20k web-app calls/day on a consumer Google
  account. Fine for a lead form.

---

## 7. Earlier fixes in this build

**Options were not clickable.** The page was saved from a Cloudflare site with
Rocket Loader on, so every script tag carried the placeholder type
`749db1420d5587754766b761-text/javascript`. Browsers skip unknown script types,
so jQuery and `custom.js` never ran — clicking an option checked the radio via
CSS but nothing listened for the `change` event. Removed: 7 tokenised script
types, 2 `__cfRLUnblockHandlers` onclick guards, 2 `data-cf-modified` attributes,
the `rocket-loader.min.js` tag, and the Zaraz block (which only works behind the
Cloudflare zone it was configured for). The `defer` attributes stay, so
execution order is unchanged.

**Address autocomplete found nothing.** Two causes. The field was hardcoded to
`country: "au"`, so any non-Australian address returned zero suggestions — now
`MAPS_COUNTRIES`, set to `[]` while testing outside Australia. And the API key is
referrer-restricted to `solarrebates.com.au`, so on any other domain Google
returns `RefererNotAllowedMapError` and the dropdown silently never appears — the
key is now `MAPS_API_KEY` in the config block.

`maps-autocomplete.js` also gained: `window.gm_authFailure` (Google calls it on
key rejection; previously the failure was silent), an 8-second watchdog plus
`script.onerror` that shows a "type your address manually" note instead of a dead
dropdown, a `street_number` fallback for named buildings and rural lots, and
binding that works regardless of `readyState` — it previously bound on
`DOMContentLoaded`, which Rocket Loader fires scripts *after*, so the loader was
often never attached at all.

### Diagnosing Maps on your own domain

Focus the address field and read the console:

| Console line | Meaning |
|---|---|
| `[Maps] Autocomplete ready. Country restriction: au` | Working — you're typing a non-AU address |
| `RefererNotAllowedMapError` | Domain not in the key's website restrictions |
| `ApiNotActivatedMapError` | Places API not enabled on that project |
| `BillingNotEnabledMapError` | No billing account on the project |
| `InvalidKeyMapError` / `ExpiredKeyMapError` | Key is wrong or revoked |
| `[Maps] No callback after 8s` | Key rejected, or the request never reached Google |

Google deprecated `places.Autocomplete` for **new** API projects in March 2025 in
favour of `PlaceAutocompleteElement`. Your existing key is unaffected, but a fresh
Cloud project would need this file migrated.

---

## 8. Built-in self-check

`js/diagnostics.js` loads before everything else. It captures every script error
and failed file, then reports what actually loaded.

- It stays **invisible** when the form is healthy.
- It shows a panel automatically when the form is broken.
- Add `?debug=1` to the URL to see it regardless.

It also reports whether the last option click advanced the form, which turns
"clicks aren't working" into a specific cause:

```
FAIL  jQuery loaded          — js/jquery-3.2.1.min.js did not run
FAIL  custom.js ran          — calculateProgress is undefined
FAIL  option click handler   — NOT bound — clicks will do nothing
step: CustomerType | last click did NOT advance (CustomerType)

Scripts were skipped rather than failing. Check the script tags in index.html
for a type="..." attribute — anything other than text/javascript is ignored.
```

### Reading the result

| Panel says | Cause |
|---|---|
| Files that failed to load | Wrong path or the `js/` folder wasn't uploaded — the listed URLs 404 |
| Scripts were skipped rather than failing | Rocket Loader `type` attributes are back on the tags |
| jQuery PASS but click handler FAIL | A JavaScript error stopped `custom.js` midway — the error is listed below |
| Everything PASS but clicks still dead | Send me the panel text |

**Delete the `<script src="js/diagnostics.js">` tag from `index.html` before
production.** It's a development aid, not something to ship.

### If your live site is behind Cloudflare

Rocket Loader is applied by Cloudflare at the edge — it rewrites your HTML on
the way out, so it will re-add those `type="<token>-text/javascript"` attributes
to whatever you upload. My edits to `index.html` cannot prevent that. If the
live site breaks the same way, turn it off in the Cloudflare dashboard under
**Speed → Optimization → Rocket Loader**, or add a Configuration Rule disabling
it for this path.

---

## 9. Phone number validation

Relaxed by default — any digits, any length, no format mask:

```js
var STRICT_PHONE_VALIDATION = false;  // accept anything
var PHONE_MIN_DIGITS        = 1;      // 1 = just not empty
```

Set `STRICT_PHONE_VALIDATION = true` to restore the AU mobile mask
(`04XX XXX XXX`, enforced as you type).

Every completeness check now runs through `srPhoneOk()` in `custom.js` rather
than calling `inputmask("isComplete")` directly, so both modes are handled in
one place — the Next button, the validator, the OTP path and the sheet
submission all read the same rule. In strict mode, if the inputmask ever fails
to initialise, `srPhoneOk()` falls back to a 10-digit count instead of throwing
and blocking the form outright.

The mask is only applied in strict mode. In relaxed mode the field is a plain
`tel` input with the placeholder "Your phone number" — the old
`0 4 _ _  _ _ _  _ _ _` placeholder would otherwise imply a format that is no
longer required.

The line under the question read *"You will be required to verify this mobile
number."* With OTP skipped that's no longer true, so it now reads *"We'll use
this number to call you about your enquiry."*

### Verified both ways

| Mode | Phone entered | Result |
|---|---|---|
| `STRICT_PHONE_VALIDATION = false` | `12345` | Submits — row written with `'12345` |
| `STRICT_PHONE_VALIDATION = true` | `12345` | Blocked at the phone step, as before |

**Worth weighing.** Nothing now checks the number is reachable — no format rule,
no OTP. On paid traffic that means paying for leads your team can't call. If
this is only to unblock testing, flip `STRICT_PHONE_VALIDATION` back to `true`
before launch. If it's permanent because you need non-AU numbers, a middle
ground is `PHONE_MIN_DIGITS = 8`, which rejects obvious junk without imposing an
Australian format.

---

## 10. "There was some problem" on the phone step

That text comes from one place — the `sendCode()` error handler in `custom.js`:

```js
error: function (error) {
    $('#PhoneNumber .error-holder').html('... There was some problem')
}
```

`sendCode()` POSTs to `process.php`. It only runs on the SMS path, which
`SKIP_OTP_VERIFICATION = true` bypasses entirely. Seeing that message proves the
server is serving the **old** `custom.js`, and that `process.php` isn't
responding there either.

### Why the old file keeps coming back

The self-check reported `js/custom.js — DIFFERENT VERSION on the server` while
`index.html` was clearly the new one. HTML is usually served fresh; `.js` files
are cached aggressively by Cloudflare and by the browser. So the new markup was
loading against stale scripts.

Every local script and stylesheet is now versioned:

```html
<script src="js/custom.js?v=20260910b" defer></script>
```

A different URL cannot hit the old cache entry. Bump `?v=` on every deploy. If
it still serves stale files, purge in Cloudflare under **Caching → Configuration
→ Purge Everything**.

## 11. Phone field rewritten

```html
<div class="answers-container">
    <input type="tel" name="PhoneNumber" placeholder="Your phone number"
           required="" id="PhoneNumber-field" autocomplete="off">
```

Three attributes were removed, and each one was doing validation work:

| Removed | What it did |
|---|---|
| `data-phone="1"` | The hook `validateData()` uses to run the AU-mobile completeness check. Gone, so **no version of custom.js can validate the number** — including a cached one. |
| `inputmode="numeric"` | Drove a keyup handler that stripped every non-digit, so `+91 98765 43210` lost its `+` and spaces. |
| `data-icon="au_flag"` + the `au_flag` class | Painted an Australian flag on a field that now takes any country's number. |

`custom.js` additionally calls `inputmask('remove')` in relaxed mode, so a cached
script that already applied the mask gets it stripped rather than leaving
`1 2 3 4  5 _ _  _ _ _` in the field.

### Verified against a stale deployment

The new `index.html` was run against the **original** `custom.js` to confirm the
markup change stands on its own:

```
data-phone attribute : (removed)
placeholder          : Your phone number
validateData() error : false
Next button disabled : false
```

Junk numbers pass validation even on the old script. The OTP error, though, only
disappears once the new `custom.js` is actually being served — which is what the
`?v=` versioning is for.

---

## 12. Endpoint wired in

`index.html` now points at:

```
https://script.google.com/macros/s/AKfycbw0B4Jn.../exec
```

**Note the URL form.** The Apps Script editor showed you the Workspace variant:

```
https://script.google.com/a/macros/vcommission.com/s/<id>/exec
```

That path is scoped to your Google Workspace domain and can bounce anonymous
visitors — your form's actual users — to a Google sign-in page. The generic
`/macros/s/<id>/exec` is the public endpoint. Same deployment, same script ID,
no domain gate.

### Test it without submitting a fake lead

Open the form with `?debug=1`:

```
https://your-domain/solar1/index.html?debug=1
```

The panel pings the endpoint with `{ping: true}`. `Code.gs` answers with the
sheet name, row count and header list, and writes nothing.

| Panel line | Meaning |
|---|---|
| `PASS sheet endpoint — reachable — tab "Sheet1", 0 rows, columns: Date \| Name \| ...` | Working. Check the columns match your sheet. |
| `FAIL — Google returned a login page — the deployment is not set to "Anyone"` | Workspace access restriction, see below |
| `FAIL — responded but without pong — Code.gs is an older version` | Redeploy with a new version |
| `FAIL — unreachable — ...` | Wrong URL, or the deployment was deleted |

All four paths were tested against stubbed responses.

### If it returns a login page

A `vcommission.com` Workspace account may not offer **Anyone** in the access
dropdown if an admin restricts external sharing. Options, best first:

1. In **Deploy → Manage deployments → edit**, set *Who has access* to **Anyone**.
   If the option is missing, the domain policy is blocking it.
2. Ask your Workspace admin to allow anonymous web app access, or to permit it
   for this project.
3. Deploy the same `Code.gs` from a personal Google account that has edit
   access to the sheet. The script runs as that account, so the sheet doesn't
   move — only the deployment owner changes.

**Redeploy after adding the ping handler.** `Code.gs` gained the `ping` branch,
so it needs a new version: **Deploy → Manage deployments → edit → New version**.
Until you do, the check will report "responded but without pong".

---

## 13. Thank-you page shown but no row in the sheet

This was a flaw in `srPostToSheet()`. It read the response and then returned
`{ok: true}` regardless of what came back, and the `.catch()` also returned
`{ok: true}`. So a Google login page, an Apps Script error, or a blocked request
all counted as success, the redirect fired, and the lead vanished silently.

The response is now actually inspected:

| Response | Result |
|---|---|
| `{"ok":true,"row":N}` | Success — redirect to the thank-you page |
| HTML containing "Sign in" | `Google returned a sign-in page — the deployment is not set to "Anyone"` |
| Any other HTML | `The endpoint returned HTML instead of JSON — check the deployment URL` |
| `{"ok":false,"error":...}` | The script's own error text is shown |
| fetch rejects | `The request was blocked (CORS or network). A background beacon was sent as a backup.` |

On failure the lead is stashed in `localStorage` and retried automatically on the
next page load, so nothing is lost while you sort the endpoint out.

```js
var SHEET_SUBMIT_STRICT = true;   // show the reason on screen instead of the thank-you page
var SHEET_SUBMIT_STRICT = false;  // always thank the user; log and retry failures quietly
```

Keep it `true` until the first real row lands, then switch to `false` so a
transient Google outage never shows an error to a lead.

### Verified

Driven through a full submission against three stubbed endpoints:

```
endpoint OK          -> on-screen: (redirected)              stashed: 0
login page returned  -> on-screen: Not saved to the sheet.
                        Google returned a sign-in page…      stashed: 1
network blocked      -> on-screen: Not saved to the sheet.
                        The request was blocked…             stashed: 1
```

### What to do on your site

1. Upload this build and open `https://australia.usadailyfinance.com/solar1/?debug=1`.
2. Read two lines in the panel:
   - `js/custom.js version` — FAIL means the old script is still being served;
     the `?v=` on the tags plus a Cloudflare purge fixes it.
   - `sheet endpoint` — tells you whether Google is answering or showing a login page.
3. Submit once normally. If the row doesn't land you now get the reason on
   screen instead of a thank-you page.

---

## 14. "The reply could not be read (CORS or network)"

The browser rejected the request before any response came back. With Apps Script
that almost always means **the deployment is not public**: Google 302-redirects
an unauthenticated caller to `accounts.google.com`, which sends no CORS headers,
so `fetch` fails rather than returning the login page as readable text.

A third transport was added for the case where it genuinely is CORS: a hidden
`<iframe>` with a real form POST. Cross-origin form submissions aren't subject to
CORS, so the payload is delivered even when `fetch` is blocked. `Code.gs` accepts
it as a form-encoded `payload` field, and both transports produce an identical
row:

```
transport 1: fetch / beacon (text-plain JSON)   parsed keys: 10
transport 2: hidden-iframe form POST            parsed keys: 10
identical to transport 1: true

date                   | 10/09/2026 14:32
name                   | Manish Sharma
phone number           | '8595684896
property address       | 12 Smith Street, Bondi, 2026
email address          | manishsharma6501@gmail.com
bill range - quarterly | $300 - $600
solar                  | No
```

That still can't fix an authentication wall — a login redirect just lands inside
the iframe. So it splits the two causes for you: **if a row appears now, it was
CORS. If it still doesn't, it's the deployment's access setting.**

### The decisive test

Open the `/exec` URL in a **private/incognito window** (signed out of Google):

```
https://script.google.com/macros/s/AKfycbw0B4Jn.../exec
```

| What you see | Meaning |
|---|---|
| `{"ok":true,"status":"Solar Rebates sheet endpoint is live"}` | Public. Working. |
| A Google sign-in page | Not public — this is your problem |
| "Sorry, unable to open the file" | Wrong URL, or the deployment was deleted |

### Fixing the access setting

**Deploy → Manage deployments → pencil icon**, and check *both* dropdowns:

- **Execute as: Me (your@vcommission.com)** — if this is set to *User accessing
  the web app*, Google must identify every caller, which forces the login
  redirect. This is the more commonly missed of the two.
- **Who has access: Anyone** — not *Anyone with a Google Account*, and not
  *Anyone within vcommission.com*. Only plain **Anyone** works for anonymous
  visitors.

Save as a **New version**, not a description edit.

If **Anyone** isn't in the dropdown at all, a Workspace admin policy is blocking
anonymous web apps on `vcommission.com`. Two ways round it:

1. Ask the admin to allow it for this project.
2. Deploy the same `Code.gs` from a personal Gmail account that has edit access
   to the sheet. The script runs as that account, so the sheet stays exactly
   where it is — only the deployment owner changes. Paste the new `/exec` URL
   into `index.html`.

Leads that failed meanwhile are held in `localStorage` and retried on the next
page load, so they'll flow in once the endpoint answers.

---

## 15. JSONP transport — turning "maybe" into a definite answer

The beacon and hidden-iframe fallbacks deliver a payload but can't report back,
so a failure stayed ambiguous. A JSONP transport now sits between them:
a `<script>` tag is exempt from CORS *and* returns a value the page can read.

Order of attempts on submit:

1. `fetch` POST — normal path, readable
2. **JSONP GET** — CORS-exempt and readable; succeeds outright, or names the cause
3. `sendBeacon` + hidden-iframe form POST — fire-and-forget last resort

`Code.gs` gained a `doGet` that accepts `?payload=...&callback=fn` and shares the
same `handleLead()` writer as `doPost`, so both produce an identical row.
`user_agent`, `page_url` and `from_url` are dropped from the JSONP payload to
keep the query string short — none of them are columns.

### Verified

```
fetch blocked, deployment public:
  server got payload : YES — Manish 8595684896
  on-screen          : (redirected to thanks.html)

fetch blocked, deployment login-walled:
  server got payload : no
  on-screen          : Not saved to the sheet. The endpoint refused the request.
                       This is what a Google sign-in redirect looks like —
                       the deployment is not set to "Anyone".
```

`?debug=1` uses JSONP for its ping too, so the panel gives the same definitive
verdict without submitting anything.

### A GET that writes

JSONP means a URL that appends a row. With `event_id` de-duplication a replay
can't create a second row, which is enough for a lead form — but don't paste a
`?payload=` URL anywhere a crawler will find it. If you'd rather not have a
write-capable GET at all, delete the `params.payload` branch from `doGet`; you
lose the readable fallback and keep the beacon and iframe.

> **Redeploy `Code.gs` as a New version.** `doGet` and `handleLead` are new — the
> old deployment has neither.

---

## 16. "Please enter your full street address"

`validateStress()` required a building number followed by a street name, three
words minimum — `12 Smith Street` passed, `B-14 Sector 62 Noida` did not. Now
configurable, same shape as the phone:

```js
var STRICT_ADDRESS_VALIDATION = false;  // accept any typed address
var ADDRESS_MIN_CHARS         = 3;
```

### A duplicate definition, found on the way

`validateStress()` was declared **twice** with different rules — `custom.js`
required four or more words, `maps-autocomplete.js` required a leading building
number. Because `maps-autocomplete.js` loads later it silently overwrote the
first, so the `custom.js` version had never been the one running. The dead copy
is removed and all four call sites now go through one `srAddressOk()`, which
also falls back to a non-empty test if `maps-autocomplete.js` fails to load —
previously that would have thrown a ReferenceError and frozen the address step.

### Postcode too

Street, Suburb/City and Postcode appear together as one step, and the Postcode
input is hardcoded `minlength="4" maxlength="4"` — Australian format. A 6-digit
PIN would have been rejected right after the address was accepted. Relaxed mode
widens it:

```js
var POSTCODE_MIN_LENGTH = 3;
var POSTCODE_MAX_LENGTH = 10;
```

The helper line under the question now reads "Start typing to pick your address,
or type it in full" rather than "This is required to give accurate results".

### Verified

Driven through the real UI, reading the on-screen error and the Next button:

| Typed | Relaxed | Strict |
|---|---|---|
| `j` | BLOCKED | BLOCKED |
| `Sector 62` | accepted | BLOCKED |
| `B-14 Sector 62 Noida 201301` | accepted | BLOCKED |
| `12 Smith Street` | accepted | accepted |
| `Green Park` | accepted | BLOCKED |
| *(empty)* | BLOCKED | BLOCKED |

And a full manual submission with no autocomplete involved:

```
Property address | B-14, Sector 62, Noida, 201301
empty columns: none
```

Set `ADDRESS_MIN_CHARS = 1` if you want a single character to pass; at 3 a stray
keystroke still gets caught.

---

## 17. The +61 country chip on the phone fields

Both phone fields — the lead's own number and the landlord's on the renter
branch — now carry a fixed `+61` and the Australian flag inside the field's own
border. The field holds the national number after it, `412 345 678`, grouped as
you type.

```
┌──────────────┬──────────────────────────────┐
│ 🇦🇺  +61      │ 412 345 678                  │
└──────────────┴──────────────────────────────┘
```

The country code stops being something the lead can forget, mistype or double
up on. Whatever they type, paste or let their browser autofill collapses to the
same national number before it is shown back to them:

| Typed or pasted | Field shows | Stored |
|---|---|---|
| `0412345678` | `412 345 678` | `+61412345678` |
| `+61 412 345 678` | `412 345 678` | `+61412345678` |
| `0061412345678` | `412 345 678` | `+61412345678` |
| `61412345678` | `412 345 678` | `+61412345678` |
| `(04) 1234-5678` | `412 345 678` | `+61412345678` |
| `0298765432` | `298 765 432` | `+61298765432` |

A tenth digit cannot be entered, and the caret stays where the user was working
rather than jumping to the end on every keystroke — mid-number corrections still
work.

**Leads are now stored in E.164** (`+61412345678`) rather than the local
`0412345678`. That is the format a dialler, a CRM import and the Sheets column
all read the same way. `Code.gs` still writes the number with a leading `'` —
now because Sheets would otherwise read the `+` as the start of a formula. The
thank-you page spaces it back out for the reader: `+61 412 345 678`.

The chip is driven by the same switch as before:

```js
var AU_PHONE_VALIDATION     = true;   // chip on, AU format enforced
var AU_PHONE_ALLOW_LANDLINE = true;   // 2 / 3 / 7 / 8 accepted as well as 4
var STRICT_PHONE_VALIDATION = false;  // true restores the old 10-digit inputmask
```

With `AU_PHONE_VALIDATION = false` the chip does not mount and the field behaves
as it did before. `STRICT_PHONE_VALIDATION = true` also turns it off: that mode
hands the whole 10-digit local format to the inputmask, which owns the field.

### Verified

Driven through the real form in a headless browser, typing `0412345678` into the
field and reading the payload that `srBuildLeadData()` hands to the sheet:

```
field shows          | 412 345 678
phone_ok             | true
phone_number         | +61412345678
landlord_phone       | +61498765432   (pasted as "+61 498 765 432")
```

---

## 18. The sheet's extra columns

The sheet grew from 9 columns to 15. Six answers the form had always collected
but never wrote out now have a column each:

| New column | The question it answers |
|---|---|
| Home Ownership | "Do you own or rent this home?" |
| Energy System | "What are you interested in?" — Solar Only / Solar & Battery / Battery Only |
| Existing Solar | "Does the property already have solar?" |
| Solar Age | "How old is it?" — only asked when the answer above is Yes |
| Roof Type | "What type of roof?" — Tin / Tile / Other |
| Home Age | "How old is the home?" |
| Roof Shade | "Any shading over the roof?" |

The single `solar` column that used to hold `Yes (More Than 5 Years)` is
replaced by `Existing Solar` and `Solar Age` side by side, so the two can be
filtered on separately. `SOLAR_COLUMN` in `Code.gs` is gone with it — there is
no longer one column to choose a meaning for.

No frontend change was needed: the browser already sent every one of these
fields in the payload. Only `Code.gs` had to learn where to put them.

**Redeploy `Code.gs` after pasting it in** — Extensions → Apps Script → paste →
Deploy → Manage deployments → edit → Version: New version. Editing the file
alone does not change what the `/exec` URL runs.

---

## 19. "No existing solar" now takes the same path

Answering **No** to *"Do you already have solar panels?"* used to jump straight
to the quarterly-bill question, skipping Roof Type, Home Age and Roof Shade
entirely. Those three columns were therefore always blank for the majority of
leads — the ones with no system yet, who are the easiest to sell to.

Both answers now run through the same steps. The only thing **No** skips is the
age question, which only makes sense to ask of someone who said Yes:

```
Yes -> Existing Solar -> Solar Age -> Roof Type -> Home Age -> Roof Shade -> Bill range
No  -> Existing Solar ------------> Roof Type -> Home Age -> Roof Shade -> Bill range
```

The roof, the home and the shading decide what can be installed either way, so
the sheet gets the same columns from both. The progress bar's denominator went
with it — 16 steps on the Yes path, 15 on the No path.

### Verified

Both paths walked with real clicks in a headless browser, reading the steps the
form actually presented and the payload it produced:

```
Yes | Homeowner > ProductType > ExistingSolar > ExistingSolarAge > RoofType >
    | HomeAge > ShadingIssues > BillSize > Street > City > Postcode >
    | FirstName > LastName > EmailAddress > PhoneNumber          (16 steps)

No  | Homeowner > ProductType > ExistingSolar > RoofType >
    | HomeAge > ShadingIssues > BillSize > Street > City > Postcode >
    | FirstName > LastName > EmailAddress > PhoneNumber          (15 steps)
```

And the row the No path writes:

```
Existing Solar          | No
Solar Age               | (blank - never asked, correctly)
Roof Type               | Tin
Home Age                | 10 - 20 Years
Roof Shade              | Minor Shading Issues
Bill range - quarterly  | $900 - $1,200
```

The routing is re-asserted in `custom.js` on every Next, so a cached
`index.html` that still sends No straight to BillSize cannot short-circuit it.
