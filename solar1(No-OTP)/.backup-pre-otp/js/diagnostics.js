/**
 * Self-check for the enquiry form.
 *
 * Loads first, captures every script error and failed resource, then reports
 * what actually got loaded. Add ?debug=1 to the URL to always show the panel;
 * otherwise it only appears when the form is genuinely broken.
 *
 * Remove the <script src="js/diagnostics.js"> tag from index.html for production.
 */
(function () {
    // Bump this in js/custom.js, js/maps-autocomplete.js and js/diagnostics.js
    // TOGETHER. diagnostics.js compares all three, so a stamp left behind is
    // reported as a half-uploaded js/ folder. `python3 bust-cache.py` checks it.
    var EXPECTED_BUILD = 'au-e164-sheet-crm-2026-09-19';

    var errors = [];
    var failedResources = [];
    var clickLog = 'no option clicked yet';
    var buildMismatch = false;
    var endpointStatus = null;

    // Capture phase is required to see resource (script/css) load failures.
    window.addEventListener('error', function (e) {
        if (e.target && (e.target.tagName === 'SCRIPT' || e.target.tagName === 'LINK')) {
            failedResources.push(e.target.src || e.target.href || '(unknown)');
        } else if (e.message) {
            errors.push(e.message + '  —  ' + (e.filename || '?') + ':' + (e.lineno || '?'));
        }
    }, true);

    window.addEventListener('unhandledrejection', function (e) {
        errors.push('unhandled promise: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
    });

    function activeSteps() {
        return [].slice.call(document.querySelectorAll('.question.active'))
                 .map(function (q) { return q.id; }).join(', ') || '(none)';
    }

    function check() {
        var hasJq        = typeof window.jQuery !== 'undefined';
        var hasCustom    = typeof window.calculateProgress === 'function';
        var hasSheet     = typeof window.srSubmitWithoutOtp === 'function';
        var hasMask      = hasJq && typeof window.jQuery.fn.inputmask === 'function';
        var hasMaps      = typeof window.validateStress === 'function';

        var radio = document.querySelector('.answers-container input[type="radio"]');
        var bound = false;
        if (hasJq && radio) {
            var ev = window.jQuery._data(radio, 'events');
            bound = !!(ev && ev.change);
        }

        var urlDefined = typeof GOOGLE_SHEET_WEBAPP_URL !== 'undefined';
        var url = urlDefined ? GOOGLE_SHEET_WEBAPP_URL : '';
        var urlSet = !!url && url.indexOf('PASTE_YOUR') === -1;
        var urlNote = urlSet ? 'set'
                    : (!urlDefined ? 'not declared — index.html is missing the config block'
                                   : 'still the placeholder in index.html');

        var customBuild = (typeof SR_CUSTOM_BUILD !== 'undefined') ? SR_CUSTOM_BUILD : null;
        var mapsBuild   = (typeof SR_MAPS_BUILD !== 'undefined') ? SR_MAPS_BUILD : null;
        var customOk    = customBuild === EXPECTED_BUILD;
        var mapsOk      = mapsBuild === EXPECTED_BUILD;
        buildMismatch   = !customOk || !mapsOk;

        function buildNote(actual, loaded) {
            if (actual === EXPECTED_BUILD) return actual;
            if (actual) return 'server has build ' + actual + ', expected ' + EXPECTED_BUILD;
            return loaded ? 'DIFFERENT VERSION on the server — no build stamp'
                          : 'file did not load at all';
        }

        var broken = !hasJq || !hasCustom || !bound || !customOk || !mapsOk;
        var forced = location.search.indexOf('debug=1') !== -1;
        if (!broken && !forced) return;

        if (forced && urlSet && endpointStatus === null) {
            endpointStatus = { ok: false, pending: true, note: 'checking…' };
            pingEndpoint(url);
        }

        render([
            ['jQuery loaded',            hasJq,     hasJq ? window.jQuery.fn.jquery : 'js/jquery-3.2.1.min.js did not run'],
            ['custom.js ran',            hasCustom, hasCustom ? 'ok' : 'calculateProgress is undefined'],
            ['js/custom.js version',     customOk,  buildNote(customBuild, hasCustom)],
            ['js/maps-autocomplete.js',  mapsOk,    buildNote(mapsBuild, hasMaps)],
            ['sheet module present',     hasSheet,  hasSheet ? 'ok' : 'srSubmitWithoutOtp is undefined'],
            ['inputmask loaded',         hasMask,   hasMask ? 'ok' : 'only needed for STRICT_PHONE_VALIDATION'],
            ['option click handler',     bound,     bound ? 'bound' : 'NOT bound — clicks will do nothing'],
            ['sheet URL configured',     urlSet,    urlNote]
        ], broken);
    }

    function render(rows, broken) {
        // The endpoint line is printed further down but was not counted here,
        // so a failed deployment check sat underneath an "all good" heading —
        // which is exactly how a half-filling sheet goes unnoticed. Anything
        // the panel shows as FAIL now has to make the heading say so. A check
        // still in flight is not a failure.
        broken = broken
            || rows.some(function (r) { return !r[1]; })
            || !!(endpointStatus && !endpointStatus.ok && !endpointStatus.pending);

        var box = document.getElementById('sr-diagnostics');
        if (!box) {
            box = document.createElement('div');
            box.id = 'sr-diagnostics';
            box.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;max-width:min(560px,92vw);' +
                'background:#0f2b31;color:#e8f4f6;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
                'padding:14px 16px;border-radius:6px;box-shadow:0 6px 26px rgba(0,0,0,.35);max-height:70vh;overflow:auto;';
            document.body.appendChild(box);
        }

        var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:9px;">' +
            '<strong style="color:' + (broken ? '#ff9b8a' : '#7fd4c1') + ';">Form self-check' +
            (broken ? ' — something is broken' : ' — all good') + '</strong>' +
            '<span onclick="document.getElementById(\'sr-diagnostics\').remove()" ' +
            'style="cursor:pointer;padding:0 6px;color:#8fb3ba;">×</span></div>';

        rows.forEach(function (r) {
            html += '<div>' + (r[1] ? '<span style="color:#7fd4c1">PASS</span>' : '<span style="color:#ff9b8a">FAIL</span>') +
                '  ' + r[0] + '<span style="color:#8fb3ba"> — ' + esc(String(r[2])) + '</span></div>';
        });

        html += '<div style="margin-top:9px;color:#8fb3ba;">step: ' + esc(activeSteps()) +
                ' | ' + esc(clickLog) + '</div>';

        if (endpointStatus) {
            var mark = endpointStatus.pending
                ? '<span style="color:#8fb3ba">····</span>'
                : (endpointStatus.ok ? '<span style="color:#7fd4c1">PASS</span>'
                                     : '<span style="color:#ff9b8a">FAIL</span>');
            html += '<div style="margin-top:9px;">' + mark +
                '  sheet endpoint<span style="color:#8fb3ba"> — ' + esc(endpointStatus.note) + '</span></div>';
        }

        if (failedResources.length) {
            html += '<div style="margin-top:9px;color:#ff9b8a;">Files that failed to load:</div>';
            failedResources.forEach(function (r) {
                html += '<div style="color:#ffc9bf;word-break:break-all;">· ' + esc(r) + '</div>';
            });
        }

        if (errors.length) {
            html += '<div style="margin-top:9px;color:#ff9b8a;">JavaScript errors:</div>';
            errors.slice(0, 5).forEach(function (e) {
                html += '<div style="color:#ffc9bf;word-break:break-all;">· ' + esc(e) + '</div>';
            });
        }

        if (buildMismatch) {
            html += '<div style="margin-top:9px;color:#ffd68a;">The js/ folder on the server is not from ' +
                    'this build. Upload the whole solar1 folder rather than merging individual files.</div>';

            if (typeof SKIP_OTP_VERIFICATION !== 'undefined' && SKIP_OTP_VERIFICATION &&
                typeof window.sendCode === 'function' && typeof window.srSubmitWithoutOtp !== 'function') {
                html += '<div style="margin-top:6px;color:#ffd68a;">The custom.js being served still runs the ' +
                        'SMS flow — it posts to process.php, which is where "There was some problem" comes from.</div>';
            }

            html += '<div style="margin-top:6px;color:#ffd68a;">If you did upload js/, a CDN or the browser is ' +
                    'serving a cached copy. The ?v= on the script tags defeats that; purge the Cloudflare cache ' +
                    'if it persists.</div>';
        }

        if (broken && !failedResources.length && !errors.length) {
            html += '<div style="margin-top:9px;color:#ffd68a;">Scripts were skipped rather than failing. ' +
                    'Check the script tags in index.html for a type="..." attribute — anything other than ' +
                    'text/javascript is ignored by the browser.</div>';
        }

        box.innerHTML = html;
    }

    /** Confirms the Apps Script deployment answers anonymously. Writes no row. */
    function pingEndpoint(url) {
        // JSONP first — it is not subject to CORS, so a failure here is a real
        // failure rather than the browser refusing to show us the answer.
        jsonpPing(url).then(function (res) {
            if (res) { endpointStatus = res; check(); return; }
            postPing(url);
        });
    }

    /**
     * Reads the health check. Two things matter beyond "it answered":
     *
     *   build     - the version actually DEPLOYED. Editing Code.gs in the
     *               editor does not change it; only Deploy -> Manage
     *               deployments -> New version does. A stale build fills the
     *               columns it knew about and silently blanks the rest.
     *   unmapped  - headers this deployment cannot fill. Always blank columns,
     *               whatever the form sends.
     */
    function describePong(res) {
        var where = 'tab "' + res.sheet + '", ' + res.rows + ' rows';
        var build = res.build || null;

        if (!build) {
            return { ok: false, note: where +
                ' — DEPLOYED SCRIPT IS OLD (no build stamp). Apps Script -> Deploy' +
                ' -> Manage deployments -> edit -> Version: New version.' };
        }
        if (build !== EXPECTED_BUILD) {
            return { ok: false, note: where + ' — deployed script is build ' + build +
                ', this site expects ' + EXPECTED_BUILD +
                '. Redeploy Code.gs as a New version.' };
        }
        if (res.unmapped && res.unmapped.length) {
            return { ok: false, note: where + ' — these columns can never fill: ' +
                res.unmapped.join(' | ') + '. Check the spelling in row 1.' };
        }
        return { ok: true, note: where + ', build ' + build +
            ', columns: ' + (res.headers || []).join(' | ') };
    }

    function jsonpPing(url) {
        return new Promise(function (resolve) {
            var cb = 'srping_' + Date.now();
            var script = document.createElement('script');
            var done = false;

            function cleanup() {
                try { delete window[cb]; } catch (e) { window[cb] = undefined; }
                if (script.parentNode) script.parentNode.removeChild(script);
            }

            var timer = setTimeout(function () {
                if (done) return; done = true; cleanup();
                resolve({ ok: false, note: 'no answer within 10s — check the deployment URL' });
            }, 10000);

            window[cb] = function (res) {
                if (done) return; done = true; clearTimeout(timer); cleanup();
                resolve(res && res.pong ? describePong(res)
                    : { ok: false, note: 'answered without pong — redeploy Code.gs as a New version' });
            };

            script.onerror = function () {
                if (done) return; done = true; clearTimeout(timer); cleanup();
                resolve({ ok: false, note: 'refused the request — a Google sign-in redirect. ' +
                                           'Set the deployment to Execute as: Me, Who has access: Anyone.' });
            };

            script.src = url + (url.indexOf('?') === -1 ? '?' : '&') + 'ping=1&callback=' + cb;
            document.head.appendChild(script);
        });
    }

    function postPing(url) {
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ ping: true })
        })
        .then(function (r) { return r.text(); })
        .then(function (text) {
            var trimmed = String(text).trim();

            if (trimmed.charAt(0) !== '{') {
                endpointStatus = {
                    ok: false,
                    note: /sign in|accounts\.google/i.test(trimmed)
                        ? 'Google returned a login page — the deployment is not set to "Anyone"'
                        : 'returned HTML, not JSON — check the deployment'
                };
            } else {
                var res = JSON.parse(trimmed);
                endpointStatus = res.pong
                    ? { ok: true, note: 'reachable — tab "' + res.sheet + '", ' + res.rows +
                                        ' rows, columns: ' + (res.headers || []).join(' | ') }
                    : { ok: false, note: 'responded but without pong — Code.gs is an older version' };
            }
            check();
        })
        .catch(function (err) {
            endpointStatus = { ok: false, note: 'unreachable — ' + (err && err.message ? err.message : err) };
            check();
        });
    }

    function esc(s) {
        return String(s).replace(/[&<>]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
        });
    }

    // Report whether an option click actually moved the form on.
    document.addEventListener('click', function (e) {
        var input = e.target.closest ? e.target.closest('.answers-container li') : null;
        if (!input) return;
        var before = activeSteps();
        setTimeout(function () {
            var after = activeSteps();
            clickLog = (before === after)
                ? 'last click did NOT advance (' + before + ')'
                : 'last click advanced: ' + before + ' -> ' + after;
            if (document.getElementById('sr-diagnostics')) check();
        }, 150);
    }, true);

    if (document.readyState === 'complete') setTimeout(check, 400);
    else window.addEventListener('load', function () { setTimeout(check, 400); });
})();
