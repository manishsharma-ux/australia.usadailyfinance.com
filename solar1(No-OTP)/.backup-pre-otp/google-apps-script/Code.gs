/**
 * Optimal Transnational — Lead form → Google Sheet
 * ----------------------------------------
 * Writes one row per lead into this fixed 15-column layout:
 *
 *   Date | Name | Phone number | Property address | Email address |
 *   Home Ownership | Energy System | Existing Solar | Solar Age |
 *   Roof Type | Home Age | Roof Shade | Bill range - quarterly |
 *   Landload Name | Landload Phone
 *
 * Rows are written against the sheet's own header row, not against this list,
 * so the columns can be reordered in the sheet without touching this file.
 * Columns the lead's path never asked about are left blank: the renter branch
 * ends the funnel early and fills only the two landlord columns, and the
 * solar-age column only fills for someone who already has panels.
 *
 * Setup: Extensions → Apps Script → paste this file → run testInsert once to
 * grant permissions → Deploy → New deployment → Web app
 * (Execute as: Me, Who has access: Anyone) → copy the /exec URL into
 * GOOGLE_SHEET_WEBAPP_URL in index.html.
 *
 * After changing the headers in the sheet, nothing here needs redeploying —
 * but a NEW deployment version is needed after editing this file at all.
 *
 * ---------------------------------------------------------------------------
 * CRM FORWARDING (added 2026-09-19) — see the section at the bottom.
 * ---------------------------------------------------------------------------
 * Every new lead is ALSO sent to the Optimal Transnational CRM. The sheet row
 * is written exactly as before; nothing above this line changed its behaviour.
 *
 *   1. doPost writes the sheet row, then drops the ORIGINAL form payload into a
 *      second tab, "CRM outbox". That is a local write, so the visitor's
 *      thank-you page is no slower and a CRM outage can never lose a lead.
 *   2. crmFlush runs every minute on a trigger, signs each queued payload and
 *      POSTs it to the CRM, and records the answer on the outbox row.
 *
 * Why a second tab: the main sheet has no room for event_id, UTMs or the
 * split name/address — it stores "Name" and "Property address" joined up —
 * and its columns are meant to stay exactly as specified. The CRM needs the
 * payload as the form sent it, so that is what the outbox keeps.
 *
 * One-time setup (Project Settings -> Script properties):
 *   CRM_URL     https://<crm domain>/api/webhooks/lead/agency
 *   CRM_SECRET  the signing secret Optimal Transnational gave you
 * then run crmSetup() once from the editor, then Deploy -> Manage deployments
 * -> edit -> New version, and check ?ping=1 reports the build below.
 *
 * Never paste CRM_SECRET into this file. It lives in Script Properties for the
 * same reason the Twilio token did: this file gets copied, pasted and shared,
 * and a signing secret in it is a signing secret published.
 */

/**
 * Reported by the ?ping=1 health check and shown in the ?debug=1 panel.
 *
 * Editing this file is not enough to change what the /exec URL runs — that
 * needs Deploy -> Manage deployments -> edit -> New version. Without this
 * stamp there is no way to tell the two apart from outside, and a sheet
 * quietly filling half its columns is the result. Bump it with every change.
 */
var SCRIPT_BUILD = 'au-e164-sheet-crm-2026-09-19';

var SHEET_ID   = '1jSAombFpIwvjqH0JWJmidKC5U50nDYxVaiDQgEzWkbo';
var SHEET_NAME = 'Sheet1';          // falls back to the first tab if this name is absent
var TIMEZONE   = 'Australia/Sydney'; // timezone the Date column is written in
var DATE_FORMAT = 'dd/MM/yyyy HH:mm';

/** Exact header text, in order. Changing a label here renames the column on a fresh sheet. */
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

function doPost(e) {
  return jsonOut(handleLead(parseBody(e)));
}

/**
 * Shared by doPost and doGet. Returns a plain object; the caller wraps it
 * as JSON or JSONP.
 */
function handleLead(data) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return { ok: false, error: 'Could not acquire lock' };
  }

  try {
    if (!data || Object.keys(data).length === 0) {
      return { ok: false, error: 'Empty payload' };
    }

    var sheet   = getSheet();
    var headers = ensureHeaders(sheet);

    // Health check from js/diagnostics.js — confirms the deployment is public
    // and the sheet layout is right, without writing a row.
    if (data.ping) {
      return {
        ok: true,
        pong: true,
        build: SCRIPT_BUILD,
        sheet: sheet.getName(),
        rows: Math.max(sheet.getLastRow() - 1, 0),
        headers: headers,

        // Which headers this deployment can actually fill. A column listed as
        // unmapped will stay blank no matter what the form sends.
        unmapped: headers.filter(function (h) {
          return !buildRow({}).hasOwnProperty(columnKey(h));
        }),

        // Never the secret itself — only whether one is set.
        crm: crmStatus_()
      };
    }

    if (isDuplicate(data)) {
      return { ok: true, duplicate: true };
    }

    var values = buildRow(data);
    var row    = headers.map(function (h) {
      var key = columnKey(h);
      return values.hasOwnProperty(key) ? values[key] : '';
    });

    sheet.appendRow(row);
    rememberEventId(data.event_id);

    // After the sheet row, never instead of it. crmEnqueue_ cannot throw.
    crmEnqueue_(data);

    return { ok: true, row: sheet.getLastRow() };

  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * GET entry point. Serves three purposes:
 *   /exec                          -> health check in a browser
 *   /exec?payload=...&callback=fn  -> JSONP write, readable across origins
 *   /exec?ping=1&callback=fn       -> JSONP health check, writes nothing
 *
 * JSONP exists because a <script> tag is not subject to CORS, and unlike a
 * beacon or a hidden form it returns a result the page can actually read.
 */
function doGet(e) {
  var params = (e && e.parameter) || {};
  var out;

  if (params.payload) {
    try {
      out = handleLead(JSON.parse(params.payload));
    } catch (err) {
      out = { ok: false, error: 'Could not parse payload: ' + String(err) };
    }
  } else if (params.ping) {
    out = handleLead({ ping: true });
  } else {
    out = {
      ok: true,
      status: 'Optimal Transnational sheet endpoint is live',
      build: SCRIPT_BUILD
    };
  }

  return params.callback ? jsonpOut(params.callback, out) : jsonOut(out);
}

function jsonpOut(callback, obj) {
  // Only allow a plain identifier as the callback name.
  var safe = String(callback).replace(/[^A-Za-z0-9_$]/g, '');
  return ContentService
    .createTextOutput(safe + '(' + JSON.stringify(obj) + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

/* ------------------------------------------------------------------ */
/* Row building                                                        */
/* ------------------------------------------------------------------ */

/** Maps the form payload onto the columns. Keys are normalised headers. */
function buildRow(d) {
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

  // The residential funnel asks "Own or rent"; the commercial one asks
  // "Own or lease" on a different step. One column, either answer.
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

    // Renter branch only, and both fields are optional on that step.
    'landlord name': String(d.landlord_name || '').trim(),
    'landlord phone': formatPhone(d.landlord_phone),

    // Fills the single "solar" column on a sheet still using the old 9-column
    // layout. Harmless on the current one, which has no such header.
    'solar': existingSolar && solarAge
      ? existingSolar + ' (' + solarAge + ')'
      : existingSolar
  };
}

/**
 * Keeps the number intact as text. Sheets would otherwise strip the leading
 * zero from an AU local number, and read a leading "+" as the start of a
 * formula — the form now submits E.164, +61412345678.
 */
function formatPhone(phone) {
  var p = String(phone || '').replace(/\s+/g, '');
  return p ? "'" + p : '';
}

function normalise(header) {
  return String(header)
    .replace(/[‘’']/g, '')   // Landlord's Name -> landlords name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Header wordings that mean the same column. The sheet's labels are written
 * for whoever reads the sheet, and get reworded; the keys in buildRow are not.
 * Anything not listed here falls through as itself, so a header that already
 * matches a buildRow key needs no entry.
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

  'bill range': 'bill range - quarterly',
  'bill range quarterly': 'bill range - quarterly',
  'bill size': 'bill range - quarterly',
  'quarterly bill': 'bill range - quarterly',
  'quarterly bill range': 'bill range - quarterly'
};

/**
 * Maps a sheet header onto the buildRow key that fills it.
 *
 * The landlord columns get their own rule rather than an alias entry: the live
 * sheet spells them "Landload", and the natural rewordings ("Landlord's phone",
 * "Landlord Mobile Number") are all things someone will reasonably type.
 * Matching on shape rather than on one exact string means renaming a column
 * does not silently start writing blanks.
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

function getSheet() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  return ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
}

/**
 * Returns the sheet's header row. Writes HEADERS if the sheet is empty;
 * otherwise leaves whatever is already there alone so your own labels win.
 */
function ensureHeaders(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return HEADERS;
  }
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

/**
 * The browser may send the same lead twice (fetch plus the sendBeacon backup).
 * Event IDs are held in script properties rather than a sheet column, so the
 * columns stay exactly as specified.
 *
 * All of them live in ONE property, as a { event_id: timestamp } map. They used
 * to get a property each, which is a problem the dedupe itself never shows:
 * the Script Properties screen turns read-only past 50 properties, so a busy
 * week silently takes away the only way to add or edit CRM_URL by hand. Run
 * pruneEventIdProperties() once to fold any leftover evt_ keys in here.
 */
var EVENT_ID_PROP   = 'recent_event_ids';
var EVENT_ID_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A single property value is capped at 9 KB. An id plus its timestamp is about
// 60 bytes, so this leaves room to spare; whichever limit bites first wins.
var EVENT_ID_MAX    = 120;

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
  if (!data.event_id) return false;
  return readEventIds_().hasOwnProperty(String(data.event_id));
}

function rememberEventId(eventId) {
  if (!eventId) return;

  var seen = readEventIds_();
  seen[String(eventId)] = Date.now();
  PropertiesService.getScriptProperties()
    .setProperty(EVENT_ID_PROP, JSON.stringify(trimEventIds_(seen)));
}

/** Drops anything past the TTL, then anything past the count cap, newest first. */
function trimEventIds_(seen) {
  var cutoff = Date.now() - EVENT_ID_TTL_MS;
  Object.keys(seen).forEach(function (k) {
    if (!(Number(seen[k]) >= cutoff)) delete seen[k];
  });

  var keys = Object.keys(seen);
  if (keys.length > EVENT_ID_MAX) {
    keys.sort(function (a, b) { return Number(seen[b]) - Number(seen[a]); })
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
 * CRM_URL or CRM_SECRET. Afterwards, reload Project Settings and the fields
 * are editable again. Safe to run more than once.
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
      seen[k.slice(4)] = when;   // 'evt_' is 4 characters
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
      ? 'Under 50 \u2014 reload Project Settings and the fields are editable again.'
      : 'STILL ' + left.length + ' \u2014 something other than evt_ keys is filling it.')
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

/* ------------------------------------------------------------------ */
/* Run once from the editor to grant permissions and sanity-check       */
/* ------------------------------------------------------------------ */

function testInsert() {
  var res = handleLead(JSON.parse(JSON.stringify({
        event_id: 'test-' + Date.now(),
        first_name: 'Test',
        last_name: 'Lead',
        phone_number: '+61412345678',
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
  })));
  Logger.log(JSON.stringify(res));
}

/**
 * The other residential path: no existing solar. It skips the solar-age
 * question and nothing else, so every column but Solar Age should fill.
 */
function testNoExistingSolar() {
  var res = handleLead(JSON.parse(JSON.stringify({
        event_id: 'test-nosolar-' + Date.now(),
        first_name: 'Test',
        last_name: 'NoSolar',
        phone_number: '+61498765432',
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
  })));
  Logger.log(JSON.stringify(res));
}

/**
 * Checks the sheet's headers against this script WITHOUT writing a row.
 *
 * Rows are matched on header text, so a header this script does not recognise
 * fills with a blank and nothing says why. Run this after renaming, adding or
 * reordering a column and read the log: anything marked UNRECOGNISED needs
 * either the header put back or an entry in HEADER_ALIASES.
 */
function testHeaderMapping() {
  var sheet   = getSheet();
  var headers = ensureHeaders(sheet);
  var known   = buildRow({});          // an empty lead still lists every key
  var lines   = ['Sheet: ' + sheet.getName() + ' (' + headers.length + ' columns)'];
  var unknown = [];

  headers.forEach(function (h, i) {
    var key = columnKey(h);
    var ok  = known.hasOwnProperty(key);
    if (!ok) unknown.push(h);
    lines.push(
      '  ' + (i + 1) + '. ' + String(h) +
      '  ->  ' + key +
      (ok ? '' : '   <-- UNRECOGNISED, will always be blank')
    );
  });

  // The reverse question: something this script can fill that has no column.
  var missing = Object.keys(known).filter(function (k) {
    if (k === 'solar') return false;   // legacy 9-column key, not expected here
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

/** Run once after deploying to confirm the two landlord columns fill. */
function testRenterReferral() {
  var res = handleLead(JSON.parse(JSON.stringify({
        event_id: 'test-renter-' + Date.now(),
        lead_type: 'renter referral',
        homeowner: 'Rent',
        renter_referral: 'Yes',
        landlord_name: 'Jane Landlord',
        landlord_phone: '+61412345678'
  })));
  Logger.log(JSON.stringify(res));
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
  var ss = SpreadsheetApp.openById(SHEET_ID);
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

    crmOutbox_().appendRow([
      Utilities.formatDate(new Date(), TIMEZONE, DATE_FORMAT),
      String(data.event_id || ''),
      who || String(data.landlord_name || ''),
      status,
      '',
      0,
      '',
      '',
      JSON.stringify(data)
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
  if (!lock.tryLock(10000)) return;   // doPost holds it; next minute will do

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
      bill_size: String(cell(row, 'bill range - quarterly') || '')
    };
    crmEnqueue_(data);
    known[eventId] = true;
    queued++;
  });
  Logger.log('Backfill: queued ' + queued + ', skipped ' + skipped + '. crmFlush sends them over the next minutes.');
}