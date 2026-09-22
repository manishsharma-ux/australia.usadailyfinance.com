/**
 * Google Places address autocomplete for the Street field.
 *
 * Two code paths, picked at runtime:
 *   1. Places API (New) - google.maps.places.AutocompleteSuggestion, with our own
 *      dropdown rendered under #Street-field. This is the path a key created after
 *      March 2025 can use, because Google no longer lets new projects enable the
 *      legacy "Places API" SKU at all.
 *   2. Legacy google.maps.places.Autocomplete widget, used only if the new classes
 *      are missing from the loaded API version.
 * If both fail the field stays a plain text input and a note tells the user to type
 * the address, so a dead key can never freeze the step.
 *
 * Config (declared in the config <script> block in index.html, all optional):
 *   MAPS_API_KEY   - Google Maps JS API key
 *   MAPS_COUNTRIES - ISO country codes to restrict results to, e.g. ['au'].
 *                    Set to [] for worldwide results (useful when testing outside AU).
 */

// Bump this in js/custom.js, js/maps-autocomplete.js and js/diagnostics.js
// TOGETHER. diagnostics.js compares all three, so a stamp left behind is
// reported as a half-uploaded js/ folder. `python3 bust-cache.py` checks it.
var SR_MAPS_BUILD = 'otp-fast-redirect-2026-09-18';

let autocomplete = null;
let mapsLoaded = false;
let mapsFailed = false;

function mapsCfg(name, fallback) {
    var v = window[name];
    return (typeof v === 'undefined' || v === null || v === '') ? fallback : v;
}

/* ==========================================================================
   Address component extraction.
   Both paths hand these a legacy-shaped place ({address_components:[{types,
   long_name}]}), so the new API's camelCase objects get normalised first.
   ========================================================================== */

/**
 * The JS SDK hands us displayName as a plain string, the REST API as a
 * LocalizedText {text}. Accept either, so neither stringifies to [object Object].
 */
function textOf(v) {
    if (!v) return '';
    return (typeof v === 'string') ? v : (v.text || '');
}

function findComponent(place, type) {
    var comps = place.address_components || [];
    for (var i = 0; i < comps.length; i++) {
        if (comps[i].types.indexOf(type) !== -1) return comps[i].long_name;
    }
    return '';
}

function getPostalCode(place) {
    return findComponent(place, 'postal_code');
}

function getCity(place) {
    // In AU the suburb is the locality. The others cover addresses where Places
    // omits it — rural lots, some unit complexes — in decreasing specificity.
    var order = ['locality', 'postal_town', 'sublocality_level_1', 'sublocality',
                 'administrative_area_level_2'];
    for (var i = 0; i < order.length; i++) {
        var v = findComponent(place, order[i]);
        if (v) return v;
    }
    return '';
}

function getStreet(place) {
    var route = findComponent(place, 'route');
    var street_number = findComponent(place, 'street_number');
    var subpremise = findComponent(place, 'subpremise');

    if (street_number != '') {
        var full_street = (street_number + ' ' + route).trim();
        // "4/12 Smith Street" — keep the unit number the user picked.
        if (subpremise != '') full_street = subpremise + '/' + full_street;
        return full_street;
    }

    // No street number: a named building, a rural lot, an establishment. The
    // route on its own would be a street with no number, which is both wrong and
    // rejected by the strict check, so use the label the user actually picked.
    var label = String(textOf(place.name) || place.formatted_address || '').split(',')[0].trim();
    return label || route;
}

function validateStress(str) {
    const words = str.trim().split(/\s+/);

    if (words.length < 3) {
        return false;
    }

    const prefixes = /^(unit|u|apt|apartment|flat|f|lot|l|shop|s|suite)\s*/i;

    let firstPart = words[0].toLowerCase();
    if (prefixes.test(firstPart)) {
        if (words.length < 4) return false;
        firstPart = words[1];
        words.splice(0, 2, firstPart);
    }

    const buildingNumberRegex = /^\d+[A-Za-z]{0,2}(-\d+|\/\d+[A-Za-z]?)?$/;

    if (!buildingNumberRegex.test(firstPart)) {
        return false;
    }

    const hasStreetName = words.slice(1).some(word => isNaN(word));
    if (!hasStreetName) {
        return false;
    }

    return true;
}

/**
 * Fill Street / Suburb / Postcode from a chosen place and re-run the step's
 * validation, since setting .val() from script fires no keyup for custom.js.
 */
function applyPlace(place) {
    console.log('[Maps] Selected place:', place);

    if (!place || !place.address_components || !place.address_components.length) return;

    var post_code = getPostalCode(place);
    $('#Postcode input').val(post_code);
    var city = getCity(place);
    $('#City input').val(city);
    var street = getStreet(place);
    $('#Street-field').val(street);

    setTimeout(function () {
        var addressOk = (typeof srAddressOk === 'function')
            ? srAddressOk($('#Street input').val().trim())
            : validateStress($('#Street input').val().trim());

        if ($('#Street').hasClass('active') && addressOk === false) {
            $('#next-question').attr('disabled', 'disabled');
            if ($('#Street input').val().trim() != '') {
                $('#Street').find('.error-holder')
                    .html('<i class="fa fa-warning"></i> Please enter your full street address.')
                    .css('display', 'inline-block');
            }
        } else if (post_code != '' && city != '' && street != '') {
            $('.question.active .error-holder').hide().html('');
            $('#next-question').removeAttr('disabled');
        }
    }, 200);
}

/* ==========================================================================
   Path 1 — Places API (New)
   ========================================================================== */

var acNew = {
    input: null,
    list: null,
    suggestions: [],
    active: -1,
    token: null,
    seq: 0,
    failures: 0,
    noTypeFilter: false,
    swallowEnterKeyup: false
};

function acIsOpen() {
    return !!(acNew.list && acNew.list.style.display === 'block');
}

function acNewSessionToken() {
    acNew.token = new google.maps.places.AutocompleteSessionToken();
}

function acBuildList() {
    var list = document.createElement('div');
    list.className = 'sr-ac';
    list.setAttribute('role', 'listbox');
    list.style.display = 'none';
    document.body.appendChild(list);
    acNew.list = list;

    // mousedown would blur the input before click lands, closing the list first.
    list.addEventListener('mousedown', function (e) { e.preventDefault(); });
    list.addEventListener('click', function (e) {
        var item = e.target.closest('.sr-ac-item');
        if (!item) return;
        acSelect(parseInt(item.dataset.index, 10));
    });
}

function acPosition() {
    if (!acIsOpen()) return;
    var r = acNew.input.getBoundingClientRect();
    acNew.list.style.left = r.left + 'px';
    acNew.list.style.top = (r.bottom + 6) + 'px';
    acNew.list.style.width = r.width + 'px';
}

function acClose() {
    if (!acNew.list) return;
    acNew.list.style.display = 'none';
    acNew.input.setAttribute('aria-expanded', 'false');
    acNew.active = -1;
    acNew.suggestions = [];
}

function acHighlight(i) {
    var items = acNew.list.querySelectorAll('.sr-ac-item');
    for (var n = 0; n < items.length; n++) {
        items[n].classList.toggle('is-active', n === i);
    }
    acNew.active = i;
    if (i >= 0 && items[i]) items[i].scrollIntoView({ block: 'nearest' });
}

function acEscape(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function acRender(suggestions) {
    acNew.suggestions = suggestions;

    if (!suggestions.length) { acClose(); return; }

    var html = '';
    for (var i = 0; i < suggestions.length; i++) {
        var p = suggestions[i].placePrediction;
        var main = p.mainText ? p.mainText.text : p.text.text;
        var secondary = p.secondaryText ? p.secondaryText.text : '';
        html += '<div class="sr-ac-item" role="option" data-index="' + i + '">'
              + '<span class="sr-ac-main">' + acEscape(main) + '</span>'
              + (secondary ? '<span class="sr-ac-secondary">' + acEscape(secondary) + '</span>' : '')
              + '</div>';
    }
    acNew.list.innerHTML = html;
    acNew.list.style.display = 'block';
    acNew.input.setAttribute('aria-expanded', 'true');
    acNew.active = -1;
    acPosition();
}

function acFetch(value) {
    var myseq = ++acNew.seq;

    if (!acNew.token) acNewSessionToken();

    var countries = mapsCfg('MAPS_COUNTRIES', ['au']);
    var request = { input: value, sessionToken: acNew.token };
    if (countries && countries.length) request.includedRegionCodes = countries;
    // Street-level results only; 'route' is left out so we never suggest a street
    // with no number, which srAddressOk would then reject.
    if (!acNew.noTypeFilter) {
        request.includedPrimaryTypes = ['street_address', 'subpremise', 'premise'];
    }

    google.maps.places.AutocompleteSuggestion
        .fetchAutocompleteSuggestions(request)
        .then(function (res) {
            if (myseq !== acNew.seq) return;   // a newer keystroke already won
            acNew.failures = 0;
            acRender((res.suggestions || []).filter(function (s) { return s.placePrediction; }));
        })
        .catch(function (err) {
            if (myseq !== acNew.seq) return;
            var msg = String((err && err.message) || err);

            // Some regions reject the type filter. Drop it once and retry.
            if (!acNew.noTypeFilter && /includedPrimaryTypes|INVALID_REQUEST/i.test(msg)) {
                console.warn('[Maps] Retrying without the address type filter:', msg);
                acNew.noTypeFilter = true;
                acFetch(value);
                return;
            }

            console.error('[Maps] fetchAutocompleteSuggestions failed:', msg);
            acClose();
            if (++acNew.failures >= 2) {
                mapsAutocompleteUnavailable('places-new-request-failed');
            }
        });
}

function acSelect(index) {
    var suggestion = acNew.suggestions[index];
    if (!suggestion) return;

    var prediction = suggestion.placePrediction;
    acClose();
    // The street line, not the full "street, suburb, state, country" label —
    // applyPlace overwrites this, but it is what remains if fetchFields fails.
    acNew.input.value = prediction.mainText ? prediction.mainText.text : prediction.text.text;

    var place = prediction.toPlace();
    place.fetchFields({ fields: ['addressComponents', 'formattedAddress', 'displayName'] })
        .then(function (res) {
            var p = res.place || place;
            applyPlace({
                address_components: (p.addressComponents || []).map(function (c) {
                    return {
                        types: c.types || [],
                        long_name: c.longText || '',
                        short_name: c.shortText || ''
                    };
                }),
                formatted_address: p.formattedAddress || '',
                name: textOf(p.displayName)
            });
        })
        .catch(function (err) {
            console.error('[Maps] fetchFields failed:', err);
        })
        .then(function () {
            // The token's billing session ends with the details call.
            acNewSessionToken();
        });
}

function acOnKeydown(e) {
    if (e.key === 'ArrowDown' && acIsOpen()) {
        e.preventDefault();
        acHighlight((acNew.active + 1) % acNew.suggestions.length);
    } else if (e.key === 'ArrowUp' && acIsOpen()) {
        e.preventDefault();
        acHighlight((acNew.active - 1 + acNew.suggestions.length) % acNew.suggestions.length);
    } else if (e.key === 'Enter' && acIsOpen()) {
        e.preventDefault();
        acNew.swallowEnterKeyup = true;
        acSelect(acNew.active >= 0 ? acNew.active : 0);
    } else if (e.key === 'Escape' && acIsOpen()) {
        e.preventDefault();
        acClose();
    }
}

/**
 * custom.js advances the step on keyup of Enter, on both the input and body.
 * Capture-phase stopPropagation keeps the Enter that picked a suggestion from
 * also skipping to the next question.
 */
function acOnKeyupCapture(e) {
    if (e.target !== acNew.input) return;
    if (e.key === 'Enter' && acNew.swallowEnterKeyup) {
        acNew.swallowEnterKeyup = false;
        e.stopPropagation();
        e.stopImmediatePropagation();
    } else if (acIsOpen() && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Escape')) {
        e.stopPropagation();
        e.stopImmediatePropagation();
    }
}

function initNewAutocomplete(input) {
    acNew.input = input;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    acBuildList();
    acNewSessionToken();

    var debounce = null;
    input.addEventListener('input', function () {
        var value = input.value.trim();
        clearTimeout(debounce);
        if (value.length < 3) { acNew.seq++; acClose(); return; }
        debounce = setTimeout(function () { acFetch(value); }, 180);
    });

    input.addEventListener('keydown', acOnKeydown);
    document.addEventListener('keyup', acOnKeyupCapture, true);
    input.addEventListener('blur', function () { setTimeout(acClose, 120); });

    window.addEventListener('resize', acPosition);
    window.addEventListener('scroll', acPosition, true);

    console.log('[Maps] Places API (New) autocomplete ready. Region restriction:',
                (mapsCfg('MAPS_COUNTRIES', ['au']) || []).join(', ') || 'none (worldwide)');
}

/* ==========================================================================
   Path 2 — legacy Autocomplete widget
   ========================================================================== */

function initLegacyAutocomplete(input) {
    const countries = mapsCfg('MAPS_COUNTRIES', ['au']);

    const options = {
        fields: ["address_components", "geometry", "icon", "name", "formatted_address"],
        strictBounds: false,
        types: ["address"]
    };
    if (countries && countries.length) {
        options.componentRestrictions = { country: countries };
    }

    autocomplete = new google.maps.places.Autocomplete(input, options);
    console.log('[Maps] Legacy autocomplete ready. Country restriction:',
                (countries && countries.length) ? countries.join(', ') : 'none (worldwide)');

    google.maps.event.addListener(autocomplete, 'place_changed', function () {
        applyPlace(autocomplete.getPlace());
    });
}

/* ==========================================================================
   Loader
   ========================================================================== */

function initMap() {
    const input = document.getElementsByName("Street")[0];
    if (!input) return;

    if (!window.google || !google.maps || !google.maps.places) {
        console.error('[Maps] Callback fired but google.maps.places is unavailable.');
        mapsAutocompleteUnavailable('places-library-missing');
        return;
    }

    if (google.maps.places.AutocompleteSuggestion) {
        initNewAutocomplete(input);
    } else {
        console.warn('[Maps] AutocompleteSuggestion missing from this API version — '
                   + 'using the legacy widget, which needs the legacy "Places API" SKU.');
        initLegacyAutocomplete(input);
    }
}

/**
 * Google calls this itself when the key is rejected — wrong referrer, billing off,
 * Places API not enabled, expired key. Without it the failure is silent.
 */
window.gm_authFailure = function () {
    console.error(
        '[Maps] Google rejected the API key. Usual causes:\n' +
        '  1. HTTP referrer restriction does not include this domain\n' +
        '  2. "Places API (New)" is not enabled on the key\'s project\n' +
        '  3. Billing is not enabled on the project\n' +
        'Google printed the exact error code on the console line above this one.'
    );
    mapsAutocompleteUnavailable('key-rejected');
};

/** Autocomplete is dead — let the user type the address instead of stalling. */
function mapsAutocompleteUnavailable(reason) {
    if (mapsFailed) return;
    mapsFailed = true;
    console.warn('[Maps] Falling back to manual address entry (' + reason + ').');

    if (typeof $ === 'undefined') return;
    var $street = $('#Street');
    if (!$street.length || $('#maps-fallback-note').length) return;

    $street.find('.answers-container').append(
        '<div id="maps-fallback-note" style="margin-top:10px;font-size:14px;color:#666;">' +
        'Address suggestions are unavailable — please type your full address, ' +
        'for example <strong>12 Smith Street</strong>.</div>'
    );
}

function mapsIsReady() {
    return !!(autocomplete || acNew.input);
}

function loadGoogleMaps() {
    if (mapsLoaded) return;
    mapsLoaded = true;

    var key = mapsCfg('MAPS_API_KEY', '');
    if (!key) {
        console.error('[Maps] No MAPS_API_KEY configured.');
        mapsAutocompleteUnavailable('no-api-key');
        return;
    }

    const script = document.createElement('script');
    script.src = 'https://maps.googleapis.com/maps/api/js'
               + '?key=' + encodeURIComponent(key)
               + '&libraries=places'
               + '&loading=async'
               + '&callback=initMap';
    script.async = true;
    script.onerror = function () {
        console.error('[Maps] Script failed to load — network blocked, offline, or malformed key.');
        mapsAutocompleteUnavailable('script-load-error');
    };
    document.head.appendChild(script);

    // If the callback never fires, the key was almost certainly rejected.
    setTimeout(function () {
        if (!mapsIsReady() && !mapsFailed) {
            console.error('[Maps] No callback after 8s — key likely rejected for this domain.');
            mapsAutocompleteUnavailable('callback-timeout');
        }
    }, 8000);
}

function bindMapsLoader() {
    const streetInput = document.querySelector('[name="Street"]');
    if (!streetInput) return;
    streetInput.addEventListener('focus', loadGoogleMaps, { once: true });
    streetInput.addEventListener('input', loadGoogleMaps, { once: true });
}

// Bind whether or not DOMContentLoaded has already fired.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindMapsLoader);
} else {
    bindMapsLoader();
}
