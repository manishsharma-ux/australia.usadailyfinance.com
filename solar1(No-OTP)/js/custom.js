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

/**
 * Proof from the server that this number answered an SMS. Minted by the Apps
 * Script when Twilio approves the code, and required by it before a lead
 * carrying a phone number is written to the sheet. Cleared whenever the number
 * is edited, so a token can never outlive the number it was issued for.
 */
var SR_OTP_TOKEN = '';
var SR_OTP_IN_FLIGHT = false;
var SR_OTP_RESEND_TIMER = null;

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
            .attr('placeholder', srAuPhoneEnabled() ? srCountry().eg : 'Your phone number');
    }

    if (srAuPrefixMode()) {
        // The dial-code chip goes on before the first keystroke, so the country
        // code is never something the lead has to remember to type.
        srMountAuPhonePrefix('#PhoneNumber-field', srCountry().eg);
        srMountAuPhonePrefix('#LandlordPhone-field', srCountry().eg);

        // Both pickers move together: two numbers from the same household, so
        // letting them disagree would be a way to get it wrong, not a feature.
        $(document).on('change', '.phone-intl__country', function () {
            srSetCountry($(this).val());
        });

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

    /**
     * A token belongs to one number, so editing the number throws it away.
     *
     * On input rather than on blur: pressing Enter in the field runs the step
     * walk without ever blurring it, and a verification left standing through
     * that lands the visitor on the code step for a number no code was sent
     * to. Clearing is_phone_verified here is what makes the walk stop and ask
     * for a new one.
     */
    $('#PhoneNumber input').on('input', function () {
        if (!SR_OTP_TOKEN && !is_phone_verified) return;
        SR_OTP_TOKEN = '';
        is_phone_verified = false;
        console.log('[OTP] Number edited — the previous verification no longer applies.');
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
    var data = srBuildLeadData(results.questions, leadType, '');

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

// ============================================================================
// SMS VERIFICATION — TWILIO VERIFY, VIA THE APPS SCRIPT ENDPOINT
// ----------------------------------------------------------------------------
// The browser never sees a Twilio credential. It posts {action:'send-code'}
// and {action:'verify-code'} to the same Apps Script web app that writes the
// sheet, and that script holds the account SID and auth token in its Script
// Properties. See google-apps-script/Code.gs and TWILIO-OTP-SETUP.md.
//
// Turned off by SKIP_OTP_VERIFICATION in index.html, which sends the lead
// straight to the sheet from the phone step instead.
// ============================================================================

/** The OTP endpoint. Defaults to the sheet web app — they are one deployment. */
function srCfgOtpEndpoint() {
    if (typeof OTP_ENDPOINT_URL !== 'undefined' && OTP_ENDPOINT_URL) return OTP_ENDPOINT_URL;
    return srCfgSheetUrl();
}

/** Seconds before "Resend code" becomes clickable. The server enforces its own. */
function srCfgOtpResendSeconds() {
    return (typeof OTP_RESEND_COOLDOWN_SECONDS === 'undefined') ? 30 : OTP_RESEND_COOLDOWN_SECONDS;
}

function srOtpEnabled() {
    return !(typeof SKIP_OTP_VERIFICATION !== 'undefined' && SKIP_OTP_VERIFICATION);
}

/**
 * One logical request to the Apps Script endpoint, returning what it answered.
 *
 * Both transports are fired AT ONCE and the first readable reply wins:
 *
 *   fetch  — POST, carries the full payload, but Apps Script answers through
 *            a redirect the browser often refuses to let the page read. When
 *            that happens fetch fails only AFTER the server has finished, so
 *            waiting for it before trying anything else cost a whole trip.
 *   JSONP  — GET via a <script> tag, immune to CORS, always readable, but
 *            slow on an Apps Script cold start.
 *
 * Running them in parallel means the page waits for one server execution,
 * not two. Both carry the same request_id, and the script is idempotent on
 * it, so the loser is answered from cache and Twilio is never asked twice.
 */
function srOtpRequest(data, timeoutMs, jsonpDelayMs) {
    var url = srCfgOtpEndpoint();
    if (!url) {
        return Promise.resolve({
            ok: false,
            code: 'not_configured',
            error: 'The verification endpoint is not set. Add GOOGLE_SHEET_WEBAPP_URL to index.html.'
        });
    }

    var waitMs  = Number(timeoutMs) || 45000;
    var payload = $.extend({}, data, { request_id: data.request_id || srRequestId() });

    var viaFetch = new Promise(function (resolve) {
        var timer = setTimeout(function () {
            resolve({ transport: 'fetch', ok: false, error: 'fetch timed out' });
        }, waitMs);

        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        })
        .then(function (res) { return res.text(); })
        .then(function (text) {
            var trimmed = String(text || '').trim();
            if (trimmed.charAt(0) !== '{') {
                throw new Error(/sign in|accounts\.google|serviceLogin/i.test(trimmed)
                    ? 'Google returned a sign-in page — the Apps Script deployment is not set to "Anyone".'
                    : 'The endpoint returned HTML instead of JSON — check the deployment URL.');
            }
            clearTimeout(timer);
            resolve({ transport: 'fetch', ok: true, res: JSON.parse(trimmed) });
        })
        .catch(function (err) {
            clearTimeout(timer);
            resolve({ transport: 'fetch', ok: false, error: err && err.message ? err.message : String(err) });
        });
    });

    // For a check, the JSONP copy starts a beat later. The server already
    // refuses to ask Twilio twice about one code, but two copies that arrive
    // in the same instant still cost a lock wait; a short head start for
    // fetch means the second copy usually finds the answer already cached.
    var viaJsonp = new Promise(function (resolve) {
        setTimeout(resolve, Number(jsonpDelayMs) || 0);
    }).then(function () {
        return srJsonpRaw(url, payload, waitMs);
    }).then(function (res) {
        var transportFailure = res && (res.code === 'timeout' || res.code === 'blocked');
        return transportFailure
            ? { transport: 'jsonp', ok: false, error: res.error, res: res }
            : { transport: 'jsonp', ok: true, res: res };
    });

    return new Promise(function (resolve) {
        var settled = false;
        var failed  = [];

        function onResult(r) {
            if (settled) return;
            if (r.ok) {
                settled = true;
                console.log('[OTP] reply via ' + r.transport);
                resolve(r.res);
                return;
            }
            failed.push(r);
            if (failed.length === 2) {
                settled = true;
                console.error('[OTP] both transports failed:', failed);
                resolve({
                    ok: false,
                    code: 'unreachable',
                    error: 'Could not reach the verification service. ' + failed[1].error,
                    transports: failed
                });
            }
        }

        viaFetch.then(onResult);
        viaJsonp.then(onResult);
    });
}

/**
 * A per-call id the retry reuses. Random rather than sequential so two tabs
 * on the same page cannot collide and read each other's answers.
 */
function srRequestId() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
}

/** Writes a message under the code box. Cleared by the next state change. */
function srOtpMessage(html, isError) {
    var $holder = $('#final .error-holder');
    if (!$holder.length) return;

    // Classes rather than inline colour: the message sits in its own block
    // under the code box, and the stylesheet decides what a warning looks
    // like. Previously it was an inline scrap that shared a line with the
    // resend button and pushed the button off to the side.
    $holder
        .removeClass('is-error is-ok')
        .addClass(html ? (isError ? 'is-error' : 'is-ok') : '')
        .css('color', '')
        .html(html || '')
        .css('display', html ? 'block' : 'none');
}

/**
 * Counts the resend button down rather than hiding it.
 *
 * A button that is simply absent reads as "there is no way to get another
 * code", which is the moment a visitor with a slow carrier gives up. A visible
 * countdown says the opposite: one is coming, and here is when you may ask.
 */
function srStartResendCountdown(seconds) {
    var $button = $('#resend-code');
    if (!$button.length) return;

    var left = Math.max(0, Number(seconds) || 0);
    clearInterval(SR_OTP_RESEND_TIMER);

    $button.show().removeClass('d-none');

    var tick = function () {
        if (left <= 0) {
            clearInterval(SR_OTP_RESEND_TIMER);
            SR_OTP_RESEND_TIMER = null;
            $button.removeAttr('disabled').text('Resend code');
            return;
        }
        $button.attr('disabled', 'disabled').text('Resend code (' + left + 's)');
        left--;
    };

    tick();
    SR_OTP_RESEND_TIMER = setInterval(tick, 1000);
}

/**
 * Sends a code to the number on the phone step — and moves the visitor on
 * to the code step AT ONCE, without waiting for the server to answer.
 *
 * The reply cannot change what the visitor should do next, which is look at
 * their phone. Waiting for it only added the server's round trip (several
 * seconds on an Apps Script cold start) to a step that felt frozen. So the
 * form advances first; the reply, when it lands, updates the status line
 * under the code box — "sent", or the one error worth acting on.
 *
 * Called three ways: by Next on the phone step, by the Enter-key handler, and
 * by the resend button. Only the first two advance the form.
 */
function sendCode(isResend) {
    if (SR_OTP_IN_FLIGHT || SR_SUBMIT_IN_PROGRESS) return;

    if (!srPhoneOk()) {
        $('#next-question').removeClass('d-none');
        $('#PhoneNumber .error-holder')
            .html('<i class="fa fa-warning"></i> ' + srPhoneError())
            .css('display', 'inline-block');
        return;
    }

    var phone   = srPhoneSubmitValue();
    var display = esc_(srPhoneDisplayValue());
    SR_OTP_IN_FLIGHT = true;

    if (isResend) {
        srOtpMessage('Sending a new code…', false);
    } else {
        $('#PhoneNumber .error-holder').html('').hide();
        srShowStatus('', false);
        $('#sr-submit-status').hide();

        // Deferred one tick: this runs inside the Next click handler, and
        // srAdvanceToCodeStep clicks Next again to walk the form forward.
        setTimeout(function () {
            srAdvanceToCodeStep();
            srOtpMessage('Sending your code to ' + display + '…', false);
            srStartResendCountdown(srCfgOtpResendSeconds());
        }, 0);
    }

    srOtpRequest({
        action: 'send-code',
        phone_number: phone,
        // A resend asks the server to cancel the pending code first. Twilio
        // otherwise re-sends the SAME six digits until the old one dies.
        resend: !!isResend,
        event_id: $('#event_id').val() || ''
    }, 45000)
    .then(function (res) {
        SR_OTP_IN_FLIGHT = false;
        console.log('[OTP] send-code:', res);

        // Sent — or a cooldown, which means the same thing: the server had
        // just sent one to this number, and the phone is buzzing either way.
        if (res && (res.ok || res.code === 'cooldown')) {
            srOtpMessage((isResend ? 'A new code is on its way to ' : 'Code sent to ') + display +
                         '. It can take up to a minute to arrive.', false);
            if (isResend) $('#verification-code').val('').focus();
            srStartResendCountdown((res && res.cooldown) || srCfgOtpResendSeconds());
            return;
        }

        // No readable reply at all. The SMS almost certainly still went — the
        // server runs even when the browser cannot read what it said.
        if (res && (res.code === 'unreachable' || res.code === 'timeout' || res.code === 'blocked')) {
            console.warn('[OTP] send-code reply unreadable; assuming the SMS went:', res.error);
            srOtpMessage('Your code should arrive shortly. Not there after a minute? Press Resend.', false);
            return;
        }

        srOtpSendFailed(res, isResend);
    })
    .catch(function (err) {
        SR_OTP_IN_FLIGHT = false;
        console.error('[OTP] send-code threw:', err);
        srOtpMessage('Your code should arrive shortly. Not there after a minute? Press Resend.', false);
    });
}

/** Called by the resend button in index.html. */
function resendCode() {
    sendCode(true);
}

/**
 * A code request the server actually refused: the number is not a mobile,
 * Twilio rejected it, or the endpoint has no credentials. The form is already
 * on the code step, so the message goes under the code box, with the resend
 * button live and Back available to change the number.
 *
 * Nothing is written to the sheet here, on purpose. The number is the only
 * thing this step has collected and it is the one field that failed.
 */
function srOtpSendFailed(res, isResend) {
    var message = (res && res.error) || 'We could not send a code to that number. Please check it and try again.';
    var reason  = res && res.code;

    if (reason === 'not_configured') {
        console.error('[OTP] The endpoint has no Twilio credentials: ' + message);
        message = 'Verification is unavailable right now. Please try again shortly.';
    }

    srOtpMessage('<i class="fa fa-warning"></i> ' + esc_(message) +
                 (reason === 'bad_number' || (res && res.twilio_code === 60200 || res.twilio_code === 60205)
                     ? ' <a href="#" onclick="$(\'#prev-question\').click(); return false;">Change number</a>'
                     : ''), true);

    clearInterval(SR_OTP_RESEND_TIMER);
    SR_OTP_RESEND_TIMER = null;
    $('#resend-code').show().removeClass('d-none').removeAttr('disabled').text('Send a new code');
}

/**
 * Moves the form from the phone step to the code step.
 *
 * The step walk in the #next-question handler diverts to sendCode() whenever
 * the phone is unverified, so is_phone_verified is lifted for the length of
 * that one click to let the walk run its normal course.
 */
function srAdvanceToCodeStep() {
    $('#entered_phone_number').html(esc_(srPhoneDisplayValue()));

    is_phone_verified = true;
    $('#next-question').click();
    is_phone_verified = false;

    $('#verification-code').val('').focus();
    $('#verify-code').attr('disabled', 'disabled');
}

/**
 * The form's real submit: checks the code AND writes the lead in ONE call.
 *
 * The previous design made two trips — verify, receive a token, then post
 * the lead with the token. Anything that went wrong between them (a blocked
 * reply, a stale deployment, a cache miss) lost a lead the visitor had just
 * proven was real. Now the six digits travel with the whole lead, the script
 * checks them and appends the row in the same execution, and the browser is
 * told once: written, or what to fix.
 *
 * A wrong code comes back as "incorrect" and nothing is written. Anything
 * that is Twilio's fault rather than the visitor's is written anyway, marked
 * unverified in the sheet's "Phone verified" column (Code.gs: OTP_FAIL_OPEN).
 */
function verifyCode() {
    // Deliberately NOT gated on SR_OTP_IN_FLIGHT: the form now reaches this
    // step before the send-code reply lands, and the visitor may well have the
    // code typed in before it does. The two calls are independent.
    if (SR_SUBMIT_IN_PROGRESS) return;

    var code = getVerificationCode();
    if (code.length !== 6) {
        srOtpMessage('<i class="fa fa-warning"></i> Please enter the 6-digit code from the text message.', true);
        return;
    }

    var results = calculateProgress();
    if ((results.total_questions - 1) > results.q_answered) {
        srOtpMessage('<i class="fa fa-warning"></i> Please answer all questions', true);
        return;
    }

    SR_SUBMIT_IN_PROGRESS = true;
    $('#verify-code').attr('disabled', 'disabled');
    $('#resend-code').attr('disabled', 'disabled');
    srOtpMessage('<i class="fa fa-circle-o-notch fa-spin"></i> Checking your code…', false);

    var leadType = srDetectLeadType();
    var data     = srBuildLeadData(results.questions, leadType, '');

    // Thank-you page reads this
    try {
        sessionStorage.setItem('optimaltransnational_lead_data', JSON.stringify(data));
    } catch (e) {
        console.error('[Sheet] sessionStorage write failed:', e);
    }

    var payload = $.extend({}, data, {
        action: 'verify-and-submit',
        phone_number: srPhoneSubmitValue(),
        code: code,
        request_id: srRequestId()
    });

    console.log('[OTP] verify-and-submit payload:', payload);

    // The row is written by the server whether or not this page is still
    // open to hear about it: both transports have delivered the request to
    // Google the moment they are sent, and Apps Script runs to completion.
    // So the only question this step has to answer is "did the visitor type
    // the wrong code?" — and that answer arrives fast. Anything slower than
    // SUBMIT_REDIRECT_AFTER_MS is treated as done: the payload is kept for a
    // retry (idempotent on the server) and the visitor goes to the results.
    var settled = false;

    var goToResults = function (why) {
        if (settled) return;
        settled = true;
        console.log('[OTP] redirecting: ' + why);
        is_phone_verified = true;
        trackHotjarEvent('sms_verified');
        trackHotjarEvent('form_submitted');
        hotjarTracking.submitted = true;
        srPostToZapier(data, leadType);
        srRedirectToThankYou(leadType);
    };

    var stayAndFix = function (res) {
        if (settled) return;
        settled = true;
        SR_SUBMIT_IN_PROGRESS = false;
        $('#resend-code').removeAttr('disabled');
        srOtpVerifyFailed(res);
    };

    var deadline = setTimeout(function () {
        if (settled) return;
        srStashFailed(payload);
        goToResults('no reply within ' + srCfgSubmitRedirectMs() + 'ms; server finishes on its own');
    }, srCfgSubmitRedirectMs());

    srOtpRequest(payload, 45000, 800)
    .then(function (res) {
        clearTimeout(deadline);
        console.log('[OTP] verify-and-submit:', res);

        // Written — verified or fail-open — or already written by a twin copy.
        if (res && res.ok && (res.written || res.duplicate)) {
            goToResults(res.verified ? 'verified and written' : 'written unverified (fail-open)');
            return;
        }

        // Verified but the sheet itself refused (quota, tab renamed). The
        // visitor did nothing wrong: keep the lead for retry, thank them.
        if (res && res.ok && res.verified) {
            console.error('[Sheet] Verified but not written: ' + (res.write_error || 'unknown'));
            srStashFailed(payload);
            goToResults('verified, write failed, stashed');
            return;
        }

        // The visitor's to fix. These are the only replies that keep them here.
        if (res && (res.code === 'incorrect' || res.code === 'rate_limited' ||
                    res.code === 'bad_code'  || res.code === 'bad_number')) {
            stayAndFix(res);
            return;
        }

        // Anything else — transport failure, Twilio outage, unreadable reply —
        // is not the visitor's problem and is never shown to them. The server
        // writes the lead fail-open; the stash covers the case where the
        // request never left the browser at all.
        console.warn('[OTP] non-visitor failure, redirecting anyway:', res);
        srStashFailed(payload);
        goToResults('non-visitor failure: ' + (res && res.code));
    })
    .catch(function (err) {
        clearTimeout(deadline);
        console.error('[OTP] verify-and-submit threw:', err);
        srStashFailed(payload);
        goToResults('exception: ' + (err && err.message ? err.message : String(err)));
    });
}

/**
 * How long the code step waits for the server before sending the visitor on
 * regardless. Long enough for a wrong code to come back on a warm server
 * (2–5s), short enough that nobody stares at a spinner on a cold one.
 */
function srCfgSubmitRedirectMs() {
    return (typeof SUBMIT_REDIRECT_AFTER_MS !== 'undefined') ? Number(SUBMIT_REDIRECT_AFTER_MS) : 10000;
}

/** A code that was wrong, stale, or never reached Twilio. */
function srOtpVerifyFailed(res) {
    var message = (res && res.error) || 'We could not check that code. Please try again.';
    var reason  = res && res.code;

    if (reason === 'not_configured') {
        console.error('[OTP] The endpoint has no Twilio credentials: ' + message);
        message = 'Verification is unavailable right now. Please try again shortly.';
    }

    srOtpMessage('<i class="fa fa-warning"></i> ' + esc_(message), true);

    // Expired or exhausted: the only way forward is a new code, so the
    // countdown is dropped rather than made to run out first, and the box is
    // emptied — leaving the dead digits in it invites the same failed click.
    if (reason === 'expired' || reason === 'rate_limited') {
        clearInterval(SR_OTP_RESEND_TIMER);
        SR_OTP_RESEND_TIMER = null;
        $('#resend-code').show().removeClass('d-none').removeAttr('disabled').text('Send a new code');
        $('#verification-code').val('').focus();
        $('#verify-code').attr('disabled', 'disabled');
        return;
    }

    // A wrong or unreadable code: the digits stay, selected, so a correction
    // is one keystroke rather than six.
    $('#verify-code').removeAttr('disabled');
    $('#verification-code').select().focus();
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
var SR_CUSTOM_BUILD = 'otp-crm-2026-09-22';

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
// PHONE NUMBER CHECK
// ----------------------------------------------------------------------------
// AU_PHONE_VALIDATION (index.html):
//   true  - the field wears a country chip holding the dial code, and the
//           input after it holds the national number only.
//   false - fall back to the older digit-count / inputmask behaviour
// AU_PHONE_ALLOW_LANDLINE false narrows it to mobiles only.
//
// PHONE_COUNTRIES (index.html) decides which countries the chip offers:
//   ['AU']                     one country, a fixed chip with the flag — the
//                              production setting, and what visitors see
//   ['AU','IN','US','AE']      the chip becomes a picker, for testing SMS
//                              delivery to more than one country
//
// The dial code is furniture rather than something the user types, so
// 0412 345 678, +61 412 345 678, 0061 412 345 678 and (04) 1234-5678 all
// collapse to the same national number and the +61 is added exactly once.
// Leads leave the page in E.164: +61412345678.
// ============================================================================

/**
 * What each country needs for the field to behave like a local one.
 *
 *   dial     E.164 prefix, written the way it is shown
 *   nsn      digits in the national number, once the dial code and any trunk
 *            zero are off — this is what the field is held to
 *   trunk    true when a local number carries a leading 0 that E.164 drops
 *   groups   how the national number is spaced while typing
 *   mobile   which national numbers are mobiles — the only ones that can
 *            receive a code
 *   landline accepted as well when AU_PHONE_ALLOW_LANDLINE is true; null when
 *            the country has no separate rule worth stating
 *   eg       the example quoted in error messages and the placeholder
 *   flag     optional; the ISO code is shown when there is no flag asset
 */
var SR_COUNTRIES = {
    AU: {
        iso: 'AU', name: 'Australia', adj: 'Australian', article: 'an', dial: '+61',
        nsn: 9, trunk: true, groups: [3, 3, 3],
        mobile: /^4/, landline: /^[2378]/,
        eg: '412 345 678', flag: 'images/icons/flag-au.svg'
    },
    IN: {
        iso: 'IN', name: 'India', adj: 'Indian', article: 'an', dial: '+91',
        nsn: 10, trunk: true, groups: [5, 5],
        mobile: /^[6-9]/, landline: null,
        eg: '98765 43210'
    },
    US: {
        iso: 'US', name: 'United States', adj: 'US', article: 'a', dial: '+1',
        nsn: 10, trunk: false, groups: [3, 3, 4],
        mobile: /^[2-9]/, landline: /^[2-9]/,
        eg: '415 555 0123'
    },
    AE: {
        iso: 'AE', name: 'United Arab Emirates', adj: 'UAE', article: 'a', dial: '+971',
        nsn: 9, trunk: true, groups: [2, 3, 4],
        mobile: /^5/, landline: /^[2-4679]/,
        eg: '50 123 4567'
    }
};

/**
 * The countries the chip offers, in the order given. Anything unknown is
 * dropped rather than thrown, so a typo in the config costs one country
 * instead of the whole form, and an empty list falls back to Australia.
 */
function srCountryList() {
    var wanted = (typeof PHONE_COUNTRIES !== 'undefined' && PHONE_COUNTRIES && PHONE_COUNTRIES.length)
        ? PHONE_COUNTRIES
        : ['AU'];

    var list = [];
    for (var i = 0; i < wanted.length; i++) {
        var c = SR_COUNTRIES[String(wanted[i]).toUpperCase()];
        if (c && list.indexOf(c) === -1) list.push(c);
    }
    return list.length ? list : [SR_COUNTRIES.AU];
}

/**
 * One active country shared by the lead's field and the landlord's. They are
 * two numbers from the same household, so a picker on each that disagreed
 * would be a way to get it wrong rather than a feature.
 */
var SR_ACTIVE_COUNTRY = null;

function srCountry() {
    if (!SR_ACTIVE_COUNTRY) SR_ACTIVE_COUNTRY = srCountryList()[0];
    return SR_ACTIVE_COUNTRY;
}

/** Switches country, re-labels every field and re-formats what is in them. */
function srSetCountry(iso) {
    var next = SR_COUNTRIES[String(iso || '').toUpperCase()];
    if (!next || next === srCountry()) return;

    SR_ACTIVE_COUNTRY = next;

    $('.phone-intl__country').val(next.iso);
    $('.phone-intl__code').text(next.dial);
    $('#PhoneNumber input, #LandlordPhone-field').attr('placeholder', next.eg);

    // What was typed was a national number for the old country, and it stays
    // one — only the code in front of it changed. Re-clamping keeps it inside
    // the new country's length instead of leaving an over-long number that
    // silently fails at submit.
    $('#PhoneNumber input, #LandlordPhone-field').each(function () {
        srClampAuPhoneInput(this);
    });
}

function srAuPhoneEnabled() {
    return (typeof AU_PHONE_VALIDATION === 'undefined') ? true : !!AU_PHONE_VALIDATION;
}

function srAuAllowLandline() {
    return (typeof AU_PHONE_ALLOW_LANDLINE === 'undefined') ? true : !!AU_PHONE_ALLOW_LANDLINE;
}

/**
 * True when the phone fields wear the dial-code chip, and therefore hold a
 * national number rather than the local 0-prefixed one. The inputmask in
 * strict mode owns the whole 10-digit local format, so the chip stays off.
 */
function srAuPrefixMode() {
    return srAuPhoneEnabled() && !srStrictPhone();
}

/** The example number to quote in error messages, in whichever form is shown. */
function srAuPhoneExample() {
    var c = srCountry();
    if (srAuPrefixMode()) return c.eg;
    return c.trunk ? '0' + c.eg.replace(/\s/g, '') : c.eg;
}

/**
 * Reduce anything typed, pasted or autofilled to the national significant
 * number — the digits after the dial code, with no trunk zero.
 *   +61 412 345 678  -> 412345678
 *   0061 2 9876 5432 -> 298765432
 *   0412 345 678     -> 412345678
 *   +91 98765 43210  -> 9876543210
 *
 * Only ever strips from the front, which is what lets the caret be put back
 * accurately afterwards. A leading dial code is taken as such when it is
 * spelled out with a "+", written with the 00 prefix, or when the whole thing
 * is the full international length; at any other length it is left alone,
 * because mid-typing it cannot be told apart from a number simply unfinished.
 */
function srAuNsnDigits(raw) {
    var c     = srCountry();
    var value = String(raw || '').trim();
    var d     = value.replace(/[^0-9]/g, '');
    var dial  = c.dial.replace(/\D/g, '');

    if (d.indexOf('00' + dial) === 0) {
        d = d.slice(2 + dial.length);
    } else if (d.indexOf(dial) === 0 &&
               (value.charAt(0) === '+' || d.length === dial.length + c.nsn)) {
        d = d.slice(dial.length);
    }

    // Trunk zero — dropped because the dial code in front of the field
    // replaces it. Countries without one never carry it to begin with.
    if (c.trunk && d.charAt(0) === '0') {
        d = d.slice(1);
    }
    return d;
}

/** Local 0-prefixed digits, for anything that still thinks in that form. */
function srNormaliseAuPhone(raw) {
    var nsn = srAuNsnDigits(raw);
    if (!nsn) return '';
    return srCountry().trunk ? '0' + nsn : nsn;
}

/** Groups the national number the way the active country writes it. */
function srFormatAuNsn(digits) {
    var d = String(digits || '');
    if (!d) return '';

    var groups = srCountry().groups;
    var out = [];
    var i = 0;

    for (var g = 0; g < groups.length && i < d.length; g++) {
        out.push(d.substr(i, groups[g]));
        i += groups[g];
    }
    if (i < d.length) out.push(d.slice(i));

    return out.join(' ');
}

/** The offset in `text` just past its `count`-th digit. */
function srCaretAfterDigits(text, count) {
    if (count <= 0) return 0;
    var seen = 0;
    for (var i = 0; i < text.length; i++) {
        var ch = text.charAt(i);
        if (ch >= '0' && ch <= '9') {
            seen++;
            if (seen === count) return i + 1;
        }
    }
    return text.length;
}

/** The shape every phone check returns, so callers never re-derive a format. */
function srAuPhoneResult(ok, code, message, nsn) {
    var c = srCountry();
    var complete = nsn.length === c.nsn;
    var local = nsn ? (c.trunk ? '0' + nsn : nsn) : '';

    return {
        ok: ok,
        code: code,
        message: message,
        nsn: nsn,
        country: c.iso,
        normalised: local,                            // 0412345678
        e164: complete ? c.dial + nsn : '',           // +61412345678
        display: srAuPrefixMode()                     // what belongs in the field
            ? srFormatAuNsn(nsn)
            : local
    };
}

/**
 * Returns { ok, code, message, nsn, country, normalised, e164, display }.
 * `code` is one of empty | chars | length | area, so callers can tell a blank
 * field from a wrong one.
 */
function srAuPhoneCheck(raw) {
    var c     = srCountry();
    var value = String(raw || '').trim();
    var eg    = srAuPhoneExample();

    if (!value) {
        return srAuPhoneResult(false, 'empty', 'Please enter your mobile number', '');
    }
    // '_' is allowed through so a half-filled inputmask reports a length
    // problem rather than "numbers only".
    if (/[^0-9\s()+\-._]/.test(value)) {
        return srAuPhoneResult(false, 'chars', 'Please enter numbers only, e.g. ' + eg, '');
    }

    var nsn = srAuNsnDigits(value);

    if (nsn.length !== c.nsn) {
        return srAuPhoneResult(false, 'length',
            c.adj + ' numbers are ' + c.nsn + ' digits after ' + c.dial + ', e.g. ' + eg, nsn);
    }

    if (c.mobile.test(nsn)) {
        return srAuPhoneResult(true, 'mobile', '', nsn);
    }
    if (srAuAllowLandline() && c.landline && c.landline.test(nsn)) {
        return srAuPhoneResult(true, 'landline', '', nsn);
    }

    return srAuPhoneResult(false, 'area', srAuAllowLandline()
        ? 'Please enter ' + c.article + ' ' + c.adj + ' mobile or landline number, e.g. ' + eg
        : 'Please enter ' + c.article + ' ' + c.adj + ' mobile number, e.g. ' + eg, nsn);
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
 * Wrap a phone input in the dial-code chip. The country code stops being
 * something the user can forget, mistype or double up on, which is the whole
 * point — what they see in front of the number and what we store can no
 * longer disagree.
 *
 * With one country the chip is fixed furniture, as it has always been. With
 * several it becomes a picker, and the flag gives way to the ISO code so the
 * options stay legible on every platform.
 */
function srMountAuPhonePrefix(selector, placeholder) {
    var $field = $(selector);
    if (!$field.length || $field.parent('.phone-intl').length) return;

    var countries = srCountryList();
    var c         = srCountry();

    // No maxlength: it would silently chop a pasted "+61 412 345 678" before
    // srClampAuPhoneInput ever got to normalise it. Length is held below.
    $field
        .attr('inputmode', 'tel')
        .attr('placeholder', placeholder || c.eg)
        .removeAttr('data-phone')
        .wrap('<div class="phone-intl"></div>');

    var codeId = ($field.attr('id') || 'phone') + '-dial-code';

    if (countries.length > 1) {
        var options = '';
        for (var i = 0; i < countries.length; i++) {
            options += '<option value="' + countries[i].iso + '"'
                    + (countries[i] === c ? ' selected' : '') + '>'
                    + countries[i].iso + ' ' + countries[i].dial
                    + '</option>';
        }
        $field.before(
            '<span class="phone-intl__prefix phone-intl__prefix--picker">'
            +   '<select class="phone-intl__country" id="' + codeId + '"'
            +           ' aria-label="Country code">' + options + '</select>'
            + '</span>'
        );
    } else {
        $field.before(
            '<span class="phone-intl__prefix">'
            + (c.flag
                ? '<img class="phone-intl__flag" src="' + c.flag + '"'
                  + ' width="24" height="16" alt="' + c.name + '" loading="lazy" decoding="async">'
                : '<span class="phone-intl__iso">' + c.iso + '</span>')
            +   '<span class="phone-intl__code" id="' + codeId + '">' + c.dial + '</span>'
            + '</span>'
        );
    }

    $field.attr('aria-describedby', codeId);
}

/**
 * Hold a phone field to the active country's national length, whatever is
 * typed, pasted or autofilled, and group it as that country writes it. A
 * pasted international or 0-prefixed number is reduced first, so it still
 * fits inside the length rather than being chopped mid-number.
 */
function srClampAuPhoneInput(input) {
    var el = (input && input.jquery) ? input[0] : input;
    if (!el || !srAuPrefixMode()) return;

    var before = String(el.value || '');
    if (!before) return;

    var rawDigits = before.replace(/[^0-9]/g, '');
    var nsn       = srAuNsnDigits(before);
    var dropped   = rawDigits.length - nsn.length;   // the trunk 0 / dial code
    var digits    = nsn.slice(0, srCountry().nsn);
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
    if (srAuPrefixMode() && result.nsn) return srCountry().dial + result.nsn;
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
        if (nsn) return srCountry().dial + ' ' + srFormatAuNsn(nsn);
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

    // The country format check takes precedence over both legacy modes.
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

/**
 * What the sheet's verified column should say. The renter branch ends before
 * the phone step exists, so it gets a blank rather than a "No" that reads as a
 * failed verification for a number nobody ever asked for.
 */
function srOtpVerifiedLabel(otpToken) {
    if (!srOtpEnabled()) return 'No (OTP skipped)';
    if (otpToken) return 'Yes (SMS)';
    return srPhoneSubmitValue() ? 'No' : '';
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

/**
 * Flattens every answer + tracking field into one object, one column per key.
 *
 * otpToken is the same value that will be sent with the row, and the sheet's
 * verified column is derived from it here rather than from the global it was
 * stored in. One fact, read once: a column that says "Yes (SMS)" beside a row
 * the server rejected, or "No" beside one it accepted, is worse than no column.
 */
function srBuildLeadData(questions, leadType, otpToken) {
    var data = {
        submitted_at: new Date().toISOString(),
        event_id: $('#event_id').val() || (typeof generateEventId === 'function' ? generateEventId() : ''),
        lead_type: leadType,
        otp_verified: srOtpVerifiedLabel(otpToken),

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
            // A rejected token never becomes valid again — the verification it
            // stood for has expired — so retrying it forever would just keep a
            // dead lead in the queue. It is dropped and logged instead.
            if (!res.ok && /not been verified/i.test(res.reason || '')) {
                // An expired token never becomes valid again, so this would
                // fail on every page load forever. Logged in full rather than
                // just counted: it is a real lead, and the console is the only
                // place left to recover it from.
                console.warn('[Sheet] Dropping a stashed lead whose verification has expired. ' +
                             'Copy this if the lead matters:', JSON.stringify(lead));
                return;
            }
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
    return srJsonpRaw(url, data).then(function (res) {
        if (res && res.ok) {
            console.log('[Sheet] Row written via JSONP:', res);
            return { ok: true, response: res };
        }
        return { ok: false, reason: (res && res.error) || 'The Apps Script reported an error' };
    });
}

/**
 * The transport itself, resolving whatever the endpoint answered. Separate
 * from srJsonp because the OTP calls need the endpoint's own reply — its
 * `code` field is what tells an expired code apart from a wrong one.
 */
function srJsonpRaw(url, data, timeoutMs) {
    var waitMs = Number(timeoutMs) || 12000;
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
            resolve({ ok: false, code: 'timeout', error: 'The endpoint did not answer within ' + Math.round(waitMs / 1000) + ' seconds' });
        }, waitMs);

        window[cb] = function (res) {
            if (done) return;
            done = true; clearTimeout(timer); cleanup();
            resolve(res || { ok: false, error: 'The endpoint answered with nothing' });
        };

        script.onerror = function () {
            if (done) return;
            done = true; clearTimeout(timer); cleanup();
            resolve({
                ok: false,
                code: 'blocked',
                error: 'The endpoint refused the request. This is what a Google sign-in ' +
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
    }

    // Re-homed on every call, not just the first. With OTP on, the form moves
    // from the phone step to the code step between two status messages — and a
    // holder left behind on the hidden phone step shows the visitor nothing.
    var $host = $('#RenterNotice').hasClass('active') ? $('#RenterNotice .renter-notice')
              : $('#final').hasClass('active')        ? $('#final .answers-container')
              : $('#PhoneNumber .answers-container');

    if ($host.length && !$.contains($host[0], $holder[0] || {})) {
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

/**
 * Puts whichever control started the submission back within reach. With OTP on
 * that is the verify button on the code step; without it, Next on the phone
 * step. A failure that leaves neither clickable is a dead end for the visitor.
 */
function srReleaseSubmitControls() {
    if ($('#final').hasClass('active')) {
        $('#verify-code').removeAttr('disabled');
        $('#resend-code').show().removeClass('d-none');
    } else {
        $('#next-question').removeClass('d-none').removeAttr('disabled');
    }
}

/**
 * The one submission pipeline: collect every answer, write the row, redirect.
 *
 * Reached two ways. With OTP on, verifyCode() calls it with the token Twilio's
 * approval earned; with SKIP_OTP_VERIFICATION on, the phone step calls it with
 * nothing. The only difference between the two is that token — which is why
 * they share a function rather than a resemblance.
 */
function srSubmitLead(otpToken) {
    if (SR_SUBMIT_IN_PROGRESS) return;

    var results = calculateProgress();

    // Same completeness guard the OTP path used
    if ((results.total_questions - 1) > results.q_answered) {
        srReleaseSubmitControls();
        $('.question.active .error-holder')
            .html('<i class="fa fa-warning"></i> Please answer all questions')
            .css('display', 'inline-block');
        return;
    }

    SR_SUBMIT_IN_PROGRESS = true;
    $('.error-holder').html('').hide();
    srShowStatus('Submitting your details, please wait…', false);

    var leadType = srDetectLeadType();
    var data = srBuildLeadData(results.questions, leadType, otpToken);

    console.log('[Sheet] Lead type:', leadType);
    console.log('[Sheet] Payload:', data);

    // The token rides with the row and nowhere else. sessionStorage feeds the
    // thank-you page and Zapier feeds the CRM; neither has any use for a
    // short-lived credential, and both are places it would sit around in.
    var sheetData = data;
    if (otpToken) {
        sheetData = $.extend({}, data, { otp_token: otpToken });
    }

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

    srPostToSheet(sheetData)
        .then(function (res) {
            if (res.ok || !srCfgStrictSubmit()) {
                if (!res.ok) {
                    srStashFailed(sheetData);
                    console.error('[Sheet] Not saved, continuing anyway: ' + res.reason);
                }
                finish();
                return;
            }

            // Strict mode: surface the failure rather than showing a thank-you
            // page for a lead that never reached the sheet.
            srStashFailed(sheetData);
            settled = true;
            SR_SUBMIT_IN_PROGRESS = false;
            srReleaseSubmitControls();
            srShowStatus('<i class="fa fa-warning"></i> Not saved to the sheet.<br>' +
                         esc_(res.reason) + '<br><span style="font-weight:400;font-size:14px;">' +
                         'The details are held locally and will be retried on the next page load.</span>', true);
        })
        .catch(function (err) {
            console.error('[Sheet] Submit failed:', err);
            srStashFailed(sheetData);
            SR_SUBMIT_IN_PROGRESS = false;
            settled = true;
            srReleaseSubmitControls();
            srShowStatus('<i class="fa fa-warning"></i> ' + esc_(err && err.message ? err.message : String(err)), true);
        });

    setTimeout(function () {
        if (!settled) {
            srBeacon(srCfgSheetUrl(), JSON.stringify(sheetData));
            finish();
        }
    }, timeoutMs);
}

/**
 * The no-OTP entry point, called from the #next-question handler on the phone
 * step when SKIP_OTP_VERIFICATION is on. Kept as its own name because
 * js/diagnostics.js looks for it to tell a current custom.js from a stale one.
 */
function srSubmitWithoutOtp() {
    srSubmitLead('');
}

// Retry any lead that failed to save on a previous visit.
$(document).ready(function () { srRetryFailed(); });
