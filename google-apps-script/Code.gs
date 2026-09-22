/**
 * Optimal Transnational — Lead form → Google Sheet + Twilio Verify OTP
 * ====================================================================
 *
 * WHAT CHANGED IN THIS BUILD (read before deploying)
 * ---------------------------------------------------
 * The bug: a correct code came back as "That code has expired."
 *
 * The browser sends each OTP call twice — once over fetch, and again over
 * JSONP whenever the browser refuses to read the fetch reply. Twilio Verify
 * DELETES a verification the moment it is approved, so the second call asked
 * about a verification that no longer existed, got HTTP 404, and a 404 is
 * indistinguishable from a ten-minute expiry. The visitor typed the right code
 * and was told it was stale.
 *
 * Three things now prevent that:
 *
 *   1. Idempotency. Every OTP call carries a request_id. The first answer for
 *      an id is cached and replayed verbatim, so a retry never reaches Twilio.
 *   2. A script lock around the Twilio check, so two genuinely concurrent
 *      copies of the same request serialise instead of racing.
 *   3. A 404 for a number that already holds a token is read as "already
 *      approved", not as "expired".
 *
 * Also: verification tokens are now HMAC-signed rather than held in the cache.
 * A cached token died after six hours (the CacheService ceiling) or whenever
 * the cache was evicted, and a stashed lead retried after that was thrown away
 * as unverified. A signed token needs no storage and survives both.
 *
 * SHEET
 * -----
 * Writes one row per lead into this 15-column layout:
 *
 *   Date | Name | Phone number | Property address | Email address |
 *   Home Ownership | Energy System | Existing Solar | Solar Age |
 *   Roof Type | Home Age | Roof Shade | Bill range - quarterly |
 *   Landload Name | Landload Phone
 *
 * Rows are written against the sheet's own header row, not against this list,
 * so columns can be reordered in the sheet without touching this file.
 *
 * DEPLOY
 * ------
 * Extensions → Apps Script → replace Code.gs with this file →
 * ⚙ Project Settings → Script Properties → the three TWILIO_* values →
 * run testEverything() once to grant permissions and check the credentials →
 * Deploy → Manage deployments → ✏️ → Version: **New version** → Deploy.
 *
 * Editing this file does NOT change what the /exec URL runs. Only a new
 * deployment version does. Confirm with <url>?ping=1 — the "build" it reports
 * must equal SCRIPT_BUILD below, and "otp" must say "configured".
 */

/** Bump with every edit. ?ping=1 reports it; js/diagnostics.js compares it. */
var SCRIPT_BUILD = 'otp-fast-redirect-2026-09-18';

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/** The spreadsheet leads are written to — the ID between /d/ and /edit. */
var SHEET_ID    = '1WUbokw-GVK5hnt1ZLi3HQ1lhObN43aMCEHCpP1fnO0c';
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
 *          "No — <reason>" so it can be filtered or called with care.
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
 * Confirms the deployment is public, points at the right spreadsheet, and can
 * send a code — without writing a row. js/diagnostics.js reads this.
 */
function handlePing() {
  var twilio = twilioConfig();
  var out = {
    ok: true,
    pong: true,
    build: SCRIPT_BUILD,
    sheet_id: SHEET_ID,
    otp: twilio.ok ? 'configured' : 'not_configured',
    otp_error: twilio.ok ? null : twilio.error
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

function handleLead(data, opts) {
  if (!data || Object.keys(data).length === 0) {
    return { ok: false, error: 'Empty payload' };
  }

  // A lead carrying a phone number has to carry the token proving the number
  // answered an SMS. Checked before the lock — a rejection touches no sheet.
  // handleVerifyAndSubmit has just done the check itself and passes skipGate;
  // nothing reachable from the web can set it, as handleRequest passes one arg.
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

    // Every row says one of: "Verified (SMS)", "Not verified — reason", or
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
 * zero from a local number and read a leading "+" as the start of a formula.
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
    .replace(/[\u2018\u2019']/g, '')   // Landlord's Name -> landlords name
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
  // Deliberately no 'solar' entry: a sheet on the old 9-column layout has one
  // "solar" column and no Solar Age beside it, so it keeps the combined value.

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
 * file (~1s), and a verify-and-submit used to make it three times: the lead,
 * the OTP log, and the row upgrade. Once is enough.
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
  // column for it, one is added at the end — the 15 existing columns are
  // untouched, and nothing else in this file depends on the count.
  var hasVerified = headers.some(function (h) { return columnKey(h) === 'phone verified'; });
  if (!hasVerified) {
    var col = headers.length + 1;
    sheet.getRange(1, col).setValue('Phone verified').setFontWeight('bold');
    headers.push('Phone verified');
  }
  return headers;
}

/**
 * The browser may send the same lead twice (fetch plus the JSONP backup).
 * Held in the cache rather than in Script Properties: duplicates arrive within
 * seconds, and the properties store is where the Twilio credentials live —
 * thousands of evt_ rows made it unreadable.
 */
function isDuplicate(data) {
  if (!data || !data.event_id) return false;
  return CacheService.getScriptCache().get('evt_' + safeKey(data.event_id)) !== null;
}

function rememberEventId(eventId, row) {
  if (!eventId) return;
  CacheService.getScriptCache().put('evt_' + safeKey(eventId), String(row || 1), 21600);
}

/** Row number an event_id was written to, or 0 if not known. */
function rowForEventId(eventId) {
  if (!eventId) return 0;
  var v = CacheService.getScriptCache().get('evt_' + safeKey(eventId));
  return Number(v) > 1 ? Number(v) : 0;
}

/** Sets the "Phone verified" cell of an already-written row. */
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
  var safe = String(callback).replace(/[^A-Za-z0-9_$]/g, '') || 'callback';
  return ContentService
    .createTextOutput(safe + '(' + JSON.stringify(obj) + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

/** Cache keys may not contain spaces or punctuation that upsets the store. */
function safeKey(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '').substring(0, 200);
}

/* ------------------------------------------------------------------ */
/* Twilio Verify — credentials                                         */
/* ------------------------------------------------------------------ */

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
  var code = res.body && res.body.code;
  if (code && TWILIO_MESSAGES[code]) return TWILIO_MESSAGES[code];

  if (res.status === 401 || res.status === 403) {
    return 'Twilio rejected the credentials — check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.';
  }
  if (code === 20404) {
    return 'Twilio has no Verify service with that SID — check TWILIO_VERIFY_SERVICE_SID.';
  }

  return (res.body && res.body.message)
    ? 'Twilio: ' + res.body.message
    : 'Twilio returned HTTP ' + res.status + '.';
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

/** +61412345678 -> +61 4•• ••• 678, for reading back on screen. */
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
 * The code is checked, and if the number is confirmed the row is written in
 * the same execution — the browser never has to make a second call carrying a
 * token, so there is no gap in which a verified lead can be lost.
 *
 * Outcomes, in order:
 *   verified     -> row written, "Phone verified" = Yes (SMS)
 *   wrong code   -> refused, visitor asked to re-check the message
 *   Twilio-side failure and OTP_FAIL_OPEN -> row written, marked "No — reason"
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
 * The previous build kept tokens in CacheService, which caps at six hours and
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

/* ------------------------------------------------------------------ */
/* Checks to run from the editor                                       */
/* ------------------------------------------------------------------ */

/**
 * Everything that costs nothing, in one run: the credentials, the Verify
 * service, the sheet, the header mapping, the tokens and the number
 * rewriting. Run this first. It sends no message and writes no row.
 */
function testEverything() {
  testTwilioConfig();
  Logger.log('---');
  testHeaderMapping();
  Logger.log('---');
  testTokens();
  Logger.log('---');
  testPhoneNormalising();
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

  var missing = Object.keys(known).filter(function (k) {
    if (k === 'solar' || k === 'phone verified') return false;   // optional columns
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
    '+61412345678', '+61 412 345 678', '+91 85956 84896', '+918595684896',
    '02 9876 5432', '412345678', '041234567', 'not a number', ''
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

/** Proves the gate: a lead with a number but no token must be refused. */
function testGateRejectsUnverified() {
  var res = handleLead({
    event_id: 'test-gate-' + Date.now(),
    first_name: 'No', last_name: 'Token',
    phone_number: '+61412345678'
  });
  Logger.log(JSON.stringify(res));
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
 */
var TEST_PHONE = '+918595684896';

/** The six digits that arrived. Filled in between testSendCode and testVerifyCode. */
var TEST_CODE = '000000';

/** Texts a real code to TEST_PHONE. Costs one verification. */
function testSendCode() {
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
 * The regression test for the bug this build fixes: the same request sent
 * twice must answer the same way twice, and must not reach Twilio twice.
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
