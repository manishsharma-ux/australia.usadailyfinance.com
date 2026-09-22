/**
 * Optimal Transnational — Lead form → Google Sheet → CRM, with Twilio Verify OTP
 * =============================================================================
 *
 * This deployment does three things for every lead, in this order:
 *
 *   1. CHECKS THE SMS CODE the visitor typed (Twilio Verify).
 *   2. WRITES THE ROW to the lead sheet, with a "Phone verified" column.
 *   3. QUEUES THE PAYLOAD for the CRM on the "CRM outbox" tab, which a
 *      one-minute trigger drains.
 *
 * 1 and 2 happen in ONE execution, from ONE browser request. There is no
 * token round-trip between them and so nothing to lose in the gap.
 *
 * ---------------------------------------------------------------------------
 * SHEET  (unchanged — the 15 columns are exactly as specified)
 * ---------------------------------------------------------------------------
 *   Date | Name | Phone number | Property address | Email address |
 *   Home Ownership | Energy System | Existing Solar | Solar Age |
 *   Roof Type | Home Age | Roof Shade | Bill range - quarterly |
 *   Landload Name | Landload Phone
 *
 * A 16th column, "Phone verified", is appended automatically the first time
 * this build runs. The 15 above are not touched, reordered or renamed. Rows
 * are written against the sheet's own header row, so columns can be moved in
 * the sheet without editing this file.
 *
 * Two more tabs appear on their own: "CRM outbox" and "OTP Log".
 *
 * ---------------------------------------------------------------------------
 * SMS VERIFICATION  (Twilio Verify, added 2026-09-22)
 * ---------------------------------------------------------------------------
 * The browser never holds a Twilio credential — anything in js/ is readable by
 * everyone who loads the page, and that token is a password to a billable
 * account. The page asks THIS script to send and check the code instead.
 *
 * Script Properties needed (Project Settings -> Script properties):
 *   TWILIO_ACCOUNT_SID          AC…   Twilio console home
 *   TWILIO_AUTH_TOKEN           the token beside it — treat as a password
 *   TWILIO_VERIFY_SERVICE_SID   VA…   Verify -> Services
 *
 * A fourth, OTP_TOKEN_SECRET, is created automatically on first use. Do not
 * delete it: doing so invalidates every verification token already issued.
 *
 * With none of them set, `checkOtpGate` lets every lead through and ?ping=1
 * reports "otp":"not_configured". A half-finished setup must not silently
 * reject a day of leads — but it must be visible, and that is where.
 *
 * ---------------------------------------------------------------------------
 * CRM FORWARDING  (added 2026-09-19, unchanged by the OTP work)
 * ---------------------------------------------------------------------------
 * The sheet row is written first and the CRM payload is queued locally, so a
 * CRM outage can never lose a lead and never slows the thank-you page.
 *
 *   CRM_URL     https://<crm domain>/api/webhooks/lead/agency
 *   CRM_SECRET  the signing secret Optimal Transnational gave you
 * then run crmSetup() once. Never paste CRM_SECRET into this file.
 *
 * ---------------------------------------------------------------------------
 * DEPLOYING
 * ---------------------------------------------------------------------------
 * Editing this file changes NOTHING about what the /exec URL runs. A
 * deployment stays pinned to the script version it was created with:
 *
 *   Deploy -> Manage deployments -> ✏️ edit -> Version: **New version** -> Deploy
 *
 * Then confirm in a PRIVATE window with <url>?ping=1. All four must be true:
 *   "build":"otp-crm-2026-09-22"   — this file, actually serving
 *   "otp":"configured"             — the three TWILIO_* properties are set
 *   "crm":{"configured":true,"trigger":true}
 *   "unmapped":[]                  — every sheet header has a value behind it
 * Raw JSON, not a Google sign-in page. A sign-in page means "Who has access"
 * is not set to Anyone, and every visitor loses their lead with no error.
 *
 * Run testEverything() first: it costs nothing and sends no SMS.
 */

/** Bump with every edit. ?ping=1 reports it; js/diagnostics.js compares it. */
var SCRIPT_BUILD = 'otp-crm-2026-09-22';

/* ------------------------------------------------------------------ */
/* Configuration — sheet                                               */
/* ------------------------------------------------------------------ */

var SHEET_ID    = '1jSAombFpIwvjqH0JWJmidKC5U50nDYxVaiDQgEzWkbo';
var SHEET_NAME  = 'Sheet1';            // falls back to the first tab if absent
var TIMEZONE    = 'Australia/Sydney';  // timezone the Date column is written in
var DATE_FORMAT = 'dd/MM/yyyy HH:mm';

/** Exact header text, in order. Written only to a sheet that has no header row. */
var HEADERS = [
  'Date',
  'Name',
  'Phone number',
  'Property address',
  'Email address',
  'Home Ownership',
  'Energy System',
  'Existing Solar',
  'Solar Age',
  'Roof Type',
  'Home Age',
  'Roof Shade',
  'Bill range - quarterly',
  'Landload Name',
  'Landload Phone'
];

/* ------------------------------------------------------------------ */
/* Configuration — OTP                                                 */
/* ------------------------------------------------------------------ */

/** Seconds a number must wait between two code requests. */
var OTP_SEND_COOLDOWN_SECONDS = 30;

/** Codes one number may request per hour, on top of Twilio's own limits. */
var OTP_MAX_SENDS_PER_HOUR = 5;

/**
 * Wrong guesses allowed per number before a new code is required.
 * Twilio cancels a verification after 5 failed checks of its own, so going
 * past that would only produce 404s that read as "expired".
 */
var OTP_MAX_CHECKS = 5;

/** Digits in the code. Must match the Verify service and index.html maxlength. */
var OTP_CODE_LENGTH = 6;

/** How long a successful verification stays good for, in seconds (24h). */
var OTP_TOKEN_TTL_SECONDS = 86400;

/** How long an approved phone+code pair replays its token, in seconds. */
var OTP_REPLAY_TTL_SECONDS = 900;

/** How long a request_id's answer is replayed, in seconds. */
var OTP_IDEMPOTENCY_TTL_SECONDS = 600;

/**
 * What happens to a lead when Twilio cannot confirm the code for a reason that
 * is NOT the visitor's fault — Twilio down, credentials broken, or the code
 * gone from Twilio's side before the check arrived.
 *
 *   true   the lead is written anyway, with "Phone verified" set to
 *          "Not verified — <reason>" so it can be filtered or called with care.
 *          It is also forwarded to the CRM carrying that same wording.
 *   false  the lead is refused and the visitor is asked for a new code.
 *
 * A wrong code ("incorrect") and an exhausted code ("rate_limited") are the
 * visitor's to fix and are always refused, whatever this says.
 */
var OTP_FAIL_OPEN = true;

/** Default dialling code for a number typed without one. */
var DEFAULT_DIAL_CODE = '+61';

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

/**
 * POST entry point. Honours ?callback= as well, because the page fires fetch
 * and JSONP together and either may be the one that arrives.
 */
function doPost(e) {
  var params = (e && e.parameter) || {};
  var out    = handleRequest(parseBody(e));
  return params.callback ? jsonpOut(params.callback, out) : jsonOut(out);
}

/**
 * GET entry point:
 *   /exec                          -> status in a browser
 *   /exec?ping=1[&callback=fn]     -> health check, writes nothing
 *   /exec?payload=...&callback=fn  -> JSONP write or OTP call
 *
 * JSONP exists because a <script> tag is not subject to CORS, and unlike a
 * beacon or a hidden form it returns a result the page can actually read.
 * Apps Script answers a fetch through a redirect the browser often refuses to
 * let the page read, so this is the transport that always works.
 */
function doGet(e) {
  var params = (e && e.parameter) || {};
  var out;

  if (params.payload) {
    try {
      out = handleRequest(JSON.parse(params.payload));
    } catch (err) {
      out = { ok: false, error: 'Could not parse payload: ' + String(err) };
    }
  } else if (params.action) {
    out = handleRequest(params);
  } else if (params.ping) {
    out = handlePing();
  } else {
    out = { ok: true, status: 'Optimal Transnational endpoint is live', build: SCRIPT_BUILD };
  }

  return params.callback ? jsonpOut(params.callback, out) : jsonOut(out);
}

/** One router for both verbs. No action means a lead, as every old caller sent. */
function handleRequest(data) {
  var action = String((data && data.action) || '').toLowerCase();

  if (action === 'send-code')         return handleSendCode(data);
  if (action === 'verify-code')       return handleVerifyCode(data);
  if (action === 'verify-and-submit') return handleVerifyAndSubmit(data);
  if (action === 'ping' || (data && data.ping)) return handlePing();

  return handleLead(data);
}

/* ------------------------------------------------------------------ */
/* Health check                                                        */
/* ------------------------------------------------------------------ */

/**
 * Confirms the deployment is public, points at the right spreadsheet, can send
 * a code and can reach the CRM — without writing a row. js/diagnostics.js
 * reads this, and so does the ?debug=1 panel on the form.
 *
 * Deliberately outside handleLead's lock: a health check that queues behind a
 * lead is a health check that times out exactly when things are busiest.
 */
function handlePing() {
  var twilio = twilioConfig();
  var out = {
    ok: true,
    pong: true,
    build: SCRIPT_BUILD,
    sheet_id: SHEET_ID,
    otp: twilio.ok ? 'configured' : 'not_configured',
    otp_error: twilio.ok ? null : twilio.error,

    // Never the secret itself — only whether one is set.
    crm: crmStatus_()
  };

  try {
    var sheet   = getSheet();
    var headers = ensureHeaders(sheet);
    var known   = buildRow({});

    out.sheet   = sheet.getName();
    out.rows    = Math.max(sheet.getLastRow() - 1, 0);
    out.headers = headers;

    // A header listed here will stay blank no matter what the form sends.
    out.unmapped = headers.filter(function (h) {
      return !known.hasOwnProperty(columnKey(h));
    });
  } catch (err) {
    out.ok = false;
    out.sheet_error = String(err);
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Leads                                                               */
/* ------------------------------------------------------------------ */

/**
 * Writes one lead: the sheet row, then the CRM queue entry.
 *
 * opts.skipGate is set only by handleVerifyAndSubmit, which has just checked
 * the code itself. Nothing reachable from the web can set it — handleRequest
 * calls this with one argument.
 */
function handleLead(data, opts) {
  // Old callers sent {ping:true} here rather than to ?ping=1. Still answered,
  // but from outside the lock now.
  if (data && data.ping) return handlePing();

  if (!data || Object.keys(data).length === 0) {
    return { ok: false, error: 'Empty payload' };
  }

  // A lead carrying a phone number has to carry the token proving the number
  // answered an SMS. Checked before the lock — a rejection touches no sheet.
  if (!(opts && opts.skipGate)) {
    var gate = checkOtpGate(data);
    if (!gate.ok) return gate;
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return { ok: false, error: 'Could not acquire lock' };
  }

  try {
    if (isDuplicate(data)) {
      return { ok: true, duplicate: true, build: SCRIPT_BUILD };
    }

    var sheet   = getSheet();
    var headers = ensureHeaders(sheet);
    var values  = buildRow(data);

    var row = headers.map(function (h) {
      var key = columnKey(h);
      return values.hasOwnProperty(key) ? values[key] : '';
    });

    sheet.appendRow(row);
    var rowNumber = sheet.getLastRow();
    rememberEventId(data.event_id, rowNumber);

    // After the sheet row, never instead of it. crmEnqueue_ cannot throw.
    crmEnqueue_(data);

    return { ok: true, row: rowNumber, build: SCRIPT_BUILD };

  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}

/** Maps the form payload onto the columns. Keys are normalised headers. */
function buildRow(d) {
  d = d || {};

  var name = [d.first_name, d.last_name]
    .filter(function (p) { return p && String(p).trim(); })
    .map(function (p) { return String(p).trim(); })
    .join(' ');

  var address = [d.street_address, d.suburb_city, d.postcode]
    .filter(function (p) { return p && String(p).trim(); })
    .map(function (p) { return String(p).trim(); })
    .join(', ');

  // Commercial and residential ask the same quarterly question on different steps.
  var bill = d.bill_size_commercial || d.bill_size || '';

  // Residential asks "Own or rent"; commercial asks "Own or lease". One column.
  var ownership = d.homeowner || d.own_or_lease || '';

  var existingSolar = d.existing_solar || '';
  var solarAge      = d.existing_solar_age || '';

  return {
    'date': Utilities.formatDate(new Date(), TIMEZONE, DATE_FORMAT),
    'name': name || d.name || '',
    'phone number': formatPhone(d.phone_number),
    'property address': address || d.property_address || '',
    'email address': d.email_address || '',

    'home ownership': ownership,
    'energy system': d.product_type || '',
    'existing solar': existingSolar,
    'solar age': solarAge,
    'roof type': d.roof_type || '',
    'home age': d.home_age || '',
    'roof shade': d.shading_issues || '',

    'bill range - quarterly': bill,

    // Renter branch only; both fields optional on that step.
    'landlord name': String(d.landlord_name || '').trim(),
    'landlord phone': formatPhone(d.landlord_phone),

    // Every row says one of: "Verified (SMS)", "Not verified — <reason>", or
    // "N/A — no phone number" for the renter branch, which never reaches OTP.
    'phone verified': String(d.otp_verified || '').trim() ||
                      (String(d.phone_number || '').trim() ? 'Not verified — no OTP' : 'N/A — no phone number'),

    // Fills the single "solar" column on a sheet still using the old
    // 9-column layout. Harmless on the current one, which has no such header.
    'solar': existingSolar && solarAge
      ? existingSolar + ' (' + solarAge + ')'
      : existingSolar
  };
}

/**
 * Keeps the number intact as text. Sheets would otherwise strip the leading
 * zero from a local number and read a leading "+" as the start of a formula —
 * the form submits E.164, +61412345678.
 */
function formatPhone(phone) {
  var p = String(phone || '').replace(/\s+/g, '');
  return p ? "'" + p : '';
}

/* ------------------------------------------------------------------ */
/* Header mapping                                                      */
/* ------------------------------------------------------------------ */

function normalise(header) {
  return String(header)
    .replace(/[‘’']/g, '')   // Landlord's Name -> landlords name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Header wordings that mean the same column. The sheet's labels are written
 * for whoever reads the sheet and get reworded; the keys in buildRow do not.
 * A header that already matches a buildRow key needs no entry.
 */
var HEADER_ALIASES = {
  'phone': 'phone number',
  'mobile': 'phone number',
  'mobile number': 'phone number',
  'phone no': 'phone number',
  'contact number': 'phone number',

  'address': 'property address',
  'property': 'property address',
  'street address': 'property address',

  'email': 'email address',

  'homeowner': 'home ownership',
  'home owner': 'home ownership',
  'ownership': 'home ownership',
  'own or rent': 'home ownership',
  'own/rent': 'home ownership',

  'product type': 'energy system',
  'product': 'energy system',
  'system': 'energy system',
  'system type': 'energy system',
  'energy system type': 'energy system',

  'has solar': 'existing solar',
  // Deliberately no 'solar' entry: a sheet still on the old 9-column layout
  // has one "solar" column and no Solar Age beside it, so it keeps the
  // combined "Yes (More Than 5 Years)" value that buildRow writes for it.

  'existing solar age': 'solar age',
  'age of solar': 'solar age',
  'solar system age': 'solar age',

  'roof': 'roof type',

  'property age': 'home age',
  'age of home': 'home age',

  'shade': 'roof shade',
  'shading': 'roof shade',
  'roof shading': 'roof shade',
  'shading issues': 'roof shade',

  // The verification column. Renaming it in the sheet must not start writing
  // blanks, and "Verified" is what someone reading the sheet will type.
  'verified': 'phone verified',
  'otp': 'phone verified',
  'otp verified': 'phone verified',
  'sms verified': 'phone verified',
  'number verified': 'phone verified',
  'mobile verified': 'phone verified',
  'phone verification': 'phone verified',

  'bill range': 'bill range - quarterly',
  'bill range quarterly': 'bill range - quarterly',
  'bill size': 'bill range - quarterly',
  'quarterly bill': 'bill range - quarterly',
  'quarterly bill range': 'bill range - quarterly'
};

/**
 * Maps a sheet header onto the buildRow key that fills it.
 *
 * The landlord columns match on shape rather than on one exact string: the
 * live sheet spells them "Landload", and "Landlord's phone" or "Landlord
 * Mobile Number" are all things someone will reasonably type. Renaming the
 * column should not silently start writing blanks.
 */
function columnKey(header) {
  var key = normalise(header);

  if (key.indexOf('land') === 0) {
    if (key.indexOf('name') !== -1) return 'landlord name';
    if (/phone|mobile|number|contact/.test(key)) return 'landlord phone';
  }

  return HEADER_ALIASES[key] || key;
}

/* ------------------------------------------------------------------ */
/* Sheet plumbing                                                      */
/* ------------------------------------------------------------------ */

/**
 * One spreadsheet handle per execution. openById is the slowest call in this
 * file (~1s), and a verify-and-submit would otherwise make it four times: the
 * lead row, the OTP log, the CRM outbox and the row upgrade. Once is enough.
 */
var SPREADSHEET_ = null;
function getSpreadsheet() {
  if (!SPREADSHEET_) SPREADSHEET_ = SpreadsheetApp.openById(SHEET_ID);
  return SPREADSHEET_;
}

function getSheet() {
  var ss = getSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
}

/**
 * Returns the sheet's header row. Writes HEADERS if the sheet is empty;
 * otherwise leaves whatever is there alone, so your own labels win.
 */
function ensureHeaders(sheet) {
  if (sheet.getLastRow() === 0) {
    var range = sheet.getRange(1, 1, 1, HEADERS.length);
    range.setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return HEADERS;
  }
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  // The verification outcome needs somewhere to go. If the sheet has no
  // column for it, one is added at the END — the 15 existing columns are
  // untouched, and nothing else in this file depends on the count.
  var hasVerified = headers.some(function (h) { return columnKey(h) === 'phone verified'; });
  if (!hasVerified) {
    var col = headers.length + 1;
    sheet.getRange(1, col).setValue('Phone verified').setFontWeight('bold');
    headers.push('Phone verified');
  }
  return headers;
}

/* ------------------------------------------------------------------ */
/* Duplicate leads                                                     */
/* ------------------------------------------------------------------ */

/**
 * The browser may send the same lead twice (fetch plus the JSONP backup).
 * Event IDs are held in script properties rather than a sheet column, so the
 * columns stay exactly as specified.
 *
 * All of them live in ONE property, as a { event_id: "<timestamp>:<row>" }
 * map. They used to get a property each, which is a problem the dedupe itself
 * never shows: the Script Properties screen turns read-only past 50
 * properties, so a busy week silently takes away the only way to add or edit
 * CRM_URL by hand. Run pruneEventIdProperties() once to fold any leftover
 * evt_ keys in here.
 *
 * The row number rides along with the timestamp because handleVerifyAndSubmit
 * needs it: a lead written unverified and then verified on a retry has to have
 * its "Phone verified" cell corrected rather than being written twice. Values
 * saved by the previous build are bare timestamps and still read correctly.
 */
var EVENT_ID_PROP   = 'recent_event_ids';
var EVENT_ID_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A single property value is capped at 9 KB. An id plus its stamp is about
// 65 bytes, so this leaves room to spare; whichever limit bites first wins.
var EVENT_ID_MAX    = 120;

/** When an entry was written. Accepts both "<ts>:<row>" and a bare <ts>. */
function eventIdWhen_(value) {
  return Number(String(value).split(':')[0]) || 0;
}

/** The sheet row an entry was written to, or 0 if it predates the row stamp. */
function eventIdRow_(value) {
  var parts = String(value).split(':');
  return parts.length > 1 ? (Number(parts[1]) || 0) : 0;
}

function readEventIds_() {
  var raw = PropertiesService.getScriptProperties().getProperty(EVENT_ID_PROP);
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch (err) {
    return {};   // corrupt value: treat as empty rather than refusing leads
  }
}

function isDuplicate(data) {
  if (!data || !data.event_id) return false;
  return readEventIds_().hasOwnProperty(String(data.event_id));
}

function rememberEventId(eventId, row) {
  if (!eventId) return;

  var seen = readEventIds_();
  seen[String(eventId)] = String(Date.now()) + ':' + (Number(row) || 0);
  PropertiesService.getScriptProperties()
    .setProperty(EVENT_ID_PROP, JSON.stringify(trimEventIds_(seen)));
}

/** Row number an event_id was written to, or 0 if not known. */
function rowForEventId(eventId) {
  if (!eventId) return 0;
  var row = eventIdRow_(readEventIds_()[String(eventId)]);
  return row > 1 ? row : 0;
}

/**
 * Sets the "Phone verified" cell of an already-written row.
 *
 * Used when a lead reached the sheet unverified and the visitor then passed
 * the code on a retry carrying the same event_id. Writing the lead twice would
 * be worse than either outcome, and leaving the cell wrong worse still.
 */
function markRowVerified(eventId, value) {
  try {
    var row = rowForEventId(eventId);
    if (!row) return false;
    var sheet   = getSheet();
    var headers = ensureHeaders(sheet);
    var col     = headers.map(columnKey).indexOf('phone verified') + 1;
    if (!col) return false;
    sheet.getRange(row, col).setValue(value);
    return true;
  } catch (err) {
    return false;
  }
}

/** Drops anything past the TTL, then anything past the count cap, newest first. */
function trimEventIds_(seen) {
  var cutoff = Date.now() - EVENT_ID_TTL_MS;
  Object.keys(seen).forEach(function (k) {
    if (!(eventIdWhen_(seen[k]) >= cutoff)) delete seen[k];
  });

  var keys = Object.keys(seen);
  if (keys.length > EVENT_ID_MAX) {
    keys.sort(function (a, b) { return eventIdWhen_(seen[b]) - eventIdWhen_(seen[a]); })
        .slice(EVENT_ID_MAX)
        .forEach(function (k) { delete seen[k]; });
  }
  return seen;
}

/**
 * ONE-OFF, run from the editor. Folds the old one-property-per-lead evt_ keys
 * into the single map above and deletes them.
 *
 * This is what to run when Project Settings says "Your script has more than 50
 * properties ... the above list is read-only" and there is no way to add
 * CRM_URL or the TWILIO_* values. Afterwards, reload Project Settings and the
 * fields are editable again. Safe to run more than once.
 */
function pruneEventIdProperties() {
  var props = PropertiesService.getScriptProperties();
  var all   = props.getProperties();
  var seen  = readEventIds_();
  var cutoff = Date.now() - EVENT_ID_TTL_MS;
  var moved = 0, expired = 0;

  Object.keys(all).forEach(function (k) {
    if (k.indexOf('evt_') !== 0) return;
    var when = Number(all[k]);
    if (when >= cutoff) {
      seen[k.slice(4)] = String(when) + ':0';   // 'evt_' is 4 characters
      moved++;
    } else {
      expired++;
    }
    props.deleteProperty(k);
  });

  props.setProperty(EVENT_ID_PROP, JSON.stringify(trimEventIds_(seen)));

  var left = Object.keys(props.getProperties());
  Logger.log(
    'Folded ' + moved + ' recent event id(s) into ' + EVENT_ID_PROP + ', ' +
    'discarded ' + expired + ' expired.\n' +
    'Script properties now: ' + left.length + ' (' + left.sort().join(', ') + ')\n' +
    (left.length < 50
      ? 'Under 50 — reload Project Settings and the fields are editable again.'
      : 'STILL ' + left.length + ' — something other than evt_ keys is filling it.')
  );
}

/**
 * Sets CRM_URL and CRM_SECRET without the Project Settings screen, for when it
 * is read-only and you would rather not wait. Paste the secret, run it once,
 * then CLEAR THE LINE AGAIN AND SAVE — an editor file is not where a signing
 * secret should live, which is the whole reason these are script properties.
 *
 * Prefer pruneEventIdProperties() and the normal screen if you can.
 */
function crmSetCredentials() {
  var CRM_URL_    = 'https://crm.optimaltransnational.com.au/api/webhooks/lead/agency';
  var CRM_SECRET_ = '';   // <-- paste, run, clear, save

  if (!CRM_SECRET_) {
    Logger.log('Paste the secret into CRM_SECRET_ first, then run this again.');
    return;
  }

  PropertiesService.getScriptProperties()
    .setProperties({ CRM_URL: CRM_URL_, CRM_SECRET: CRM_SECRET_ }, false);

  Logger.log('Set. ' + JSON.stringify(crmStatus_()) +
             '\nNow clear CRM_SECRET_ in this function and save.');
}

/* ------------------------------------------------------------------ */
/* Request / response plumbing                                         */
/* ------------------------------------------------------------------ */

function parseBody(e) {
  if (!e) return {};

  if (e.postData && e.postData.contents) {
    try {
      return JSON.parse(e.postData.contents);
    } catch (err) {
      // not JSON — fall through to form params
    }
  }

  var params = e.parameter || {};
  if (params.payload) {
    try { return JSON.parse(params.payload); } catch (err) { /* ignore */ }
  }
  return params;
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonpOut(callback, obj) {
  // Only allow a plain identifier as the callback name.
  var safe = String(callback).replace(/[^A-Za-z0-9_$]/g, '') || 'callback';
  return ContentService
    .createTextOutput(safe + '(' + JSON.stringify(obj) + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

/** Cache keys may not contain spaces or punctuation that upsets the store. */
function safeKey(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '').substring(0, 200);
}

/* ================================================================== */
/* SMS verification — Twilio Verify                                    */
/* ================================================================== */

/**
 * The Twilio auth token is a password to a billable account, so it lives in
 * Script Properties, never in this file — the file gets copied and shared,
 * the properties do not:
 *
 *   ⚙ Project Settings → Script Properties → Add
 *     TWILIO_ACCOUNT_SID          ACxxxxxxxx…  (Twilio console home)
 *     TWILIO_AUTH_TOKEN           the token beside it — treat as a password
 *     TWILIO_VERIFY_SERVICE_SID   VAxxxxxxxx…  (Verify → Services)
 *
 * Twilio Verify owns the code itself: it generates it, expires it after ten
 * minutes, counts wrong guesses and rate-limits sends. No code is stored here,
 * so there is none to leak or to fall out of step with the handset.
 */
function twilioConfig() {
  var props   = PropertiesService.getScriptProperties();
  var sid     = String(props.getProperty('TWILIO_ACCOUNT_SID') || '').trim();
  var token   = String(props.getProperty('TWILIO_AUTH_TOKEN') || '').trim();
  var service = String(props.getProperty('TWILIO_VERIFY_SERVICE_SID') || '').trim();

  var missing = [];
  if (!sid)     missing.push('TWILIO_ACCOUNT_SID');
  if (!token)   missing.push('TWILIO_AUTH_TOKEN');
  if (!service) missing.push('TWILIO_VERIFY_SERVICE_SID');
  if (missing.length) {
    return { ok: false, error: 'Script Properties missing: ' + missing.join(', ') };
  }

  // The two SIDs are easy to swap and Twilio's "resource not found" says
  // nothing useful, so they are checked by prefix here instead.
  if (sid.indexOf('AC') !== 0) {
    return { ok: false, error: 'TWILIO_ACCOUNT_SID must start with AC — the stored value starts with "' + sid.substring(0, 2) + '".' };
  }
  if (service.indexOf('VA') !== 0) {
    return { ok: false, error: 'TWILIO_VERIFY_SERVICE_SID must start with VA (Verify → Services). A value starting with "' + service.substring(0, 2) + '" is a different kind of SID.' };
  }

  return { ok: true, sid: sid, token: token, service: service };
}

/** POSTs a form-encoded body to the Verify service and parses the reply. */
function twilioPost(cfg, path, payload) {
  var url = 'https://verify.twilio.com/v2/Services/' + encodeURIComponent(cfg.service) + path;

  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    payload: payload,
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(cfg.sid + ':' + cfg.token)
    },
    muteHttpExceptions: true
  });

  var body;
  try {
    body = JSON.parse(res.getContentText());
  } catch (err) {
    body = { message: String(res.getContentText() || '').substring(0, 300) };
  }

  return { status: res.getResponseCode(), body: body };
}

/**
 * Turns a Twilio failure into something worth showing a visitor. Anything not
 * listed is a setup problem rather than a visitor problem, so it falls through
 * to Twilio's own message, which is written for whoever reads the logs.
 */
var TWILIO_MESSAGES = {
  60200: 'That number was not accepted. Please check it and try again.',
  60203: 'Too many codes have been sent to this number. Please try again later.',
  60205: 'That number cannot receive text messages. Please enter a mobile number.',
  60212: 'Too many requests for this number right now. Please wait a moment.',
  60410: 'Codes to this number are temporarily blocked. Please try again later.',
  60605: 'Codes cannot be sent to that country.'
};

function twilioMessage(res) {
  var code = res && res.body && res.body.code;
  if (code && TWILIO_MESSAGES[code]) return TWILIO_MESSAGES[code];

  if (res && (res.status === 401 || res.status === 403)) {
    return 'Twilio rejected the credentials — check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.';
  }
  if (code === 20404) {
    return 'Twilio has no Verify service with that SID — check TWILIO_VERIFY_SERVICE_SID.';
  }

  return (res && res.body && res.body.message)
    ? 'Twilio: ' + res.body.message
    : 'Twilio returned HTTP ' + (res && res.status) + '.';
}

/**
 * Cancels whatever verification is pending for this number.
 *
 * Twilio Verify re-sends the SAME code while a verification is pending, and
 * only mints a new one once the old one is approved, expired or cancelled.
 * A visitor pressing "Send a new code" expects a new code, so the pending one
 * is cancelled first. A 404 here just means nothing was pending.
 */
function twilioCancelPending(cfg, phone) {
  var res = twilioPost(cfg, '/Verifications/' + encodeURIComponent(phone), { Status: 'canceled' });
  return { cancelled: res.status >= 200 && res.status < 300, status: res.status };
}

/* ------------------------------------------------------------------ */
/* OTP log — one row per send and per check, on its own tab            */
/* ------------------------------------------------------------------ */

/**
 * Every OTP call writes one line to the "OTP Log" tab of the lead sheet:
 * what came in, what Twilio answered, and what went back to the browser.
 * Phone and code are masked. Turn off with OTP_LOG_ENABLED = false.
 *
 * This exists because "the code did not verify" has a dozen causes and the
 * browser console shows one side of the exchange. This tab shows the other.
 */
var OTP_LOG_ENABLED = true;
var OTP_LOG_SHEET   = 'OTP Log';
var OTP_LOG_HEADERS = ['Time', 'Action', 'Phone', 'Code', 'Twilio HTTP', 'Twilio code',
                       'Twilio status', 'Result', 'Message', 'Request ID', 'Build'];

function otpLog(action, phone, code, twilioRes, result) {
  if (!OTP_LOG_ENABLED) return;
  try {
    var ss    = getSpreadsheet();
    var sheet = ss.getSheetByName(OTP_LOG_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(OTP_LOG_SHEET);
      sheet.getRange(1, 1, 1, OTP_LOG_HEADERS.length).setValues([OTP_LOG_HEADERS]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    var body = (twilioRes && twilioRes.body) || {};
    sheet.appendRow([
      Utilities.formatDate(new Date(), TIMEZONE, 'dd/MM/yyyy HH:mm:ss'),
      action,
      maskPhone(phone || ''),
      code ? '••••' + String(code).slice(-2) : '',
      twilioRes ? twilioRes.status : '',
      body.code || '',
      body.status || '',
      result && result.ok ? (result.replayed ? 'ok (replayed)' : result.idempotent ? 'ok (idempotent)' : 'ok')
                          : ((result && result.code) || 'error'),
      (result && result.error) || '',
      (result && result.request_id) || '',
      SCRIPT_BUILD
    ]);
  } catch (err) {
    // Logging must never fail the call it is logging.
  }
}

/* ------------------------------------------------------------------ */
/* Phone normalising                                                   */
/* ------------------------------------------------------------------ */

/**
 * Rewrites a number to E.164. The form already sends +61…, but this endpoint
 * is reachable directly and Twilio rejects anything else, so it is normalised
 * here too rather than trusted.
 *
 * Accepts  0412 345 678 · 61412345678 · 0061412345678 · +61412345678 · +91…
 * Returns  +61412345678, or '' if it is not a number Twilio will take.
 */
function toE164(raw) {
  var text = String(raw || '').replace(/[^\d+]/g, '');
  if (!text) return '';

  // Already international. Verify is not AU-only, so any country passes.
  if (text.charAt(0) === '+') {
    return /^\+[1-9]\d{7,14}$/.test(text) ? text : '';
  }

  var digits = text.replace(/\D/g, '');

  // Order matters: 0061… also starts with a 0, and a local AU number never
  // starts with 61, so the international forms are tested first.
  if (digits.indexOf('0061') === 0) {
    digits = digits.substring(4);
  } else if (digits.indexOf('61') === 0 && digits.length === 11) {
    digits = digits.substring(2);
  } else if (digits.charAt(0) === '0') {
    digits = digits.substring(1);
  }

  return /^[2-9]\d{8}$/.test(digits) ? DEFAULT_DIAL_CODE + digits : '';
}

/** Kept so older callers and the test functions below still resolve. */
function toE164Au(raw) {
  return toE164(raw);
}

/** +61412345678 -> +614•••••678, for reading back on screen and in the log. */
function maskPhone(e164) {
  var p = String(e164 || '');
  if (p.length < 5) return p;
  return p.substring(0, 4) +
         p.substring(4, p.length - 3).replace(/\d/g, '•') +
         p.substring(p.length - 3);
}

/** Cache keys are per number; the digits alone make a safe, stable key. */
function otpCacheKey(prefix, e164) {
  return prefix + String(e164).replace(/\D/g, '');
}

/* ------------------------------------------------------------------ */
/* Idempotency                                                         */
/* ------------------------------------------------------------------ */

/**
 * The browser sends each OTP call twice whenever it cannot read the fetch
 * reply. Both copies carry the same request_id, so the second is answered
 * from here and never reaches Twilio — which is the fix for a correct code
 * coming back as "expired".
 */
function idempotencyKey(data) {
  var id = data && data.request_id;
  return id ? 'otp_req_' + safeKey(id) : '';
}

function recallAnswer(key) {
  if (!key) return null;
  var stored = CacheService.getScriptCache().get(key);
  if (!stored) return null;
  try {
    var out = JSON.parse(stored);
    out.idempotent = true;
    return out;
  } catch (err) {
    return null;
  }
}

function rememberAnswer(key, answer) {
  if (key) {
    try {
      var stored = {};
      Object.keys(answer).forEach(function (k) { if (k !== '_twilio') stored[k] = answer[k]; });
      CacheService.getScriptCache().put(key, JSON.stringify(stored), OTP_IDEMPOTENCY_TTL_SECONDS);
    } catch (err) { /* an unstorable answer is not worth failing the call for */ }
  }
  return answer;
}

/* ------------------------------------------------------------------ */
/* Twilio Verify — send                                                */
/* ------------------------------------------------------------------ */

/**
 * Sends a code. The throttles below sit in front of Twilio's own: Verify bills
 * per attempt, so a script hammering this endpoint is a bill as well as a
 * nuisance, and the cheapest place to stop it is before the outbound request.
 *
 * data.resend = true means the visitor asked for a NEW code. The pending
 * verification is cancelled first, because Twilio otherwise re-sends the same
 * six digits for as long as the old one is alive.
 */
function handleSendCode(data) {
  var out = sendCodeInner(data || {});
  otpLog('send' + (data && data.resend ? ' (resend)' : ''),
         toE164(data && data.phone_number), '', out._twilio, out);
  delete out._twilio;
  return out;
}

function sendCodeInner(data) {
  var reqKey = idempotencyKey(data);
  var prior  = recallAnswer(reqKey);
  if (prior) return prior;

  var cfg = twilioConfig();
  if (!cfg.ok) {
    return { ok: false, code: 'not_configured', error: cfg.error, request_id: data.request_id };
  }

  var phone = toE164(data.phone_number);
  if (!phone) {
    return { ok: false, code: 'bad_number', error: 'That does not look like a valid mobile number.', request_id: data.request_id };
  }

  var cache  = CacheService.getScriptCache();
  var resend = data.resend === true || data.resend === 'true' || data.resend === 1 || data.resend === '1';

  if (cache.get(otpCacheKey('otp_cd_', phone))) {
    return rememberAnswer(reqKey, {
      ok: false,
      code: 'cooldown',
      error: 'A code has just been sent. Please wait a few seconds before asking for another.',
      cooldown: OTP_SEND_COOLDOWN_SECONDS,
      request_id: data.request_id
    });
  }

  var sent = Number(cache.get(otpCacheKey('otp_n_', phone)) || 0);
  if (sent >= OTP_MAX_SENDS_PER_HOUR) {
    return rememberAnswer(reqKey, {
      ok: false,
      code: 'rate_limited',
      error: 'Too many codes have been sent to this number. Please try again later.',
      request_id: data.request_id
    });
  }

  // The browser fires fetch and JSONP together, both with this request_id.
  // Serialised here so the second copy finds the first's answer in the cache
  // instead of asking Twilio for a second (billed) SMS.
  var lock   = LockService.getScriptLock();
  var locked = false;
  try { lock.waitLock(20000); locked = true; } catch (err) { /* proceed unlocked */ }

  var res, cancelled = null;
  try {
    var afterWait = recallAnswer(reqKey);
    if (afterWait) return afterWait;

    if (cache.get(otpCacheKey('otp_cd_', phone))) {
      return rememberAnswer(reqKey, {
        ok: false,
        code: 'cooldown',
        error: 'A code has just been sent. Please wait a few seconds before asking for another.',
        cooldown: OTP_SEND_COOLDOWN_SECONDS,
        request_id: data.request_id
      });
    }

    if (resend) {
      cancelled = twilioCancelPending(cfg, phone);
      cache.remove(otpCacheKey('otp_done_', phone));   // old code is dead
      cache.remove(otpCacheKey('otp_last_', phone));
    }

    res = twilioPost(cfg, '/Verifications', { To: phone, Channel: 'sms' });

    if (res.status >= 200 && res.status < 300) {
      cache.put(otpCacheKey('otp_cd_', phone), '1', OTP_SEND_COOLDOWN_SECONDS);
      cache.put(otpCacheKey('otp_n_', phone), String(sent + 1), 3600);
      cache.remove(otpCacheKey('otp_a_', phone));   // a new code, a fresh set of guesses

      return rememberAnswer(reqKey, {
        ok: true,
        sent: true,
        resend: resend,
        previous_cancelled: cancelled ? cancelled.cancelled : null,
        to: maskPhone(phone),
        cooldown: OTP_SEND_COOLDOWN_SECONDS,
        status: res.body.status || 'pending',
        request_id: data.request_id,
        _twilio: res
      });
    }
  } finally {
    if (locked) lock.releaseLock();
  }

  return rememberAnswer(reqKey, {
    ok: false,
    code: 'twilio_error',
    error: twilioMessage(res),
    twilio_status: res.status,
    twilio_code: (res.body && res.body.code) || null,
    request_id: data.request_id,
    _twilio: res
  });
}

/* ------------------------------------------------------------------ */
/* Twilio Verify — check                                               */
/* ------------------------------------------------------------------ */

/**
 * Checks a code and, on approval, mints a signed token. handleLead will not
 * write a lead carrying a phone number without one, so the sheet cannot fill
 * with numbers nobody answered.
 *
 * Four layers stop a duplicate request from turning a correct code into
 * "expired": the request_id replay, the phone+code replay, a script lock, and
 * a 404 read against the token this number already holds.
 */
function handleVerifyCode(data) {
  var out = verifyCodeInner(data || {});
  otpLog('check', toE164(data && data.phone_number), data && data.code, out._twilio, out);
  delete out._twilio;
  return out;
}

function verifyCodeInner(data) {
  var reqKey = idempotencyKey(data);
  var prior  = recallAnswer(reqKey);
  if (prior) return prior;

  var cfg = twilioConfig();
  if (!cfg.ok) {
    return { ok: false, code: 'not_configured', error: cfg.error, request_id: data.request_id };
  }

  var phone = toE164(data.phone_number);
  if (!phone) {
    return { ok: false, code: 'bad_number', error: 'That does not look like a valid mobile number.', request_id: data.request_id };
  }

  var code = String(data.code || '').replace(/\D/g, '');
  if (code.length !== OTP_CODE_LENGTH) {
    return {
      ok: false,
      code: 'bad_code',
      error: 'Please enter the ' + OTP_CODE_LENGTH + '-digit code from the text message.',
      request_id: data.request_id
    };
  }

  var cache    = CacheService.getScriptCache();
  var doneKey  = otpCacheKey('otp_done_', phone) + '_' + code;
  var lastKey  = otpCacheKey('otp_last_', phone);
  var claimKey = otpCacheKey('otp_claim_', phone) + '_' + code;

  var approvedAnswer = function (token, replayed) {
    return rememberAnswer(reqKey, { ok: true, verified: true, otp_token: token, replayed: !!replayed, request_id: data.request_id });
  };

  var replayed = cache.get(doneKey);
  if (replayed) return approvedAnswer(replayed, true);

  // The browser sends this request over two transports at once. Twilio
  // consumes a verification on approval, so only ONE copy may ever ask it
  // about a given phone+code. The lock serialises the copies; the claim
  // below is the belt to that brace, for the case where the lock is late.
  var lock   = LockService.getScriptLock();
  var locked = false;
  try {
    lock.waitLock(25000);
    locked = true;
  } catch (err) {
    // Proceeding unlocked is covered by the claim and the poll below.
  }

  var res;
  try {
    var afterWait = recallAnswer(reqKey);
    if (afterWait) return afterWait;

    var doneAfterWait = cache.get(doneKey);
    if (doneAfterWait) return approvedAnswer(doneAfterWait, true);

    // Another copy is mid-check. Do not ask Twilio; wait for its answer.
    if (cache.get(claimKey)) {
      if (locked) { lock.releaseLock(); locked = false; }
      var waited = pollForApproval(cache, doneKey, lastKey, 15000);
      if (waited) return approvedAnswer(waited, true);
      return rememberAnswer(reqKey, {
        ok: false,
        code: 'expired',
        error: 'That code has expired. Please request a new one.',
        note: 'another copy of this check was in flight and did not approve',
        request_id: data.request_id
      });
    }

    var attempts = Number(cache.get(otpCacheKey('otp_a_', phone)) || 0);
    if (attempts >= OTP_MAX_CHECKS) {
      return rememberAnswer(reqKey, {
        ok: false,
        code: 'rate_limited',
        error: 'Too many incorrect attempts. Please request a new code.',
        request_id: data.request_id
      });
    }

    cache.put(claimKey, String(data.request_id || '1'), 60);
    cache.put(otpCacheKey('otp_a_', phone), String(attempts + 1), 900);

    // Minted BEFORE the Twilio call, so that after Twilio says "approved"
    // the only work left is two cache writes. Nothing that can throw stands
    // between the approval and the record of it — an exception there is what
    // turns a correct code into a 404 for the copy that comes next.
    var token = mintOtpToken(phone);

    res = twilioPost(cfg, '/VerificationChecks', { To: phone, Code: code });

    if (res.status >= 200 && res.status < 300) {
      if (res.body.status === 'approved') {
        try { cache.put(lastKey, token, OTP_REPLAY_TTL_SECONDS); } catch (e1) {}
        try { cache.put(doneKey, token, OTP_REPLAY_TTL_SECONDS); } catch (e2) {}
        try { cache.remove(otpCacheKey('otp_a_', phone)); } catch (e3) {}
        var ok = approvedAnswer(token, false);
        ok._twilio = res;
        return ok;
      }
      return rememberAnswer(reqKey, {
        ok: false,
        code: 'incorrect',
        error: 'That code is not right. Please check the message and try again.',
        attempts_left: Math.max(OTP_MAX_CHECKS - attempts - 1, 0),
        twilio_status: res.status,
        request_id: data.request_id,
        _twilio: res
      });
    }

    // Verify answers 404 once the verification is gone — approved, cancelled,
    // or past its ten minutes. If this number was approved moments ago (or
    // is being approved right now by the other copy), the visitor is verified.
    if (res.status === 404) {
      var held = cache.get(lastKey) || pollForApproval(cache, doneKey, lastKey, 4000);
      if (held) {
        try { cache.put(doneKey, held, OTP_REPLAY_TTL_SECONDS); } catch (e4) {}
        var rec = approvedAnswer(held, true);
        rec._twilio = res;
        return rec;
      }
      return rememberAnswer(reqKey, {
        ok: false,
        code: 'expired',
        error: 'That code has expired. Please request a new one.',
        twilio_status: res.status,
        twilio_code: (res.body && res.body.code) || null,
        request_id: data.request_id,
        _twilio: res
      });
    }

    return rememberAnswer(reqKey, {
      ok: false,
      code: 'twilio_error',
      error: twilioMessage(res),
      twilio_status: res.status,
      twilio_code: (res.body && res.body.code) || null,
      request_id: data.request_id,
      _twilio: res
    });

  } finally {
    try { cache.remove(claimKey); } catch (e5) {}
    if (locked) lock.releaseLock();
  }
}

/** Waits for another execution's approval to land in the cache. */
function pollForApproval(cache, doneKey, lastKey, maxMs) {
  var until = Date.now() + maxMs;
  while (Date.now() < until) {
    var hit = cache.get(doneKey) || cache.get(lastKey);
    if (hit) return hit;
    Utilities.sleep(400);
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* Verify AND write the lead — one call                                */
/* ------------------------------------------------------------------ */

/**
 * The form's real submit. The payload is the whole lead plus the six digits.
 * The code is checked, and if the number is confirmed the row is written and
 * the CRM payload queued in the same execution — the browser never has to
 * make a second call carrying a token, so there is no gap in which a verified
 * lead can be lost.
 *
 * Outcomes, in order:
 *   verified     -> row written, "Phone verified" = Verified (SMS), CRM queued
 *   wrong code   -> refused, nothing written, visitor re-checks the message
 *   Twilio-side failure and OTP_FAIL_OPEN -> row written and CRM queued,
 *                   both marked "Not verified — <reason>"
 *   Twilio-side failure otherwise -> refused
 */
function handleVerifyAndSubmit(data) {
  data = data || {};

  var check = verifyCodeInner(data);
  otpLog('check+submit', toE164(data.phone_number), data.code, check._twilio, check);
  delete check._twilio;

  // These are the visitor's to fix; a row is not written for them.
  var visitorFault = { incorrect: 1, rate_limited: 1, bad_code: 1, bad_number: 1 };

  var verified = !!(check.ok && check.verified);
  var failOpen = !verified && OTP_FAIL_OPEN && !visitorFault[check.code];

  if (!verified && !failOpen) {
    return check;
  }

  // The six digits never travel further than this function: not into the
  // sheet, not into the CRM outbox, not into the payload the CRM receives.
  var lead = {};
  Object.keys(data).forEach(function (k) {
    if (k !== 'action' && k !== 'code' && k !== 'request_id') lead[k] = data[k];
  });
  lead.otp_verified = verified
    ? 'Verified (SMS)'
    : 'Not verified — ' + (check.code || 'twilio error') + (check.error ? ': ' + check.error : '');
  if (verified) lead.otp_token = check.otp_token;

  var written = handleLead(lead, { skipGate: true });

  // The unverified copy of this lead may have reached the sheet first, and
  // the event_id dedupe then refuses this verified one. The visitor DID pass:
  // find that row and correct its "Phone verified" cell rather than losing
  // the fact or writing the lead twice.
  if (verified && written.duplicate) {
    written.upgraded = markRowVerified(lead.event_id, lead.otp_verified);
  }

  return {
    ok: true,
    verified: verified,
    fail_open: failOpen,
    written: !!written.ok,
    duplicate: !!written.duplicate,
    upgraded: !!written.upgraded,
    row: written.row || null,
    write_error: written.ok ? null : (written.error || null),
    otp_code: verified ? null : check.code,
    request_id: data.request_id,
    build: SCRIPT_BUILD
  };
}

/* ------------------------------------------------------------------ */
/* Verification tokens — HMAC signed, not stored                       */
/* ------------------------------------------------------------------ */

/**
 * A token says "this number answered an SMS, and it was this script that
 * checked". It is the number and an expiry, signed with a secret only this
 * script holds — so nothing has to be remembered to verify it later.
 *
 * An earlier build kept tokens in CacheService, which caps at six hours and
 * evicts under pressure. A lead stashed in the browser after a failed write is
 * retried on the next page load, and with a cached token that retry arrived
 * holding something the script no longer recognised — a real, verified lead
 * thrown away. A signed token survives both.
 */
function otpSecret() {
  var props  = PropertiesService.getScriptProperties();
  var secret = props.getProperty('OTP_TOKEN_SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('OTP_TOKEN_SECRET', secret);
  }
  return secret;
}

function otpSign(payload) {
  var raw = Utilities.computeHmacSha256Signature(payload, otpSecret());
  return raw.map(function (b) {
    return ('0' + (b & 0xff).toString(16)).slice(-2);
  }).join('');
}

function mintOtpToken(e164) {
  var payload = String(e164).replace(/\D/g, '') + '.' + (Date.now() + OTP_TOKEN_TTL_SECONDS * 1000);
  return payload + '.' + otpSign(payload);
}

/** The number a token was issued for, or '' if it is unsigned, forged or stale. */
function otpTokenPhone(token) {
  var parts = String(token || '').split('.');
  if (parts.length !== 3) return '';

  var payload = parts[0] + '.' + parts[1];
  var expiry  = Number(parts[1]);
  if (!expiry || expiry < Date.now()) return '';

  // Length is checked first so a short forgery cannot short-circuit the compare.
  var expected = otpSign(payload);
  if (expected.length !== parts[2].length) return '';

  var diff = 0;
  for (var i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ parts[2].charCodeAt(i);
  }
  if (diff !== 0) return '';

  return '+' + parts[0];
}

/**
 * Decides whether a lead may be written.
 *
 * Two deliberate holes, both of which would cost more than they close:
 *
 *   No Twilio configured — every lead goes through. A half-finished setup
 *   should not silently reject the day's leads; ?ping=1 and ?debug=1 are where
 *   an unconfigured endpoint is meant to show up.
 *
 *   No phone number on the lead — goes through. That is the renter referral,
 *   which ends before the phone step. A lead with no number to verify and no
 *   number to call is not worth blocking.
 */
function checkOtpGate(data) {
  var cfg = twilioConfig();
  if (!cfg.ok) return { ok: true };

  var phone = toE164(data && data.phone_number);
  if (!phone) return { ok: true };

  if (otpTokenPhone(data && data.otp_token) === phone) return { ok: true };

  return {
    ok: false,
    code: 'not_verified',
    error: 'This number has not been verified. Please request a new code.'
  };
}

/* ================================================================== */
/* Checks to run from the editor                                       */
/* ================================================================== */

/**
 * Everything that costs nothing, in one run: the credentials, the Verify
 * service, the sheet, the header mapping, the tokens, the number rewriting
 * and the CRM's configuration. Run this first after deploying.
 * It sends no message and writes no row.
 */
function testEverything() {
  testTwilioConfig();
  Logger.log('---');
  testHeaderMapping();
  Logger.log('---');
  testTokens();
  Logger.log('---');
  testPhoneNormalising();
  Logger.log('---');
  Logger.log('CRM: ' + JSON.stringify(crmStatus_()));
  Logger.log('Build: ' + SCRIPT_BUILD + '   Sheet: ' + SHEET_ID);
}

/**
 * Reads the three Script Properties and confirms Twilio accepts them.
 * A GET on the service proves the credentials and the SID together without
 * starting a billable verification.
 */
function testTwilioConfig() {
  var cfg = twilioConfig();
  if (!cfg.ok) {
    Logger.log('NOT CONFIGURED: ' + cfg.error);
    Logger.log('Until this is fixed, every lead is written WITHOUT verification ' +
               '(checkOtpGate lets them through) and the code step cannot send.');
    return;
  }

  Logger.log('Account SID: ' + cfg.sid.substring(0, 6) + '…   Verify service: ' + cfg.service.substring(0, 6) + '…');

  var res = UrlFetchApp.fetch(
    'https://verify.twilio.com/v2/Services/' + encodeURIComponent(cfg.service),
    {
      method: 'get',
      headers: { Authorization: 'Basic ' + Utilities.base64Encode(cfg.sid + ':' + cfg.token) },
      muteHttpExceptions: true
    }
  );

  if (res.getResponseCode() === 200) {
    var body = JSON.parse(res.getContentText());
    Logger.log('OK — Verify service "' + body.friendly_name + '" is reachable.');
    Logger.log('Codes are ' + body.code_length + ' digits. This script expects ' + OTP_CODE_LENGTH + '.');
    if (body.code_length !== OTP_CODE_LENGTH) {
      Logger.log('MISMATCH: set the service to ' + OTP_CODE_LENGTH + '-digit codes, ' +
                 'or change OTP_CODE_LENGTH here and maxlength on #verification-code in index.html.');
    }
  } else {
    Logger.log('FAILED (HTTP ' + res.getResponseCode() + '): ' +
               twilioMessage({ status: res.getResponseCode(), body: JSON.parse(res.getContentText() || '{}') }));
  }
}

/**
 * Checks the sheet's headers against this script WITHOUT writing a row.
 *
 * Rows are matched on header text, so a header this script does not recognise
 * fills with a blank and nothing says why. Run this after renaming, adding or
 * reordering a column: anything marked UNRECOGNISED needs either the header
 * put back or an entry in HEADER_ALIASES.
 */
function testHeaderMapping() {
  var sheet   = getSheet();
  var headers = ensureHeaders(sheet);
  var known   = buildRow({});          // an empty lead still lists every key
  var lines   = ['Sheet: ' + sheet.getName() + ' (' + headers.length + ' columns) in ' + SHEET_ID];
  var unknown = [];

  headers.forEach(function (h, i) {
    var key = columnKey(h);
    var ok  = known.hasOwnProperty(key);
    if (!ok) unknown.push(h);
    lines.push('  ' + (i + 1) + '. ' + String(h) + '  ->  ' + key +
               (ok ? '' : '   <-- UNRECOGNISED, will always be blank'));
  });

  // The reverse question: something this script can fill that has no column.
  var missing = Object.keys(known).filter(function (k) {
    if (k === 'solar') return false;            // legacy 9-column key
    if (k === 'phone verified') return false;   // ensureHeaders adds it on its own
    return headers.map(columnKey).indexOf(k) === -1;
  });

  lines.push(unknown.length
    ? 'Headers with nowhere to read from: ' + unknown.join(', ')
    : 'Every header maps to a value.');
  lines.push(missing.length
    ? 'Values with no column to write to: ' + missing.join(', ')
    : 'Every value has a column.');

  Logger.log(lines.join('\n'));
}

/** Confirms a token verifies for its own number and for nothing else. */
function testTokens() {
  var token = mintOtpToken('+61412345678');
  Logger.log('Token issued: ' + token.substring(0, 24) + '…');
  Logger.log('Resolves to:  ' + (otpTokenPhone(token) || 'REJECTED'));
  Logger.log('Tampered:     ' + (otpTokenPhone(token.slice(0, -1) + '0') || 'REJECTED (correct)'));
  Logger.log('Nonsense:     ' + (otpTokenPhone('not-a-token') || 'REJECTED (correct)'));
}

/** Confirms the number rewriting, which is what Twilio actually receives. */
function testPhoneNormalising() {
  [
    '0412 345 678', '0412345678', '61412345678', '0061412345678',
    '+61412345678', '+61 412 345 678', '02 9876 5432',
    '412345678', '041234567', 'not a number', ''
  ].forEach(function (raw) {
    Logger.log((raw || '(empty)') + '  ->  ' + (toE164(raw) || 'REJECTED'));
  });
}

/* ------------------------------------------------------------------ */
/* Lead writes — run once after deploying                              */
/* ------------------------------------------------------------------ */

/** A residential lead with existing solar. Every column should fill. */
function testInsert() {
  logLead({
    event_id: 'test-' + Date.now(),
    first_name: 'Test',
    last_name: 'Lead',
    phone_number: '+61412345678',
    otp_token: mintOtpToken('+61412345678'),
    otp_verified: 'Verified (SMS)',
    street_address: '12 Smith Street',
    suburb_city: 'Bondi',
    postcode: '2026',
    email_address: 'test@example.com',
    homeowner: 'Own',
    product_type: 'Solar & Battery',
    existing_solar: 'Yes',
    existing_solar_age: 'More Than 5 Years',
    roof_type: 'Tin',
    home_age: '10 - 20 Years',
    shading_issues: 'No Shading Issues',
    bill_size: '$600 - $900'
  });
}

/** The other residential path: no existing solar, so Solar Age stays blank. */
function testNoExistingSolar() {
  logLead({
    event_id: 'test-nosolar-' + Date.now(),
    first_name: 'Test',
    last_name: 'NoSolar',
    phone_number: '+61498765432',
    otp_token: mintOtpToken('+61498765432'),
    otp_verified: 'Verified (SMS)',
    street_address: '8 Jones Road',
    suburb_city: 'Manly',
    postcode: '2095',
    email_address: 'nosolar@example.com',
    homeowner: 'Own',
    product_type: 'Solar Only',
    existing_solar: 'No',
    roof_type: 'Tile',
    home_age: '0 - 10 Years',
    shading_issues: 'No Shading Issues',
    bill_size: '$300 - $600'
  });
}

/** The renter branch: no phone number of its own, two landlord columns. */
function testRenterReferral() {
  logLead({
    event_id: 'test-renter-' + Date.now(),
    lead_type: 'renter referral',
    homeowner: 'Rent',
    renter_referral: 'Yes',
    landlord_name: 'Jane Landlord',
    landlord_phone: '+61412345678'
  });
}

/**
 * Proves the gate: a lead with a number but no token must be refused.
 * Only meaningful once the TWILIO_* properties are set — without them the
 * gate deliberately lets everything through, and this logs that instead.
 */
function testGateRejectsUnverified() {
  var res = handleLead({
    event_id: 'test-gate-' + Date.now(),
    first_name: 'No', last_name: 'Token',
    phone_number: '+61412345678'
  });
  Logger.log(JSON.stringify(res));

  if (!twilioConfig().ok) {
    Logger.log('Twilio is not configured, so the gate is open by design. ' +
               'A row WAS written. Set the three properties and run this again.');
    return;
  }
  Logger.log(res.ok ? 'UNEXPECTED — the gate let an unverified lead through.'
                    : 'Correct — refused: ' + res.error);
}

function logLead(payload) {
  Logger.log(JSON.stringify(handleLead(JSON.parse(JSON.stringify(payload)))));
}

/* ------------------------------------------------------------------ */
/* Live SMS checks — these cost one verification each                  */
/* ------------------------------------------------------------------ */

/**
 * The handset the two checks below text. Full international form, with the
 * country code and no trunk zero — the same thing Twilio is handed.
 * Left blank on purpose: fill it with a phone you can actually read.
 */
var TEST_PHONE = '';        // e.g. '+61412345678'

/** The six digits that arrived. Filled in between testSendCode and testVerifyCode. */
var TEST_CODE = '000000';

/** Texts a real code to TEST_PHONE. Costs one verification. */
function testSendCode() {
  if (!TEST_PHONE) {
    Logger.log('Set TEST_PHONE to a handset you can read, in +61… form, then run this again.');
    return;
  }

  var res = handleSendCode({ phone_number: TEST_PHONE, request_id: 'manual-' + Date.now() });
  Logger.log(JSON.stringify(res, null, 2));

  if (res.ok) {
    Logger.log('SENT to ' + res.to + ' — put the code into TEST_CODE, then run testVerifyCode.');
    Logger.log('Nothing arrives? Twilio console → Monitor → Logs → Verify has the delivery status.');
    return;
  }

  Logger.log('FAILED: ' + res.error);
  Logger.log(testSendHint(res));
}

/** The console setting behind the failures worth naming. */
function testSendHint(res) {
  switch (res.twilio_code) {
    case 60605:
      return 'Fix: Twilio → Messaging → Settings → Geo Permissions. Tick the country this number is in, save, run again.';
    case 21608:
      return 'Fix: the account is on trial. Twilio → Phone Numbers → Verified Caller IDs → add ' + TEST_PHONE + ', or upgrade.';
    case 60200:
      return 'Twilio does not recognise ' + TEST_PHONE + ' as a real mobile. Check the country code and that there is no trunk zero after it.';
    case 60203:
    case 60212:
      return 'Twilio is throttling this number. Wait a few minutes and run again.';
  }
  if (res.code === 'not_configured') return 'Fix: fill the three TWILIO_* Script Properties, then run testTwilioConfig.';
  if (res.code === 'cooldown')       return 'This script\'s own ' + OTP_SEND_COOLDOWN_SECONDS + 's cooldown. Wait it out and run again.';
  if (res.code === 'rate_limited')   return 'This script\'s own limit of ' + OTP_MAX_SENDS_PER_HOUR + ' sends per hour. It clears within the hour.';
  if (res.code === 'bad_number')     return 'TEST_PHONE is not in E.164 form. It must start with + and the country code.';
  return '';
}

/** Second half of testSendCode — same number, the code held in TEST_CODE. */
function testVerifyCode() {
  var res = handleVerifyCode({
    phone_number: TEST_PHONE,
    code: TEST_CODE,
    request_id: 'manual-verify-' + Date.now()
  });
  Logger.log(JSON.stringify(res, null, 2));

  if (res.ok && res.verified) {
    Logger.log('VERIFIED. Send, check and token all work.');
    Logger.log('Token resolves to: ' + otpTokenPhone(res.otp_token));
  } else if (res.code === 'incorrect') {
    Logger.log('Wrong code. ' + OTP_MAX_CHECKS + ' guesses are allowed per code.');
  } else if (res.code === 'expired') {
    Logger.log('That code is used or older than ten minutes. Run testSendCode for a fresh one.');
  } else if (res.code === 'bad_code') {
    Logger.log('TEST_CODE is still the placeholder — put the six digits from the message in it.');
  } else {
    Logger.log('FAILED: ' + res.error);
  }
}

/**
 * The regression test for the bug this design exists to prevent: the same
 * request sent twice must answer the same way twice, and must not reach
 * Twilio twice.
 *
 * Run testSendCode, put the code in TEST_CODE, then run this instead of
 * testVerifyCode. Both lines must read verified, and the second must be
 * flagged idempotent.
 */
function testDoubleVerify() {
  var req = { phone_number: TEST_PHONE, code: TEST_CODE, request_id: 'dup-' + Date.now() };

  var first  = handleVerifyCode(req);
  var second = handleVerifyCode(req);

  Logger.log('1st: ' + JSON.stringify(first));
  Logger.log('2nd: ' + JSON.stringify(second));

  if (first.ok && second.ok && first.otp_token === second.otp_token) {
    Logger.log('PASS — the retry replayed the same token instead of asking Twilio again.');
  } else {
    Logger.log('FAIL — the retry did not match. This is the "expired" bug.');
  }
}

/* ================================================================== */
/* CRM forwarding                                                      */
/* ================================================================== */
/*
 * The CRM answers:
 *   202  accepted                        -> sent
 *   409  it already has this event_id    -> sent (a retry that had landed)
 *   400  it cannot use this lead, e.g. a non-Australian postcode
 *                                        -> rejected, never retried
 *   401  bad signature / wrong secret    -> retried: fix CRM_SECRET and it recovers
 *   408  clock skew                      -> retried
 *   anything else, or no answer          -> retried, up to CRM_MAX_ATTEMPTS
 *
 * The request is signed over the exact bytes sent:
 *   X-OT-Timestamp: <unix seconds>
 *   X-OT-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
 *
 * Since the OTP build, every forwarded payload also carries otp_verified —
 * "Verified (SMS)" or "Not verified — <reason>" — so the CRM can tell a
 * confirmed handset from one Twilio could not reach. The six digits and the
 * internal verification token are stripped and never leave this script.
 */

var CRM_OUTBOX_SHEET  = 'CRM outbox';
var CRM_MAX_ATTEMPTS  = 30;   // one a minute, backing off; ~a day of retrying
var CRM_BATCH         = 40;   // per trigger run; Apps Script runs are time-limited
var CRM_OUTBOX_HEADERS = [
  'Queued at', 'event_id', 'Lead', 'Status', 'CRM reference',
  'Attempts', 'Last tried', 'Last response', 'Payload'
];
// 1-based column numbers of the above.
var CRM_COL = {
  queuedAt: 1, eventId: 2, lead: 3, status: 4, reference: 5,
  attempts: 6, lastTried: 7, response: 8, payload: 9
};

function crmOutbox_() {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(CRM_OUTBOX_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CRM_OUTBOX_SHEET);
    sheet.getRange(1, 1, 1, CRM_OUTBOX_HEADERS.length).setValues([CRM_OUTBOX_HEADERS]);
    sheet.getRange(1, 1, 1, CRM_OUTBOX_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Queues the form payload for the CRM. Called inside handleLead's lock, after
 * the sheet row is written. Swallows its own errors: the sheet is the thing
 * the visitor is waiting on, and it has already succeeded.
 */
function crmEnqueue_(data) {
  try {
    crmMarkLive_();

    var who = [data.first_name, data.last_name].filter(Boolean).join(' ');

    // A renter referral carries no customer: the tenant is told we cannot
    // assess in their name and may leave a landlord's name and number. The
    // landlord never agreed to be contacted, so it is not sent as a lead —
    // Optimal Transnational decides by hand whether to follow one up.
    var status = data.lead_type === 'renter referral'
      ? 'not sent: renter referral'
      : 'pending';

    // The outbox is a spreadsheet tab that people read. A one-time code and a
    // verification token are credentials, however short-lived, and neither is
    // any use to the CRM — so neither is written down.
    var payload = {};
    Object.keys(data).forEach(function (k) {
      if (k === 'code' || k === 'otp_token' || k === 'action' || k === 'request_id') return;
      payload[k] = data[k];
    });

    crmOutbox_().appendRow([
      Utilities.formatDate(new Date(), TIMEZONE, DATE_FORMAT),
      String(data.event_id || ''),
      who || String(data.landlord_name || ''),
      status,
      '',
      0,
      '',
      '',
      JSON.stringify(payload)
    ]);
  } catch (err) {
    console.error('CRM enqueue failed: ' + err);
  }
}

/**
 * The moment live forwarding began: whichever came first, crmSetup() or the
 * first lead queued by this version. Rows dated before it were never queued
 * live, and crmBackfill uses it so it never re-sends one that was — under a
 * different id, which the CRM would read as the customer enquiring twice.
 */
function crmMarkLive_() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('CRM_LIVE_SINCE')) props.setProperty('CRM_LIVE_SINCE', String(Date.now()));
}

/** Trigger target, every minute. Sends whatever is due. */
function crmFlush() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;   // a lead or an OTP check holds it; next minute will do

  var due = [];
  var sheet;
  try {
    sheet = crmOutbox_();
    var last = sheet.getLastRow();
    if (last < 2) return;

    var rows = sheet.getRange(2, 1, last - 1, CRM_OUTBOX_HEADERS.length).getValues();
    var now = Date.now();
    for (var i = 0; i < rows.length && due.length < CRM_BATCH; i++) {
      var r = rows[i];
      var status = String(r[CRM_COL.status - 1]);
      var attempts = Number(r[CRM_COL.attempts - 1]) || 0;
      if (status !== 'pending' && status.indexOf('retrying') !== 0) continue;
      if (attempts >= CRM_MAX_ATTEMPTS) continue;

      // Back off: 1, 2, 4 ... minutes, capped at an hour.
      var lastTried = r[CRM_COL.lastTried - 1];
      var wait = Math.min(60, Math.pow(2, Math.max(attempts - 1, 0))) * 60 * 1000;
      if (attempts > 0 && lastTried instanceof Date && now - lastTried.getTime() < wait) continue;

      due.push({ row: i + 2, attempts: attempts, body: String(r[CRM_COL.payload - 1]) });
    }
  } finally {
    // Sending happens OUTSIDE the lock, so a slow CRM never holds up a visitor.
    lock.releaseLock();
  }

  due.forEach(function (item) {
    var result = crmSend_(item.body);
    var attempts = item.attempts + 1;
    var status = result.status;
    if (status === 'retrying' && attempts >= CRM_MAX_ATTEMPTS) status = 'failed: gave up';

    sheet.getRange(item.row, CRM_COL.status, 1, 5).setValues([[
      status === 'retrying' ? 'retrying (' + result.code + ')' : status,
      result.reference || '',
      attempts,
      new Date(),
      String(result.detail || '').slice(0, 500)
    ]]);
  });
}

/** Signs and POSTs one payload. Returns { status, code, reference, detail }. */
function crmSend_(body) {
  var props  = PropertiesService.getScriptProperties();
  var url    = props.getProperty('CRM_URL');
  var secret = props.getProperty('CRM_SECRET');
  if (!url || !secret) {
    return { status: 'retrying', code: 'not configured', detail: 'CRM_URL or CRM_SECRET script property is missing' };
  }

  var ts = String(Math.floor(Date.now() / 1000));
  // UTF-8 explicitly, so a name with an accent signs the same bytes the CRM checks.
  var sig = Utilities.computeHmacSha256Signature(ts + '.' + body, secret, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); })
    .join('');

  var res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      payload: body,
      headers: { 'X-OT-Timestamp': ts, 'X-OT-Signature': 'sha256=' + sig },
      muteHttpExceptions: true,
      followRedirects: false
    });
  } catch (err) {
    return { status: 'retrying', code: 'network', detail: String(err) };
  }

  var code = res.getResponseCode();
  var text = res.getContentText();
  var out = {};
  try { out = JSON.parse(text); } catch (e) { /* not JSON */ }

  if (code === 202 && out.ok === false) {
    return { status: 'retrying', code: code, detail: text };
  }
  if (code === 202 || code === 409) {
    return { status: 'sent', code: code, reference: out.reference || '', detail: text };
  }
  if (code === 400) {
    return { status: 'rejected: ' + (out.detail || out.error || 'invalid'), code: code, detail: text };
  }
  return { status: 'retrying', code: code, detail: text };
}

/** For ?ping=1. Says whether forwarding is configured and how far behind it is. */
function crmStatus_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var sheet = crmOutbox_();
    var last = sheet.getLastRow();
    var counts = { pending: 0, retrying: 0, sent: 0, rejected: 0, other: 0 };
    if (last >= 2) {
      sheet.getRange(2, CRM_COL.status, last - 1, 1).getValues().forEach(function (r) {
        var s = String(r[0]);
        if (s === 'pending') counts.pending++;
        else if (s.indexOf('retrying') === 0) counts.retrying++;
        else if (s === 'sent') counts.sent++;
        else if (s.indexOf('rejected') === 0) counts.rejected++;
        else counts.other++;
      });
    }
    return {
      configured: !!(props.getProperty('CRM_URL') && props.getProperty('CRM_SECRET')),
      trigger: ScriptApp.getProjectTriggers().some(function (t) {
        return t.getHandlerFunction() === 'crmFlush';
      }),
      outbox: counts
    };
  } catch (err) {
    return { error: String(err) };
  }
}

/**
 * Run ONCE from the editor after setting the two script properties. Creates
 * the outbox tab and the every-minute trigger (removing any duplicate), then
 * sends one clearly-labelled test lead and logs what the CRM said.
 */
function crmSetup() {
  crmOutbox_();
  crmMarkLive_();

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'crmFlush') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('crmFlush').timeBased().everyMinutes(1).create();

  var tag = Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  var result = crmSend_(JSON.stringify({
    event_id: 'setup-test-' + tag,
    submitted_at: new Date().toISOString(),
    lead_type: 'residential solar',
    first_name: 'CRM',
    last_name: 'Setup Test ' + tag,
    email_address: 'crm.setup.' + tag + '@example.com',
    phone_number: '+61400000000',
    street_address: '1 Test Street',
    suburb_city: 'Preston',
    postcode: '3072',
    homeowner: 'Own',
    product_type: 'Solar Only',
    bill_size: '$300 - $600',
    otp_verified: 'Not verified — setup test',
    utm_source: 'setup-test'
  }));
  Logger.log(JSON.stringify(crmStatus_()));
  Logger.log('Test send: ' + JSON.stringify(result));
}

/**
 * ONE-OFF: queue the leads already in the main sheet, from before forwarding
 * existed. Run it once, from the editor, only when Optimal Transnational asks.
 *
 * Those rows only kept what the sheet shows — "Name" and "Property address"
 * joined into one cell, no event_id, no UTMs — so the payload is rebuilt from
 * the columns: first word of the name is the first name, the last part of the
 * address is the postcode. The event_id is derived from the row's date, phone
 * and email, so running this twice queues nothing new that the CRM will not
 * recognise (it answers 409). Rows already in the outbox are skipped, and so
 * is every row dated after crmSetup() ran — those went out live already.
 */
function crmBackfill() {
  var sheet   = getSheet();
  var headers = ensureHeaders(sheet);
  var last    = sheet.getLastRow();
  if (last < 2) return;

  var idx = {};
  headers.forEach(function (h, i) { idx[columnKey(h)] = i; });
  var cell = function (row, key) {
    return idx.hasOwnProperty(key) ? row[idx[key]] : '';
  };

  var outbox = crmOutbox_();
  var known = {};
  if (outbox.getLastRow() >= 2) {
    outbox.getRange(2, CRM_COL.eventId, outbox.getLastRow() - 1, 1).getValues()
      .forEach(function (r) { known[String(r[0])] = true; });
  }

  var liveSince = Number(PropertiesService.getScriptProperties().getProperty('CRM_LIVE_SINCE'));
  if (!liveSince) {
    Logger.log('Run crmSetup() first: backfill needs to know when live forwarding started.');
    return;
  }

  var queued = 0, skipped = 0;
  sheet.getRange(2, 1, last - 1, headers.length).getValues().forEach(function (row) {
    var phone = String(cell(row, 'phone number') || '').replace(/^'/, '').replace(/\s+/g, '');
    var email = String(cell(row, 'email address') || '').trim();
    var ownership = String(cell(row, 'home ownership') || '');
    if (!phone || !email || ownership === 'Rent') { skipped++; return; }

    var when = cell(row, 'date');
    var date = when instanceof Date ? when : Utilities.parseDate(String(when), TIMEZONE, DATE_FORMAT);
    // The sheet's Date is to the minute; a minute's grace keeps a lead that
    // arrived while crmSetup was running on the live side, not both.
    if (!date || isNaN(date.getTime()) || date.getTime() >= liveSince - 60 * 1000) { skipped++; return; }

    var digest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      [date.toISOString(), phone, email.toLowerCase()].join('|'),
      Utilities.Charset.UTF_8
    ).map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
    var eventId = 'sheet-' + digest.slice(0, 32);
    if (known[eventId]) { skipped++; return; }

    var name = String(cell(row, 'name') || '').trim().split(/\s+/);
    var parts = String(cell(row, 'property address') || '').split(',').map(function (p) { return p.trim(); });
    var postcode = parts.length > 1 && /^\d{4}$/.test(parts[parts.length - 1]) ? parts.pop() : '';
    var suburb = parts.length > 1 ? parts.pop() : '';

    var data = {
      event_id: eventId,
      submitted_at: date.toISOString(),
      lead_type: 'residential solar',
      backfilled_from_sheet: 'Yes',
      first_name: name.shift() || '',
      last_name: name.join(' '),
      email_address: email,
      phone_number: phone,
      street_address: parts.join(', '),
      suburb_city: suburb,
      postcode: postcode,
      homeowner: ownership,
      product_type: String(cell(row, 'energy system') || ''),
      existing_solar: String(cell(row, 'existing solar') || ''),
      existing_solar_age: String(cell(row, 'solar age') || ''),
      roof_type: String(cell(row, 'roof type') || ''),
      home_age: String(cell(row, 'home age') || ''),
      shading_issues: String(cell(row, 'roof shade') || ''),
      bill_size: String(cell(row, 'bill range - quarterly') || ''),
      // Blank on any row written before the OTP build, which is most of them.
      otp_verified: String(cell(row, 'phone verified') || '')
    };
    crmEnqueue_(data);
    known[eventId] = true;
    queued++;
  });
  Logger.log('Backfill: queued ' + queued + ', skipped ' + skipped + '. crmFlush sends them over the next minutes.');
}
