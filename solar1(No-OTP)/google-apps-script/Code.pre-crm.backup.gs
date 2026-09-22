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
 */

/**
 * Reported by the ?ping=1 health check and shown in the ?debug=1 panel.
 *
 * Editing this file is not enough to change what the /exec URL runs — that
 * needs Deploy -> Manage deployments -> edit -> New version. Without this
 * stamp there is no way to tell the two apart from outside, and a sheet
 * quietly filling half its columns is the result. Bump it with every change.
 */
var SCRIPT_BUILD = 'au-e164-sheet-2026-09-17';

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
        })
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
    .replace(/[\u2018\u2019']/g, '')   // Landlord's Name -> landlords name
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
 */
function isDuplicate(data) {
  if (!data.event_id) return false;
  var props = PropertiesService.getScriptProperties();
  return props.getProperty('evt_' + data.event_id) !== null;
}

function rememberEventId(eventId) {
  if (!eventId) return;
  var props = PropertiesService.getScriptProperties();
  props.setProperty('evt_' + eventId, String(Date.now()));

  // Keep the store small — drop IDs older than 7 days.
  var all = props.getProperties();
  var cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('evt_') === 0 && Number(all[k]) < cutoff) {
      props.deleteProperty(k);
    }
  });
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
