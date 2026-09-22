/**
 * Optimal Transnational - Lead Form JavaScript
 * 
 * Multi-lead-type form with reliable submission pipeline.
 * Three lead types: residential solar, battery, commercial solar
 * 
 * Features:
 * - Config-driven lead type routing (from LEAD_TYPE_CONFIG in index.php)
 * - sessionStorage for secure data passing (no URL parameters)
 * - Single SMS verification input
 * - Dynamic question paths based on CustomerType
 */

var is_phone_verified = false;
var current_step_number = 1;
var prev_question_tracker = [];
var total_questions = 22;

// ============================================
// GENERATE UNIQUE EVENT ID
// ============================================
function generateEventId() {
    var characters = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    var result = '';
    for (var i = 0; i < 32; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

// ============================================
// HOTJAR EVENT TRACKING
// ============================================
var hotjarTracking = {
    started: false,
    submitted: false
};

function trackHotjarEvent(eventName) {
    if (typeof hj === 'function') {
        hj('event', eventName);
        console.log('[Hotjar] Event:', eventName);
    }
}

// Map question IDs to Hotjar event names (COMMERCIAL FORM SPECIFIC)
// These track the commercial solar journey for funnel analysis
var hotjarStepEventMap = {
    // Entry point - determines commercial vs residential path
    'CustomerType': 'step_property_type',
    
    // Commercial-specific qualification
    'BusinessOwner': 'step_business_owner',
    'OwnOrLease': 'step_own_or_lease',
    'LiveInBuilding': 'step_live_in_building',
    'LengthOfLease': 'step_lease_length',
    
    // Residential path (if flipped or selected residential)
    'Homeowner': 'step_homeowner',
    
    // Product interest
    'ProductType': 'step_product_type',
    
    // Solar system questions
    'ExistingSolar': 'step_existing_solar',
    'ExistingSolarAge': 'step_solar_age',
    
    // Residential-only questions (for flipped leads)
    'RoofType': 'step_roof_type',
    'HomeAge': 'step_home_age',
    'ShadingIssues': 'step_shading',
    
    // Bill size (different versions for commercial vs residential)
    'BillSize': 'step_bill_size_residential',
    'BillSizeCommercial': 'step_bill_size_commercial',
    
    // Business details (commercial only)
    'BusinessName': 'step_business_name',
    
    // Address collection
    'Street': 'step_address',
    
    // Contact details
    'FirstName': 'step_name',
    'EmailAddress': 'step_contact'
};

// ============================================
// SINGLE SMS VERIFICATION INPUT HANDLING
// ============================================
$(function () {
    'use strict';

    // Generate fresh event_id on page load
    var freshEventId = generateEventId();
    $('#event_id').val(freshEventId);
    console.log('[Optimal Transnational] Event ID generated:', freshEventId);

    // Hotjar: Track form start on first interaction
    $('form').one('click focus', 'input, select, textarea, label', function() {
        if (!hotjarTracking.started) {
            hotjarTracking.started = true;
            trackHotjarEvent('form_started');
        }
    });

    var $verificationInput = $('#verification-code');

    // Keydown handler - Allow numbers, backspace, delete, tab, Ctrl+A/C/V/X
    $verificationInput.on('keydown', function(e) {
        var key = e.which || e.keyCode;
        var ctrl = e.ctrlKey || e.metaKey;
        
        // Allow: backspace, delete, tab, escape, enter, Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+X
        if (key === 8 || key === 9 || key === 27 || key === 13 || 
            key === 46 || (ctrl && (key === 65 || key === 67 || key === 86 || key === 88))) {
            return true;
        }
        
        // Allow: numbers (0-9) on both main keyboard and numpad
        if ((key >= 48 && key <= 57) || (key >= 96 && key <= 105)) {
            return true;
        }
        
        // Block everything else
        e.preventDefault();
        return false;
    });

    // Keyup handler - Update verification code
    $verificationInput.on('keyup', function() {
        getVerificationCode();
    });

    // Focus handler - Select all text
    $verificationInput.on('focus', function() {
        $(this).select();
    });

    // Input handler - Strip spaces and non-numeric characters
    $verificationInput.on('input', function() {
        var value = $(this).val();
        // Strip all whitespace including NBSP and other Unicode whitespace
        value = value.replace(/[\s\u00A0\u2000-\u200B\u2028\u2029\uFEFF]/g, '');
        // Strip non-numeric characters
        value = value.replace(/[^0-9]/g, '');
        // Limit to 6 digits
        value = value.substring(0, 6);
        $(this).val(value);
        getVerificationCode();
    });

    // Paste handler - Strip spaces from pasted content
    $verificationInput.on('paste', function(e) {
        e.preventDefault();
        var pastedText = (e.originalEvent.clipboardData || window.clipboardData).getData('text');
        // Strip all whitespace including NBSP
        pastedText = pastedText.replace(/[\s\u00A0\u2000-\u200B\u2028\u2029\uFEFF]/g, '');
        // Strip non-numeric characters
        pastedText = pastedText.replace(/[^0-9]/g, '');
        // Limit to 6 digits
        pastedText = pastedText.substring(0, 6);
        $(this).val(pastedText);
        getVerificationCode();
    });
});

// ============================================
// GET VERIFICATION CODE (Single Input)
// ============================================
function getVerificationCode() {
    var value = $('#verification-code').val() || '';
    
    // Strip all whitespace including NBSP and other Unicode whitespace
    var verification_code = value.replace(/[\s\u00A0\u2000-\u200B\u2028\u2029\uFEFF]/g, '');
    
    // Strip non-numeric characters
    verification_code = verification_code.replace(/[^0-9]/g, '');
    
    // Limit to 6 digits
    verification_code = verification_code.substring(0, 6);
    
    // Update input value if it was modified
    if (value !== verification_code) {
        $('#verification-code').val(verification_code);
    }

    console.log('verification_code', verification_code);
    if (verification_code.length == 6) {
        $('#verify-code').removeAttr('disabled');
    } else {
        $('#verify-code').attr('disabled', 'disabled');
    }
    return verification_code;
}

function formatNumber(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ============================================
// DOCUMENT READY - FORM INITIALIZATION
// ============================================
$(document).ready(function () {

    // Postcode is hardcoded to exactly 4 characters in the markup (AU format).
    // Relaxed address mode widens it so PINs and ZIPs are accepted.
    if (!srStrictAddress()) {
        $('#Postcode input')
            .attr('minlength', srCfgPostcodeMin())
            .attr('maxlength', srCfgPostcodeMax())
            .attr('placeholder', 'Postcode');
    }

    if (srStrictPhone()) {
        $('#PhoneNumber input').inputmask("9 9 9 9  9 9 9  9 9 9", {"placeholder": "_ _ _ _  _ _ _  _ _ _"});
    } else {
        // No inputmask. Length is held to the 9 national digits by
        // srClampAuPhoneInput below instead, which keeps +61 pastes intact.
        // Remove a mask defensively in case a cached script already applied one.
        try { $('#PhoneNumber input').inputmask('remove'); } catch (e) { /* none applied */ }
        $('#PhoneNumber input')
            .removeAttr('data-phone')
            .attr('inputmode', 'tel')
            .attr('placeholder', srAuPhoneEnabled() ? '412 345 678' : 'Your phone number');
    }

    if (srAuPrefixMode()) {
        // The +61 chip goes on before the first keystroke, so the country code
        // is never something the lead has to remember to type.
        srMountAuPhonePrefix('#PhoneNumber-field', '412 345 678');
        srMountAuPhonePrefix('#LandlordPhone-field', '412 345 678');

        // 'input' rather than 'keyup' so paste, autofill and long-press-paste
        // on mobile are all caught, not just typing.
        $('#PhoneNumber input, #LandlordPhone-field').on('input', function () {
            srClampAuPhoneInput(this);
        });

        // The landlord field sits outside the .question blur handler below.
        $('#LandlordPhone-field').on('blur', function () {
            srTidyAuPhoneField(this);
        });
    }

    $('#RefinancingImportance input').change(function (e) {
        if ($('#RefinancingImportance input:checked').length >= 2) {
            $('#RefinancingImportance input:not(:checked)').attr('disabled', 'disabled');
        } else {
            $('#RefinancingImportance input').removeAttr('disabled');
        }
    });

    $('.answers-container input[type="radio"]').change(function (e) {
        $('#next-question').removeAttr('disabled');
        $('#next-question').click();
    });
    $('.answers-container input[type="checkbox"]').change(function (e) {
        if ($('.question.active').find('input:checked').length) {
            if ($('.question.active').data('selection') === undefined || ($('.question.active').find('input:checked').length == $('.question.active').data('selection'))) {
                $('#next-question').removeAttr('disabled');
                $('#next-question').click();
            }
        } else {
            $('#next-question').attr('disabled', 'disabled');
        }
    });

    $("body").on("keyup", function (e) {
        if (e.key == 'Enter') {
            var q_type = $('.question.active').data('type');
            if (q_type == 'radio' || q_type == 'checkbox') {
                if ($('.question.active').find('input:checked').length) {
                    e.preventDefault();
                    $('#next-question').click();
                }
            } else { // input
                if ($('.question.active').find('input').val().trim() != '') {
                    e.preventDefault();
                    if ($('#Street').hasClass('active') && srAddressOk($('#Street input').val().trim()) == false) {
                        $('#next-question').attr('disabled', 'disabled');
                        if ($('#Street input').val().trim() != '') {
                            $('#Street').find('.error-holder').html('<i class="fa fa-warning"></i> Please enter your full street address.').css('display', 'inline-block');
                        }
                    } else {
                        $('#next-question').click();
                    }
                }
            }
        }
    });

    $('.question input').keyup(function (e) {

        validateData(1);
        if (e.key == 'Enter') {
            if ($(this).val().trim() != '') {

                e.stopPropagation();

                if ($('.question.active').attr('id') == 'final')
                {
                    $('#verify-code').click();
                } else
                {
                    if ($('#Street').hasClass('active') && srAddressOk($('#Street input').val().trim()) == false) {
                        $('#next-question').attr('disabled', 'disabled');
                        if ($('#Street input').val().trim() != '') {
                            $('#Street').find('.error-holder').html('<i class="fa fa-warning"></i> Please enter your full street address.').css('display', 'inline-block');
                        }
                    } else {
                        $('#next-question').click();
                    }
                }

            }

        }
    });

    $('.question input[inputmode="numeric"]').keyup(function (e) {
        var input = $(this).val().trim();
        input = input.replace(/[^0-9]/g, '');
        $(this).val(input);
    });

    $('.question input[data-convert-amount]').keyup(function (e) {
        var entered_amount = $(this).val().trim();
        if (entered_amount != '') {
            entered_amount = convertAmount(entered_amount);
            $(this).val(entered_amount);
        }
    });

    $('.question input[type="radio"], .question input[type="checkbox"]').change(function (e) {
        validateData();
    });

    $('.question input').blur(function (e) {
        if ($(this).attr('name') == 'PhoneNumber') {
            srTidyAuPhoneField();
        }

        validateData();

        calculateProgress();
    });

    $('.question select').change(function (e) {
        validateData();

        calculateProgress();
    });

    $('.answer_ok').click(function (e) {
        validateData();

        if ($('.question.active input').data('phone') !== undefined && srPhoneOk() && !is_phone_verified) {
            sendCode();
        } else {
            $('#next-question').click();
        }

    });

    // ============================================
    // NEXT QUESTION - DYNAMIC PATH LOGIC
    // ============================================
    $('#next-question').click(function (e) {
        $('#next-question').show();
        if (validateData()) {
            return;
        }

        // The renter branch is terminal — it carries no data-next, so submit the
        // landlord referral here rather than falling through to the walk below.
        if ($('#RenterNotice').hasClass('active')) {
            srSubmitRenterReferral();
            return false;
        }
        
        // Residential-only funnel. The commercial branch (BillSizeCommercial /
        // BusinessName) was removed, so the path is always the residential one:
        // RoofType -> HomeAge -> ShadingIssues -> BillSize
        //
        // Both answers to "do you already have solar" run through that path.
        // The only thing No skips is the age question, which only makes sense
        // to ask of someone who said Yes — the roof, the home and the shading
        // decide what can be installed either way, so the sheet gets the same
        // columns from both. Re-asserted here so a cached index.html, which
        // used to send No straight to BillSize, cannot short-circuit it.
        $('#ExistingSolarAge .answers-container input').attr('data-next', '#RoofType');
        $('#ExistingSolar .answers-container input[value=No]').attr('data-next', '#RoofType');
        
        if ($('.question.active').data('type') == 'radio') {
            var next_question = $('.question.active').find('input:checked').attr('data-next');
        } else { // q-type input
            var next_question = $('.question.active').attr('data-next');
        }

        if (next_question == '#final') {
            $('#next-question').addClass('d-none');

            // ============================================================
            // NO-OTP PATH: phone entered -> push straight to Google Sheet
            // Toggle with SKIP_OTP_VERIFICATION in index.html
            // ============================================================
            if (typeof SKIP_OTP_VERIFICATION !== 'undefined' && SKIP_OTP_VERIFICATION) {
                if (srPhoneOk()) {
                    srSubmitWithoutOtp();
                } else {
                    $('#next-question').removeClass('d-none');
                    $('#PhoneNumber .error-holder')
                        .html('<i class="fa fa-warning"></i> ' + srPhoneError())
                        .css('display', 'inline-block');
                }
                return false;
            }

            if (srPhoneOk() && !is_phone_verified) {
                sendCode();
                return false;
            }
        }

        var q_ids = [];
        var completedQuestionId = '';
        $('.question.active').each(function () {
            q_ids.push('#' + $(this).attr('id'));
            completedQuestionId = $(this).attr('id');
        });
        prev_question_tracker.push(q_ids.join(', '));

        // Hotjar: Track step completion
        if (hotjarStepEventMap[completedQuestionId]) {
            trackHotjarEvent(hotjarStepEventMap[completedQuestionId]);
        }

        $('.question.active').removeClass('active');
        $(next_question).addClass('active');

        $('#prev-question').removeClass('d-none');

        $('.question.active').each(function () {
            $(this).find('.current_step_number').html(++current_step_number);
        });

        if ($('.question.active').attr('id') == 'final') {
            $('#next-question').addClass('d-none');
        }

        validateData();
        if (!$('.question.active').first().find('input').first().hasClass('hasDatepicker')) {
            $('.question.active').first().find('input').first().focus();
        }
        calculateProgress();
        if ($('div[data-type="label"]').hasClass('active')) {
            $('#next-question').hide();
        }
        srSyncRenterStep();
    });

    $('#prev-question').click(function (e) {
        $('#next-question').removeClass('ch_disable');
        $('#next-question').show();
        var prev_question = prev_question_tracker.pop();
        $('.question.active').each(function () {
            --current_step_number;
        });
        $('.question.active').removeClass('active');
        $(prev_question).addClass('active');
        $('.question.active').each(function () {
            --current_step_number;
        });
        $('.question.active').each(function () {
            $(this).find('.current_step_number').html(++current_step_number);
        });

        if (!prev_question_tracker.length) {
            $('#prev-question').addClass('d-none');
        }

        $('#next-question').removeAttr('disabled').removeClass('d-none');

        validateData();
        if (!$('.question.active').first().find('input').first().hasClass('hasDatepicker')) {
            $('.question.active').first().find('input').first().focus();
        }
        calculateProgress();
        if ($('div[data-type="label"]').hasClass('active')) {
            $('#next-question').hide();
        }
        srSyncRenterStep();
    });
});


// ============================================================
// RENTER BRANCH
// Homeowner = Rent ends the funnel early: we cannot assess a property in a
// tenant's name, so the step collects optional landlord contact details and
// submits them as a "renter referral" lead.
// ============================================================
var SR_NEXT_LABEL_DEFAULT = 'Continue';
var SR_RENTER_SUBMIT_LABEL = 'Submit';

/**
 * data-type="label" makes both navigation handlers hide #next-question. The
 * renter step still needs it, as its submit control — and the step is the end
 * of that path, so the progress bar reads complete.
 */
function srSyncRenterStep() {
    var $next = $('#next-question');
    if ($('#RenterNotice').hasClass('active')) {
        $next.show().removeClass('d-none').removeAttr('disabled').text(SR_RENTER_SUBMIT_LABEL);
        $('#progress-bar').css('width', '100%');
        $('#percentage').html(100);
    } else if ($next.text() === SR_RENTER_SUBMIT_LABEL) {
        $next.text(SR_NEXT_LABEL_DEFAULT);
    }
}

/**
 * Submits the renter referral. Deliberately skips the completeness guard in
 * srSubmitWithoutOtp() — this path answers two questions, not twelve — but
 * reuses the same sheet/Zapier/thank-you plumbing so there is one pipeline.
 */
function srSubmitRenterReferral() {
    if (SR_SUBMIT_IN_PROGRESS) return;

    // Optional field — only checked when the tenant actually filled it in.
    var $landlordPhone = $('#LandlordPhone-field');
    var landlordRaw = String($landlordPhone.val() || '').trim();
    if (srAuPhoneEnabled() && landlordRaw) {
        var landlordCheck = srAuPhoneCheck(landlordRaw);
        if (!landlordCheck.ok) {
            $('#RenterNotice .error-holder')
                .html('<i class="fa fa-warning"></i> ' + landlordCheck.message)
                .css('display', 'inline-block');
            $landlordPhone.focus();
            return;
        }
        $landlordPhone.val(landlordCheck.display);
    }

    SR_SUBMIT_IN_PROGRESS = true;

    $('.error-holder').html('').hide();
    $('#next-question').attr('disabled', 'disabled');
    srShowStatus('Sending your details, please wait…', false);

    var leadType = 'renter referral';
    var results = calculateProgress();
    var data = srBuildLeadData(results.questions, leadType);

    // Make the branch unmistakable in the sheet, however the columns are read.
    data.homeowner = 'Rent';
    data.renter_referral = 'Yes';
    data.landlord_details_provided =
        (data.landlord_name || data.landlord_phone) ? 'Yes' : 'No';
    data.consent_statement = "Renter branch: the tenant was told the assessment "
        + "cannot be completed in their name and was invited to pass on their "
        + "landlord's contact details for Optimal Transnational to approach.";

    console.log('[Sheet] Lead type:', leadType);
    console.log('[Sheet] Payload:', data);

    try {
        sessionStorage.setItem('optimaltransnational_lead_data', JSON.stringify(data));
    } catch (e) {
        console.error('[Sheet] sessionStorage write failed:', e);
    }

    trackHotjarEvent('renter_referral_submitted');
    hotjarTracking.submitted = true;

    srPostToZapier(data, leadType);

    var settled = false;
    var finish = function () {
        if (settled) return;
        settled = true;
        srRedirectToThankYou(leadType);
    };

    srPostToSheet(data)
        .then(function (res) {
            if (res.ok || !srCfgStrictSubmit()) {
                if (!res.ok) {
                    srStashFailed(data);
                    console.error('[Sheet] Not saved, continuing anyway: ' + res.reason);
                }
                finish();
                return;
            }
            srStashFailed(data);
            settled = true;
            SR_SUBMIT_IN_PROGRESS = false;
            $('#next-question').removeAttr('disabled');
            srShowStatus('<i class="fa fa-warning"></i> Not saved to the sheet.<br>' +
                         esc_(res.reason), true);
        })
        .catch(function (err) {
            console.error('[Sheet] Submit failed:', err);
            srStashFailed(data);
            settled = true;
            SR_SUBMIT_IN_PROGRESS = false;
            $('#next-question').removeAttr('disabled');
            srShowStatus('<i class="fa fa-warning"></i> ' +
                         esc_(err && err.message ? err.message : String(err)), true);
        });

    setTimeout(function () {
        if (!settled) {
            srBeacon(srCfgSheetUrl(), JSON.stringify(data));
            finish();
        }
    }, srCfgTimeout());
}

// ============================================
// CALCULATE PROGRESS
// ============================================
function calculateProgress()
{
    // Residential-only funnel. CustomerType is hidden and pre-answered, so it is
    // counted in the walk below but not shown to the user - hence 16/15 are the
    // real totals. The two paths differ by exactly one step now: No skips the
    // solar-age question and rejoins at RoofType.
    if ($('#ExistingSolar input:checked').val() == 'Yes') {
        total_questions = 16;
    } else {
        total_questions = 15;
    }
    var questions = [];
    var q_answered = 0;

    var next_question = '#CustomerType';
    var q1 = $(next_question).find('input:checked');

    if (q1.length)
    {
        var has_radio_val = true;
        var has_multiple = false;
        var sub_next_questions = [];
        let current_sub_question = 0;

        while (next_question !== undefined && has_radio_val && next_question != '#final')
        {
            if (has_multiple)
            {
                current_sub_question += 1;

                if (current_sub_question == sub_next_questions.length)
                {
                    current_sub_question = 0;
                    has_multiple = false;
                    next_question = $(next_question).attr('data-next');

                    if (next_question == '#final')
                    {
                        break;
                    }
                } else
                {
                    next_question = sub_next_questions[current_sub_question];
                }
            }

            if (next_question.includes(', ') && !has_multiple)
            {
                sub_next_questions = next_question.split(', ');
                next_question = sub_next_questions[0];
                has_multiple = true;
            }

            if ($(next_question).data('type') == 'radio')
            {
                var checked = $(next_question).find('input:checked');
                if (!$(checked).length) {
                    if ($(checked).data('skips') !== undefined) {
                        has_radio_val = false;
                    }
                } else {
                    var q_skips = $(checked).data('skips');
                    total_questions -= parseInt(q_skips);
                    var question = $(next_question).find('.question-title').data('title');
                    questions.push({question: question, answer: $(checked).val(), name: $(checked).attr('name')});

                }
                next_question = $(checked);
            } else if ($(next_question).data('type') == 'checkbox')
            {
                var checked = $(next_question).find('input:checked');
                if ($(checked).length) {
                    var checkboxes_answers = '';
                    $(checked).each(function () {
                        checkboxes_answers += $(this).val() + '<br/>';
                    });

                    var question = $(next_question).find('.question-title').data('title');
                    questions.push({question: question, answer: checkboxes_answers, name: $(checked).attr('name')});

                }
            } else if ($(next_question).data('type') == 'select')
            {
                var select = $(next_question).find('select');
                var selected = $(select).find(":selected");
                if ($(selected).val() != '') {

                    var question = $(next_question).find('.question-title').data('title');
                    questions.push({question: question, answer: $(selected).val(), name: $(select).attr('name')});

                }
            } else if ($(next_question).data('type') == 'number')
            {
                var input = $(next_question).find('input');
                var entered_value = $(input).val();
                if (entered_value != '') {
                    var question = $(next_question).find('.question-title').data('title');
                    questions.push({question: question, answer: entered_value, name: $(input).attr('name')});

                }
            } else if ($(next_question).data('type') == 'label')
            {
                // Don't need to do anything
            } else
            {
                var input = $(next_question).find('input');
                var entered_value = $(input).val();
                if (entered_value != '') {
                    var question = $(next_question).find('.question-title').data('title');
                    if ($(input).data('icon') !== undefined) {
                        if ($(input).data('icon') == 'icon-dollar') {
                            entered_value = '$ ' + entered_value;
                        } else if ($(input).data('icon') == 'icon-percent') {
                            entered_value = entered_value + '%';
                        }
                    }
                    questions.push({question: question, answer: entered_value, name: $(input).attr('name')});
                }
            }

            if (!has_multiple)
            {
                next_question = $(next_question).attr('data-next');
            }
        }

        q_answered = questions.length;
        var percentage = Math.round((q_answered / total_questions) * 100);

        $('#progress-bar').css('width', percentage + '%');
        $('#percentage').html(percentage);
    } else
    {
        $('#progress-bar').css('width', '0px');
    }

    return {
        total_questions: total_questions,
        q_answered: q_answered,
        questions: questions,
    };
}

function getWordCount(str) {
    return str.trim().split(/\s+/).length;
}

// ============================================
// STREET ADDRESS VALIDATION
// ----------------------------------------------
// The rule itself lives in maps-autocomplete.js. This file used to declare a
// second, stricter copy that was silently overwritten because that file loads
// later. Every check now goes through srAddressOk().
// ============================================

$('body').on('keyup', '#Street input', function () {
    if (srAddressOk($('#Street input').val().trim()) == false) {
        $('#next-question').attr('disabled', 'disabled');
        if ($('#Street input').val().trim() != '') {
            $('#Street').find('.error-holder').html('<i class="fa fa-warning"></i> Please enter your full street address.').css('display', 'inline-block');
        }
    } else {
        $('#next-question').removeAttr('disabled');
        $('.question.active .error-holder').hide().html('');
    }
});

// ============================================
// FORM VALIDATION
// ============================================
function validateData(hide_error) {
    if (hide_error === undefined) {
        hide_error = 0;
    }
    $('.question.active .error-holder').hide().html('');
    $('#next-question').removeAttr('disabled');
    var has_error = false;
    var show_phone_enter_btn = false;

    $('.question.active').each(function () {
        var q_type = $(this).data('type');
        if (q_type == 'radio' || q_type == 'checkbox') {
            if (!$(this).find('input:checked').length) {
                has_error = true;
            }
        } else if (q_type == 'label') {
            // Informational step. Any inputs on it are optional, so nothing to
            // validate and nothing to block on.
        } else { // input
            var input_value = $(this).find('input').val();
            if (input_value == '') {
                has_error = true;
            } else if ($(this).find('input').data('min') !== undefined && $(this).find('input').data('max') !== undefined) {
                var min = min_str = $(this).find('input').data('min');
                var max = max_str = $(this).find('input').data('max');
                if ($(this).find('input').data('convert-amount') !== undefined) {
                    input_value = input_value.replace(/,/g, '');
                    min_str = convertAmount(min);
                    max_str = convertAmount(max);
                }
                var number_value = parseInt(input_value);
                if (number_value < min || number_value > max) {
                    if (!hide_error) {
                        $(this).find('.error-holder').html('<i class="fa fa-warning"></i> Please enter a number between ' + min_str + ' and ' + max_str + '').css('display', 'inline-block');
                    }
                    has_error = true;
                }
            } else if ($(this).find('input').attr('minLength') !== undefined && $(this).find('input').attr('maxLength') !== undefined) {
                var minLength = $(this).find('input').attr('minLength');
                var maxLength = $(this).find('input').attr('maxLength');
                var current_length = input_value.length;
                if (current_length < minLength || current_length > maxLength) {
                    if (!hide_error) {
                        $(this).find('.error-holder').html('<i class="fa fa-warning"></i> Post code should be between ' + minLength + ' and ' + maxLength + '').css('display', 'inline-block');
                    }
                    has_error = true;
                }
            } else if ($(this).find('input').attr('type') == 'email') {
                if (!validateEmail(input_value)) {
                    if (!hide_error) {
                        $(this).find('.error-holder').html('<i class="fa fa-warning"></i> Hmm... that email doesn\'t look valid').css('display', 'inline-block');
                    }
                    has_error = true;
                }
            } else if ($(this).find('input').attr('name') == 'FirstName' || $(this).find('input').attr('name') == 'LastName') {
                if (input_value.length <= 1) {
                    if (!hide_error) {
                        $('#LastName').find('.error-holder').html('<i class="fa fa-warning"></i> Please enter your full name').css('display', 'inline-block');
                    }
                    has_error = true;
                }
            } else if ($(this).find('input').attr('name') == 'PhoneNumber') {
                // Keyed on the field name, not data-phone: relaxed mode strips
                // that attribute, which used to skip the check entirely.
                if (!srPhoneOk()) {
                    if (!hide_error) {
                        $(this).find('.error-holder')
                            .html('<i class="fa fa-warning"></i> ' + srPhoneError())
                            .css('display', 'inline-block');
                    }
                    has_error = true;
                }
            } else if ($(this).find('input').data('phone') !== undefined && !is_phone_verified) {
                if (!srPhoneOk()) {
                    has_error = true;
                }

            }
        }
    });

    if (has_error) {
        $('#next-question').attr('disabled', 'disabled');
    }
    if ($('#Street').hasClass('active')) {
        if (srAddressOk($('#Street input').val().trim()) == false) {
            $('#next-question').attr('disabled', 'disabled');
            if ($('#Street input').val().trim() != '') {
                $('#Street').find('.error-holder').html('<i class="fa fa-warning"></i> Please enter your full street address.').css('display', 'inline-block');
            }
        }
    }

    return has_error;
}

function validateEmail(email) {
    const re = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
    return re.test(String(email).toLowerCase());
}

// ============================================
// SMS VERIFICATION - SEND CODE
// ============================================
function sendCode() {
    if ($('#PhoneNumber input').val() != '') {
        var data = {
            action: 'send-code',
            phone_number: srPhoneSubmitValue()
        };

        $.ajax({
            type: "POST",
            url: 'process.php',
            data: data,
            dataType: 'json',
            success: function (res) {
                if (res.is_error) {
                    $('#PhoneNumber .error-holder').html(res.message).css('display', 'inline-block');
                    $('#next-question').removeClass('d-none');
                } else {
                    if (document.querySelector("#resend-code").disabled)
                    {
                        $('#resend-code').hide();
                        document.querySelector("#resend-code").disabled = false;
                    } else
                    {
                        is_phone_verified = true;
                        $('#entered_phone_number').html(srPhoneDisplayValue());
                        $('#next-question').click();
                        is_phone_verified = false;
                    }
                }
            },
            error: function (error) {
                $('#PhoneNumber .error-holder').html('<i class="fa fa-warning"></i> There was some problem').css('display', 'inline-block');
            }
        });
    }
}

// ============================================
// SMS VERIFICATION - VERIFY CODE & SUBMIT
// ============================================
function verifyCode() {
    var verification_code = getVerificationCode();
    if (verification_code.length == 6) {

        var results = calculateProgress();
        if ((results.total_questions - 1) > results.q_answered) {
            $('.question.active .error-holder').html('<i class="fa fa-warning"></i> Please answer all questions').css('display', 'inline-block');
            return false;
        }
        $('#verify-code').attr('disabled', 'disabled');

        var questions = results.questions;

        // ============================================================
        // MULTI-LEAD-TYPE: Determine lead type based on user answers
        // THREE LEAD TYPES: commercial solar, battery, residential solar
        // ============================================================
        var leadType = DEFAULT_LEAD_TYPE; // Start with default from config
        
        // Residential-only funnel: lead type is decided purely by ProductType
        if ($('#ProductType input:checked').val() === 'Battery Only') {
            leadType = 'battery';
        } else {
            // Solar Only or Solar & Battery → residential solar
            leadType = 'residential solar';
        }
        
        // Lookup configuration from config.php (passed via index.php)
        var config = LEAD_TYPE_CONFIG[leadType] || LEAD_TYPE_CONFIG[DEFAULT_LEAD_TYPE];
        
        var zapierWebhookUrl = config.zapier_webhook_url;
        var secondaryWebhooks = config.zapier_secondary_webhooks || [];
        var thankYouPageUrl = config.thank_you_page_url;
        
        console.log('[Optimal Transnational] Lead Type:', leadType);
        console.log('[Optimal Transnational] Webhook URL:', zapierWebhookUrl);
        console.log('[Optimal Transnational] Thank You URL:', thankYouPageUrl);

        // Read the event_id that was generated on page load
        var currentEventId = $('#event_id').val();
        
        // Build structured payload for JSON POST to backend
        var payload = {
            event_id: currentEventId,
            lead_type: leadType,
            lead: {
                first_name: $('#FirstName input').val(),
                last_name: $('#LastName input').val(),
                email_address: $('#EmailAddress input').val(),
                phone_number: srPhoneSubmitValue(),
                street_address: questions.find(function(q) { return q.name === 'Street'; })?.answer || '',
                suburb_city: $('#City input').val() || questions.find(function(q) { return q.name === 'City'; })?.answer || '',
                postcode: $('#Postcode input').val() || questions.find(function(q) { return q.name === 'Postcode'; })?.answer || '',
                business_name: $('#BusinessName input').val() || questions.find(function(q) { return q.name === 'BusinessName'; })?.answer || ''
            },
            utm: {
                source: $('#utm_source').val() || null,
                medium: $('#utm_medium').val() || null,
                campaign: $('#utm_campaign').val() || null,
                campaign_id: $('#utm_campaign_id').val() || null,
                content: $('#utm_content').val() || null,
                adset_id: $('#utm_ad_set_id').val() || null,
                term: $('#utm_term').val() || null,
                ad_id: $('#utm_ad_id').val() || null
            },
            tracking: {
                ip_address: $('#ip_address').val() || null,
                user_agent: $('#user_agent').val() || null,
                from_url: $('#from_url').val() || null,
                clid: $('#clid').val() || null,
                trustedform_cert_url: $('input[name="xxTrustedFormCertUrl"]').val() || null,
                trustedform_token: $('input[name="xxTrustedFormToken"]').val() || null,
                trustedform_ping_url: $('input[name="xxTrustedFormPingUrl"]').val() || null
            },
            answers: questions.map(function(q) {
                return {
                    key: q.name,
                    label: q.name,
                    value: q.answer
                };
            }),
            consent_statement: "By selecting 'Check my eligibility', you confirm you have read and accept Optimal Transnational's Privacy Policy and Terms of Use, and you consent to Optimal Transnational or one of our partner installers contacting you about solar and battery options."
        };
        
        console.log('[Optimal Transnational] Payload:', JSON.stringify(payload, null, 2));

        // Helper function to convert PascalCase to snake_case
        function toSnakeCase(str) {
            return str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
        }

        // Map question names to snake_case field names
        function getSnakeCaseFieldName(questionName) {
            var mapping = {
                'FirstName': 'first_name',
                'LastName': 'last_name',
                'EmailAddress': 'email_address',
                'PhoneNumber': 'phone_number',
                'Street': 'street_address',
                'City': 'suburb_city',
                'Postcode': 'postcode',
                'CustomerType': 'customer_type',
                'BusinessOwner': 'business_owner',
                'Homeowner': 'homeowner',
                'OwnOrLease': 'own_or_lease',
                'LengthOfLease': 'length_of_lease',
                'LiveInBuilding': 'live_in_building',
                'ProductType': 'product_type',
                'ExistingSolar': 'existing_solar',
                'ExistingSolarAge': 'existing_solar_age',
                'RoofType': 'roof_type',
                'HomeAge': 'home_age',
                'ShadingIssues': 'shading_issues',
                'BillSize': 'bill_size',
                'BillSizeCommercial': 'bill_size_commercial',
                'BusinessName': 'business_name'
            };
            return mapping[questionName] || toSnakeCase(questionName);
        }

        // ============================================================
        // STORE IN SESSIONSTORAGE (replaces URL parameters)
        // ============================================================
        var sessionData = {
            lead_type: leadType,
            first_name: $('#FirstName input').val(),
            last_name: $('#LastName input').val(),
            email_address: $('#EmailAddress input').val(),
            phone_number: srPhoneSubmitValue(),
            street_address: questions.find(function(q) { return q.name === 'Street'; })?.answer || '',
            suburb_city: $('#City input').val() || questions.find(function(q) { return q.name === 'City'; })?.answer || '',
            postcode: $('#Postcode input').val() || questions.find(function(q) { return q.name === 'Postcode'; })?.answer || '',
            business_name: $('#BusinessName input').val() || questions.find(function(q) { return q.name === 'BusinessName'; })?.answer || ''
        };

        // Add all form question answers with snake_case keys
        questions.forEach(function(q) {
            if (q.name && q.answer !== undefined && q.answer !== null && q.answer !== '') {
                var cleanAnswer = String(q.answer).replace(/<[^>]*>/g, '').trim();
                if (cleanAnswer) {
                    var snakeCaseKey = getSnakeCaseFieldName(q.name);
                    if (!sessionData.hasOwnProperty(snakeCaseKey)) {
                        sessionData[snakeCaseKey] = cleanAnswer;
                    }
                }
            }
        });

        // Store in sessionStorage for thank you page
        try {
            sessionStorage.setItem('optimaltransnational_lead_data', JSON.stringify(sessionData));
            console.log('[Optimal Transnational] Form data stored in sessionStorage:', sessionData);
        } catch (e) {
            console.error('[Optimal Transnational] Error storing in sessionStorage:', e);
        }

        // ============================================================
        // SUBMIT TO BACKEND
        // ============================================================
        var data = {
            action: 'submit-questions',
            questions: questions,
            code: verification_code,
            phone_number: srPhoneSubmitValue(),
            first_name: $('#FirstName input').val(),
            user_email: $('#FirstName input').val() + ' ' + $('#LastName input').val() + ' <' + $('#EmailAddress input').val() + '>',
            payload: JSON.stringify(payload),
            zapier_webhook_url: zapierWebhookUrl,
            zapier_secondary_webhooks: JSON.stringify(secondaryWebhooks)
        };

        // Clear all errors before ajax request
        $('.error-holder').html('');
        $.ajax({
            type: "POST",
            url: 'process.php',
            data: data,
            dataType: 'json',
            success: function (res) {
                console.log('[Optimal Transnational] Response:', res);
                if (res.is_error) {
                    $('#verify-code').removeAttr('disabled');
                    $('.question.active .error-holder').html('<i class="fa fa-warning"></i> ' + res.message).css('display', 'inline-block');
                    $('#resend-code').show();
                } else { // Success - redirect to thank you page
                    console.log('[Optimal Transnational] Success:', res);

                    // Hotjar: Track successful submission
                    trackHotjarEvent('sms_verified');
                    trackHotjarEvent('form_submitted');
                    hotjarTracking.submitted = true;

                    // Use thank you page URL from config lookup
                    // No query parameters - data is stored in sessionStorage
                    var cleanUrl = thankYouPageUrl.split('?')[0];
                    if (!cleanUrl.endsWith('/') && !cleanUrl.match(/\.(html|php)$/i)) {
                        cleanUrl += '/';
                    }

                    window.parent.postMessage({redirect: cleanUrl}, "*");
                    window.location.href = cleanUrl;
                }
            },
            error: function (error) {
                $('#verify-code').removeAttr('disabled');
                $('.question.active .error-holder').html('<i class="fa fa-warning"></i> There was some problem').css('display', 'inline-block');
            }
        });
    }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================
function convertAmount(amount) {
    if (amount != '') {
        if (typeof amount === 'number') {
            amount = amount + '';
        }
        amount = amount.replace(/[^0-9]/g, '');

        amount = amount.replace(/,/g, '');
        amount = parseInt(amount);
        amount = amount.toLocaleString();
    }
    return amount;
}

// ============================================================================
// NO-OTP SUBMISSION -> GOOGLE SHEET
// ----------------------------------------------------------------------------
// When SKIP_OTP_VERIFICATION is true, clicking Next on the phone-number step
// collects every answer, writes it to the Google Sheet web app, and redirects
// to the thank-you page. The SMS step (sendCode / verifyCode) is bypassed.
// Config lives in the <script> config block in index.html.
// ============================================================================

// Bump this in js/custom.js, js/maps-autocomplete.js and js/diagnostics.js
// TOGETHER. diagnostics.js compares all three, so a stamp left behind is
// reported as a half-uploaded js/ folder. `python3 bust-cache.py` checks it.
var SR_CUSTOM_BUILD = 'au-e164-sheet-crm-2026-09-19';

// ============================================================================
// PHONE VALIDATION MODE
// ----------------------------------------------------------------------------
// STRICT_PHONE_VALIDATION (index.html):
//   true  - must be a complete AU mobile, 04XX XXX XXX, enforced by the inputmask
//   false - accept any digits, any length; no mask is applied
// PHONE_MIN_DIGITS sets the floor in relaxed mode (default 1, i.e. not empty).
// ============================================================================

/**
 * Street address check.
 *   STRICT_ADDRESS_VALIDATION true  - must look like "12 Smith Street"
 *   STRICT_ADDRESS_VALIDATION false - accept any typed address of ADDRESS_MIN_CHARS+
 * Falls back to a non-empty test if maps-autocomplete.js did not load, so a
 * missing file can never freeze the address step.
 */
function srAddressOk(value) {
    var v = String(value || '').trim();

    var strict = (typeof STRICT_ADDRESS_VALIDATION === 'undefined')
        ? true : !!STRICT_ADDRESS_VALIDATION;

    if (!strict) {
        var min = (typeof ADDRESS_MIN_CHARS === 'undefined') ? 3 : ADDRESS_MIN_CHARS;
        return v.length >= min;
    }

    if (typeof validateStress === 'function') {
        return validateStress(v);
    }
    return v.length > 0;
}

function srStrictAddress() {
    return (typeof STRICT_ADDRESS_VALIDATION === 'undefined') ? true : !!STRICT_ADDRESS_VALIDATION;
}
function srCfgPostcodeMin() {
    return (typeof POSTCODE_MIN_LENGTH === 'undefined') ? 3 : POSTCODE_MIN_LENGTH;
}
function srCfgPostcodeMax() {
    return (typeof POSTCODE_MAX_LENGTH === 'undefined') ? 10 : POSTCODE_MAX_LENGTH;
}

// ============================================================================
// AUSTRALIAN PHONE NUMBER CHECK
// ----------------------------------------------------------------------------
// AU_PHONE_VALIDATION (index.html):
//   true  - the field wears a fixed "+61" chip with the Australian flag and
//           holds the national number after it:
//             mobile   4XX XXX XXX  (9 digits, starts 4)
//             landline X XXXX XXXX  (9 digits, starts 2 / 3 / 7 / 8)
//   false - fall back to the older digit-count / inputmask behaviour
// AU_PHONE_ALLOW_LANDLINE false narrows it to mobiles only.
//
// The country code is furniture rather than something the user types, so
// 0412 345 678, +61 412 345 678, 0061 412 345 678 and (04) 1234-5678 all
// collapse to the same national number and the +61 is added exactly once.
// Leads leave the page in E.164: +61412345678.
// ============================================================================

var AU_LANDLINE_AREA_CODES = ['02', '03', '07', '08'];

var AU_DIAL_CODE = '+61';

// An AU number is always 9 digits once the country code and trunk 0 are off.
// The field is held to this as you type, so a 10th digit cannot be entered.
var AU_NSN_DIGITS = 9;

function srAuPhoneEnabled() {
    return (typeof AU_PHONE_VALIDATION === 'undefined') ? true : !!AU_PHONE_VALIDATION;
}

function srAuAllowLandline() {
    return (typeof AU_PHONE_ALLOW_LANDLINE === 'undefined') ? true : !!AU_PHONE_ALLOW_LANDLINE;
}

/**
 * True when the phone fields wear the +61 chip, and therefore hold a national
 * number rather than the local 0-prefixed one. The inputmask in strict mode
 * owns the whole 10-digit local format, so the chip stays off there.
 */
function srAuPrefixMode() {
    return srAuPhoneEnabled() && !srStrictPhone();
}

/** The example number to quote in error messages, in whichever form is shown. */
function srAuPhoneExample() {
    return srAuPrefixMode() ? '412 345 678' : '0412 345 678';
}

/**
 * Reduce anything typed, pasted or autofilled to the national significant
 * number — the digits after +61, with no trunk zero.
 *   +61 412 345 678  -> 412345678
 *   0061 2 9876 5432 -> 298765432
 *   0412 345 678     -> 412345678
 *   (04) 1234-5678   -> 412345678
 *
 * Only ever strips from the front, which is what lets the caret be put back
 * accurately afterwards. A leading "61" is taken as the country code when it
 * is spelled out with a "+" or when the whole thing is the 11-digit
 * international form; at any other length it is left alone, because mid-typing
 * it cannot be told apart from a number that is simply unfinished.
 */
function srAuNsnDigits(raw) {
    var value = String(raw || '').trim();
    var d = value.replace(/[^0-9]/g, '');

    if (d.indexOf('0061') === 0) {
        d = d.slice(4);
    } else if (d.indexOf('61') === 0 && (value.charAt(0) === '+' || d.length === 11)) {
        d = d.slice(2);
    }

    // Trunk zero — dropped because the +61 in front of the field replaces it.
    if (d.charAt(0) === '0') {
        d = d.slice(1);
    }
    return d;
}

/** Local 0-prefixed digits, for anything that still thinks in that form. */
function srNormaliseAuPhone(raw) {
    var nsn = srAuNsnDigits(raw);
    return nsn ? '0' + nsn : '';
}

/** 412345678 -> "412 345 678". Partial input is grouped as far as it goes. */
function srFormatAuNsn(digits) {
    var d = String(digits || '');
    if (d.length <= 3) return d;
    if (d.length <= 6) return d.slice(0, 3) + ' ' + d.slice(3);
    return d.slice(0, 3) + ' ' + d.slice(3, 6) + ' ' + d.slice(6);
}

/** The offset in `text` just past its `count`-th digit. */
function srCaretAfterDigits(text, count) {
    if (count <= 0) return 0;
    var seen = 0;
    for (var i = 0; i < text.length; i++) {
        var c = text.charAt(i);
        if (c >= '0' && c <= '9') {
            seen++;
            if (seen === count) return i + 1;
        }
    }
    return text.length;
}

/** The shape every phone check returns, so callers never re-derive a format. */
function srAuPhoneResult(ok, code, message, nsn) {
    var complete = nsn.length === AU_NSN_DIGITS;
    return {
        ok: ok,
        code: code,
        message: message,
        nsn: nsn,
        normalised: nsn ? '0' + nsn : '',                // 0412345678
        e164: complete ? AU_DIAL_CODE + nsn : '',        // +61412345678
        display: srAuPrefixMode()                        // what belongs in the field
            ? srFormatAuNsn(nsn)
            : (nsn ? '0' + nsn : '')
    };
}

/**
 * Returns { ok, code, message, nsn, normalised, e164, display }. `code` is one
 * of empty | chars | length | area, so callers can tell a blank field from a
 * wrong one.
 */
function srAuPhoneCheck(raw) {
    var value = String(raw || '').trim();
    var eg = srAuPhoneExample();

    if (!value) {
        return srAuPhoneResult(false, 'empty', 'Please enter your mobile number', '');
    }
    // '_' is allowed through so a half-filled inputmask reports a length
    // problem rather than "numbers only".
    if (/[^0-9\s()+\-._]/.test(value)) {
        return srAuPhoneResult(false, 'chars', 'Please enter numbers only, e.g. ' + eg, '');
    }

    var nsn = srAuNsnDigits(value);

    if (nsn.length !== AU_NSN_DIGITS) {
        return srAuPhoneResult(false, 'length', srAuPrefixMode()
            ? 'Australian numbers are 9 digits after +61, e.g. ' + eg
            : 'Australian numbers are 10 digits, e.g. ' + eg, nsn);
    }

    var area = '0' + nsn.charAt(0);

    if (area === '04') {
        return srAuPhoneResult(true, 'mobile', '', nsn);
    }
    if (srAuAllowLandline() && AU_LANDLINE_AREA_CODES.indexOf(area) !== -1) {
        return srAuPhoneResult(true, 'landline', '', nsn);
    }

    return srAuPhoneResult(false, 'area', srAuAllowLandline()
        ? (srAuPrefixMode()
            ? 'Please enter an Australian mobile (4…) or landline (2, 3, 7 or 8) number'
            : 'Please enter an Australian mobile (04…) or landline (02, 03, 07 or 08)')
        : 'Please enter an Australian mobile number, e.g. ' + eg, nsn);
}

/** The message to show for whatever is currently in the phone field. */
function srPhoneError() {
    var $phone = $('#PhoneNumber input');
    if (!$phone.length) return '';

    if (srAuPhoneEnabled()) {
        return srAuPhoneCheck($phone.val()).message;
    }
    return 'Please enter a valid mobile number';
}

/**
 * Wrap a phone input in the +61 chip: the Australian flag and the dial code,
 * fixed to the left of the field. The country code stops being something the
 * user can forget, mistype or double up on, which is the whole point — what
 * they see in front of the number and what we store can no longer disagree.
 */
function srMountAuPhonePrefix(selector, placeholder) {
    var $field = $(selector);
    if (!$field.length || $field.parent('.phone-intl').length) return;

    // No maxlength: it would silently chop a pasted "+61 412 345 678" before
    // srClampAuPhoneInput ever got to normalise it. Length is held below.
    $field
        .attr('inputmode', 'tel')
        .attr('placeholder', placeholder || '412 345 678')
        .removeAttr('data-phone')
        .wrap('<div class="phone-intl"></div>');

    var codeId = ($field.attr('id') || 'phone') + '-dial-code';

    $field.before(
        '<span class="phone-intl__prefix">'
        +   '<img class="phone-intl__flag" src="images/icons/flag-au.svg"'
        +       ' width="24" height="16" alt="Australia" loading="lazy" decoding="async">'
        +   '<span class="phone-intl__code" id="' + codeId + '">' + AU_DIAL_CODE + '</span>'
        + '</span>'
    );

    $field.attr('aria-describedby', codeId);
}

/**
 * Hold a phone field to the 9 national digits, whatever is typed, pasted or
 * autofilled, and group them as 4XX XXX XXX while the user types. A pasted
 * +61 / 0061 / 0-prefixed number is reduced first, so it still fits inside the
 * 9 rather than being chopped mid-number.
 */
function srClampAuPhoneInput(input) {
    var el = (input && input.jquery) ? input[0] : input;
    if (!el || !srAuPrefixMode()) return;

    var before = String(el.value || '');
    if (!before) return;

    var rawDigits = before.replace(/[^0-9]/g, '');
    var nsn       = srAuNsnDigits(before);
    var dropped   = rawDigits.length - nsn.length;   // the trunk 0 / country code
    var digits    = nsn.slice(0, AU_NSN_DIGITS);
    var after     = srFormatAuNsn(digits);

    if (after === before) return;

    // Keep the caret where the user was working instead of throwing it to the
    // end on every keystroke, which makes mid-number corrections impossible.
    var caret = null;
    try {
        caret = el.selectionStart;
    } catch (e) {
        caret = null;
    }

    el.value = after;

    if (caret !== null && caret < before.length) {
        var kept = before.slice(0, caret).replace(/[^0-9]/g, '').length - dropped;
        if (kept < 0) kept = 0;
        if (kept > digits.length) kept = digits.length;
        var pos = srCaretAfterDigits(after, kept);
        try { el.setSelectionRange(pos, pos); } catch (e) { /* not selectable */ }
    }
}

/**
 * Rewrite a field to the clean grouped form once it validates, so the sheet
 * and the thank-you page get one consistent format. Never runs while the
 * inputmask owns the field.
 */
function srTidyAuPhoneField(field) {
    var $phone = (field && $(field).length) ? $(field) : $('#PhoneNumber input');
    if (!$phone.length || !srAuPrefixMode()) return;

    var result = srAuPhoneCheck($phone.val());
    if (result.ok && result.display && result.display !== String($phone.val() || '').trim()) {
        $phone.val(result.display);
    }
}

/**
 * The number as it should leave the page: E.164, +61412345678. An incomplete
 * number still keeps its country code, so a half-filled optional field (the
 * landlord's) is never stored as a bare, country-less fragment.
 */
function srAuPhoneForSubmit(raw) {
    var typed = String(raw || '').replace(/\s/g, '');
    if (!typed || !srAuPhoneEnabled()) return typed;

    var result = srAuPhoneCheck(raw);
    if (result.e164) return result.e164;
    if (srAuPrefixMode() && result.nsn) return AU_DIAL_CODE + result.nsn;
    return typed;
}

/** The lead's own number, E.164, ready for the sheet. */
function srPhoneSubmitValue() {
    return srAuPhoneForSubmit($('#PhoneNumber input').val());
}

/** The same number written for a human to read back: +61 412 345 678. */
function srPhoneDisplayValue() {
    var raw = String($('#PhoneNumber input').val() || '');
    if (srAuPrefixMode()) {
        var nsn = srAuNsnDigits(raw);
        if (nsn) return AU_DIAL_CODE + ' ' + srFormatAuNsn(nsn);
    }
    return raw.replace(/\s/g, '');
}

function srStrictPhone() {
    return (typeof STRICT_PHONE_VALIDATION === 'undefined') ? true : !!STRICT_PHONE_VALIDATION;
}

function srPhoneOk() {
    var $phone = $('#PhoneNumber input');
    if (!$phone.length) return true;

    var raw = String($phone.val() || '');

    // Australian format check takes precedence over both legacy modes.
    if (srAuPhoneEnabled()) {
        return srAuPhoneCheck(raw).ok;
    }

    if (!srStrictPhone()) {
        var min = (typeof PHONE_MIN_DIGITS === 'undefined') ? 1 : PHONE_MIN_DIGITS;
        return raw.replace(/[^0-9]/g, '').length >= min;
    }

    // Strict mode. If the mask never initialised, fall back to a digit count
    // rather than throwing and blocking the whole form.
    try {
        return !!$phone.inputmask("isComplete");
    } catch (e) {
        return raw.replace(/[^0-9]/g, '').length >= 10;
    }
}
var SR_SUBMIT_IN_PROGRESS = false;

/* Config readers — values are declared in the config <script> block in index.html. */
function srCfgSheetUrl() {
    return (typeof GOOGLE_SHEET_WEBAPP_URL !== 'undefined' && GOOGLE_SHEET_WEBAPP_URL) ? GOOGLE_SHEET_WEBAPP_URL : '';
}
function srCfgSendToZapier() {
    return (typeof ALSO_SEND_TO_ZAPIER !== 'undefined') ? ALSO_SEND_TO_ZAPIER : false;
}
function srCfgTimeout() {
    return (typeof SHEET_SUBMIT_TIMEOUT_MS !== 'undefined') ? SHEET_SUBMIT_TIMEOUT_MS : 6000;
}
function srCfgFallbackThankYou() {
    return (typeof FALLBACK_THANK_YOU_URL !== 'undefined') ? FALLBACK_THANK_YOU_URL : '';
}
function srCfgStrictSubmit() {
    return (typeof SHEET_SUBMIT_STRICT === 'undefined') ? true : !!SHEET_SUBMIT_STRICT;
}
function esc_(str) {
    return String(str).replace(/[&<>]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
}
function srCfgLocalThankYou() {
    if (typeof USE_LOCAL_THANK_YOU !== 'undefined' && USE_LOCAL_THANK_YOU) {
        return (typeof LOCAL_THANK_YOU_URL !== 'undefined' && LOCAL_THANK_YOU_URL) ? LOCAL_THANK_YOU_URL : 'thanks.html';
    }
    return '';
}

function srToSnakeCase(str) {
    return str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
}

function srFieldName(questionName) {
    var mapping = {
        'FirstName': 'first_name',
        'LastName': 'last_name',
        'EmailAddress': 'email_address',
        'PhoneNumber': 'phone_number',
        'Street': 'street_address',
        'City': 'suburb_city',
        'Postcode': 'postcode',
        'CustomerType': 'customer_type',
        'BusinessOwner': 'business_owner',
        'Homeowner': 'homeowner',
        'OwnOrLease': 'own_or_lease',
        'LengthOfLease': 'length_of_lease',
        'LiveInBuilding': 'live_in_building',
        'ProductType': 'product_type',
        'ExistingSolar': 'existing_solar',
        'ExistingSolarAge': 'existing_solar_age',
        'RoofType': 'roof_type',
        'HomeAge': 'home_age',
        'ShadingIssues': 'shading_issues',
        'BillSize': 'bill_size',
        'BillSizeCommercial': 'bill_size_commercial',
        'BusinessName': 'business_name',
        'LandlordName': 'landlord_name',
        'LandlordPhone': 'landlord_phone'
    };
    return mapping[questionName] || srToSnakeCase(questionName);
}

function srAnswerFor(questions, name) {
    for (var i = 0; i < questions.length; i++) {
        if (questions[i].name === name) {
            return String(questions[i].answer || '').replace(/<[^>]*>/g, ' ').trim();
        }
    }
    return '';
}

function srDetectLeadType() {
    if ($('#Homeowner input:checked').val() === 'Rent') {
        return 'renter referral';
    }
    if ($('#CustomerType input:checked').val() === 'Commercial') {
        return 'commercial solar';
    }
    if ($('#ProductType input:checked').val() === 'Battery Only') {
        return 'battery';
    }
    return 'residential solar';
}

/** Flattens every answer + tracking field into one object, one column per key. */
function srBuildLeadData(questions, leadType) {
    var data = {
        submitted_at: new Date().toISOString(),
        event_id: $('#event_id').val() || (typeof generateEventId === 'function' ? generateEventId() : ''),
        lead_type: leadType,
        otp_verified: 'No (OTP skipped)',

        first_name: $('#FirstName input').val() || '',
        last_name: $('#LastName input').val() || '',
        email_address: $('#EmailAddress input').val() || '',
        phone_number: srPhoneSubmitValue(),

        street_address: $('#Street input').val() || srAnswerFor(questions, 'Street'),
        suburb_city: $('#City input').val() || srAnswerFor(questions, 'City'),
        postcode: $('#Postcode input').val() || srAnswerFor(questions, 'Postcode'),
        business_name: $('#BusinessName input').val() || srAnswerFor(questions, 'BusinessName'),

        landlord_name: $('#LandlordName-field').val() || '',
        landlord_phone: srAuPhoneForSubmit($('#LandlordPhone-field').val()),

        utm_source: $('#utm_source').val() || '',
        utm_medium: $('#utm_medium').val() || '',
        utm_campaign: $('#utm_campaign').val() || '',
        utm_campaign_id: $('#utm_campaign_id').val() || '',
        utm_content: $('#utm_content').val() || '',
        utm_term: $('#utm_term').val() || '',
        utm_ad_set_id: $('#utm_ad_set_id').val() || '',
        utm_ad_id: $('#utm_ad_id').val() || '',
        clid: $('#clid').val() || '',

        ip_address: $('#ip_address').val() || '',
        from_url: $('#from_url').val() || '',
        page_url: window.location.href,
        user_agent: navigator.userAgent
    };

    // Every remaining question answer, keyed snake_case. Never overwrites the above.
    questions.forEach(function (q) {
        if (!q.name || q.answer === undefined || q.answer === null || q.answer === '') return;
        var clean = String(q.answer).replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]*>/g, '').trim();
        if (!clean) return;
        var key = srFieldName(q.name);
        if (!data[key]) {
            data[key] = clean;
        }
    });

    return data;
}

/**
 * POSTs as text/plain so the browser skips the CORS preflight that Apps Script
 * can't answer. If the response is still blocked, sendBeacon delivers the row
 * anyway — the event_id de-dupe in Code.gs makes the double-send harmless.
 */
function srPostToSheet(data) {
    var url = srCfgSheetUrl();
    if (!url) {
        return Promise.reject(new Error('GOOGLE_SHEET_WEBAPP_URL is not set in index.html'));
    }

    var body = JSON.stringify(data);

    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: body
    })
    .then(function (res) { return res.text(); })
    .then(function (text) {
        var trimmed = String(text || '').trim();

        // A Google login page, or any HTML, means the row was not written.
        if (trimmed.charAt(0) !== '{') {
            console.error('[Sheet] Endpoint did not return JSON. First 300 chars:\n' + trimmed.slice(0, 300));
            return {
                ok: false,
                reason: /sign in|accounts\.google|serviceLogin/i.test(trimmed)
                    ? 'Google returned a sign-in page — the Apps Script deployment is not set to "Anyone"'
                    : 'The endpoint returned HTML instead of JSON — check the deployment URL'
            };
        }

        var res;
        try {
            res = JSON.parse(trimmed);
        } catch (e) {
            return { ok: false, reason: 'Could not parse the response: ' + trimmed.slice(0, 120) };
        }

        if (res.ok) {
            console.log('[Sheet] Row written:', res);
            return { ok: true, response: res };
        }
        console.error('[Sheet] Script reported an error:', res);
        return { ok: false, reason: res.error || 'The Apps Script reported an error' };
    })
    .catch(function (err) {
        console.warn('[Sheet] POST blocked, retrying over JSONP:', err);

        // JSONP is immune to CORS and, crucially, readable — so this either
        // succeeds outright or tells us precisely why not.
        return srJsonp(url, data).then(function (res) {
            if (res.ok) return res;

            console.error('[Sheet] JSONP also failed:', res.reason);
            srBeacon(url, body);
            srIframePost(url, data);
            return { ok: false, beacon: true, reason: res.reason };
        });
    });
}

/** Keeps a lead that failed to save, so the next page load can retry it. */
function srStashFailed(data) {
    try {
        var queue = JSON.parse(localStorage.getItem('sr_failed_leads') || '[]');
        queue.push(data);
        localStorage.setItem('sr_failed_leads', JSON.stringify(queue.slice(-20)));
        console.warn('[Sheet] Lead stashed for retry. Queue length:', queue.length);
    } catch (e) {
        console.error('[Sheet] Could not stash the lead:', e);
    }
}

/** Retries anything stashed by a previous failed submission. */
function srRetryFailed() {
    var queue;
    try {
        queue = JSON.parse(localStorage.getItem('sr_failed_leads') || '[]');
    } catch (e) { return; }
    if (!queue.length || !srCfgSheetUrl()) return;

    console.log('[Sheet] Retrying', queue.length, 'stashed lead(s).');
    var remaining = [];
    var pending = queue.length;

    queue.forEach(function (lead) {
        srPostToSheet(lead).then(function (res) {
            if (!res.ok) remaining.push(lead);
        }).catch(function () {
            remaining.push(lead);
        }).then(function () {
            if (--pending === 0) {
                try { localStorage.setItem('sr_failed_leads', JSON.stringify(remaining)); } catch (e) {}
                console.log('[Sheet] Retry finished.', remaining.length, 'still unsaved.');
            }
        });
    });
}

/**
 * JSONP transport. A <script> tag is exempt from CORS, and unlike a beacon or a
 * hidden form it returns a result we can read — so a failure here tells us
 * exactly what went wrong instead of leaving it ambiguous.
 */
function srJsonp(url, data) {
    return new Promise(function (resolve) {
        var cb = 'srcb_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        var script = document.createElement('script');
        var done = false;

        function cleanup() {
            try { delete window[cb]; } catch (e) { window[cb] = undefined; }
            if (script.parentNode) script.parentNode.removeChild(script);
        }

        var timer = setTimeout(function () {
            if (done) return;
            done = true; cleanup();
            resolve({ ok: false, reason: 'The endpoint did not answer within 12 seconds' });
        }, 12000);

        window[cb] = function (res) {
            if (done) return;
            done = true; clearTimeout(timer); cleanup();
            if (res && res.ok) {
                console.log('[Sheet] Row written via JSONP:', res);
                resolve({ ok: true, response: res });
            } else {
                resolve({ ok: false, reason: (res && res.error) || 'The Apps Script reported an error' });
            }
        };

        script.onerror = function () {
            if (done) return;
            done = true; clearTimeout(timer); cleanup();
            resolve({
                ok: false,
                reason: 'The endpoint refused the request. This is what a Google sign-in ' +
                        'redirect looks like — the deployment is not set to "Anyone".'
            });
        };

        // Keep the query string short; the long tracking fields aren't columns.
        var compact = {};
        Object.keys(data).forEach(function (k) {
            if (k === 'user_agent' || k === 'page_url' || k === 'from_url') return;
            if (data[k] !== '' && data[k] !== null && data[k] !== undefined) compact[k] = data[k];
        });

        script.src = url + (url.indexOf('?') === -1 ? '?' : '&') +
                     'callback=' + cb +
                     '&payload=' + encodeURIComponent(JSON.stringify(compact));
        document.head.appendChild(script);
    });
}

/**
 * Last-resort transport: a real form POST into a hidden iframe.
 * Cross-origin form submissions are not subject to CORS, so this delivers the
 * payload even when fetch is rejected. The reply can't be read, but Code.gs
 * accepts a form-encoded 'payload' field and de-dupes on event_id.
 */
function srIframePost(url, data) {
    try {
        var name = 'sr_post_' + Date.now();

        var iframe = document.createElement('iframe');
        iframe.name = name;
        iframe.style.display = 'none';
        document.body.appendChild(iframe);

        var form = document.createElement('form');
        form.action = url;
        form.method = 'POST';
        form.target = name;
        form.style.display = 'none';

        var field = document.createElement('input');
        field.type = 'hidden';
        field.name = 'payload';
        field.value = JSON.stringify(data);
        form.appendChild(field);

        document.body.appendChild(form);
        form.submit();
        console.log('[Sheet] Form-post fallback submitted.');

        setTimeout(function () {
            try { form.parentNode.removeChild(form); } catch (e) {}
            try { iframe.parentNode.removeChild(iframe); } catch (e) {}
        }, 20000);
    } catch (e) {
        console.error('[Sheet] Form-post fallback failed:', e);
    }
}

function srBeacon(url, body) {
    try {
        if (navigator.sendBeacon) {
            navigator.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=utf-8' }));
        } else {
            fetch(url, {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: body
            }).catch(function (e) { console.error('[Sheet] Beacon fallback failed:', e); });
        }
    } catch (e) {
        console.error('[Sheet] Beacon fallback failed:', e);
    }
}

/** Optional: keep the Zapier pipeline alive now that process.php no longer runs. */
function srPostToZapier(data, leadType) {
    if (!srCfgSendToZapier()) return;

    var config = (typeof LEAD_TYPE_CONFIG !== 'undefined')
        ? (LEAD_TYPE_CONFIG[leadType] || LEAD_TYPE_CONFIG[DEFAULT_LEAD_TYPE])
        : null;
    if (!config || !config.zapier_webhook_url) return;

    var targets = [config.zapier_webhook_url].concat(config.zapier_secondary_webhooks || []);
    targets.forEach(function (hook) {
        try {
            fetch(hook, {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
        } catch (e) {
            console.error('[Zapier] Failed:', hook, e);
        }
    });
}

function srShowStatus(message, isError) {
    var $holder = $('#sr-submit-status');
    if (!$holder.length) {
        $holder = $('<div id="sr-submit-status" style="margin-top:14px;font-size:16px;font-weight:600;"></div>');
        // Attach to whichever step is on screen. The renter branch submits from
        // #RenterNotice, so anchoring to the phone step would hide the message.
        var $host = $('#RenterNotice').hasClass('active')
            ? $('#RenterNotice .renter-notice')
            : $('#PhoneNumber .answers-container');
        $host.append($holder);
    }
    // AGDS status colours: $AU-color-error / $AU-color-success
    $holder.css('color', isError ? '#d60000' : '#0b996c').html(message).show();
}

function srRedirectToThankYou(leadType) {
    // A local thanks.html wins over the external URLs in LEAD_TYPE_CONFIG.
    var url = srCfgLocalThankYou();

    if (!url) {
        var config = (typeof LEAD_TYPE_CONFIG !== 'undefined')
            ? (LEAD_TYPE_CONFIG[leadType] || LEAD_TYPE_CONFIG[DEFAULT_LEAD_TYPE])
            : null;
        url = (config && config.thank_you_page_url) ? config.thank_you_page_url : srCfgFallbackThankYou();
    }
    if (!url) {
        srShowStatus('Thanks! Your details have been received.', false);
        return;
    }

    var cleanUrl = url.split('?')[0];
    if (!cleanUrl.endsWith('/') && !cleanUrl.match(/\.(html|php)$/i)) {
        cleanUrl += '/';
    }

    window.parent.postMessage({ redirect: cleanUrl }, '*');
    window.location.href = cleanUrl;
}

/** Entry point — called from the #next-question handler on the phone step. */
function srSubmitWithoutOtp() {
    if (SR_SUBMIT_IN_PROGRESS) return;

    var results = calculateProgress();

    // Same completeness guard the OTP path used
    if ((results.total_questions - 1) > results.q_answered) {
        $('#next-question').removeClass('d-none');
        $('.question.active .error-holder')
            .html('<i class="fa fa-warning"></i> Please answer all questions')
            .css('display', 'inline-block');
        return;
    }

    SR_SUBMIT_IN_PROGRESS = true;
    $('.error-holder').html('').hide();
    srShowStatus('Submitting your details, please wait…', false);

    var leadType = srDetectLeadType();
    var data = srBuildLeadData(results.questions, leadType);

    console.log('[Sheet] Lead type:', leadType);
    console.log('[Sheet] Payload:', data);

    // Thank-you page reads this
    try {
        sessionStorage.setItem('optimaltransnational_lead_data', JSON.stringify(data));
    } catch (e) {
        console.error('[Sheet] sessionStorage write failed:', e);
    }

    trackHotjarEvent('form_submitted');
    hotjarTracking.submitted = true;

    srPostToZapier(data, leadType);

    // Redirect once the sheet confirms, or after the timeout — whichever is first.
    // The beacon backup + event_id de-dupe cover the slow case.
    var timeoutMs = srCfgTimeout();
    var settled = false;

    var finish = function () {
        if (settled) return;
        settled = true;
        srRedirectToThankYou(leadType);
    };

    srPostToSheet(data)
        .then(function (res) {
            if (res.ok || !srCfgStrictSubmit()) {
                if (!res.ok) {
                    srStashFailed(data);
                    console.error('[Sheet] Not saved, continuing anyway: ' + res.reason);
                }
                finish();
                return;
            }

            // Strict mode: surface the failure rather than showing a thank-you
            // page for a lead that never reached the sheet.
            srStashFailed(data);
            settled = true;
            SR_SUBMIT_IN_PROGRESS = false;
            $('#next-question').removeClass('d-none');
            srShowStatus('<i class="fa fa-warning"></i> Not saved to the sheet.<br>' +
                         esc_(res.reason) + '<br><span style="font-weight:400;font-size:14px;">' +
                         'The details are held locally and will be retried on the next page load.</span>', true);
        })
        .catch(function (err) {
            console.error('[Sheet] Submit failed:', err);
            srStashFailed(data);
            SR_SUBMIT_IN_PROGRESS = false;
            settled = true;
            $('#next-question').removeClass('d-none');
            srShowStatus('<i class="fa fa-warning"></i> ' + esc_(err && err.message ? err.message : String(err)), true);
        });

    setTimeout(function () {
        if (!settled) {
            srBeacon(srCfgSheetUrl(), JSON.stringify(data));
            finish();
        }
    }, timeoutMs);
}

// Retry any lead that failed to save on a previous visit.
$(document).ready(function () { srRetryFailed(); });
