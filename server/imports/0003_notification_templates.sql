-- =============================================================================
-- FarmQueue — import 0003: notification templates   (Phase 12)
--
-- CLASSIFICATION: **CONFIGURED**, not OFFICIAL.
--   This is product copy authored for the demonstration build. It contains no
--   government data, no official wording, and no claim attributable to any
--   authority. It is data, not schema, so it lives in imports/ alongside the
--   MSP and geography imports rather than in a migration.
--
-- DLT REGISTRATION
--   `dlt_template_id` is left NULL on every row. A TRAI DLT template id is
--   issued by a telecom registrar and CANNOT be fabricated. Until one exists,
--   no SMS-channel row may be sent to a real number — which is why Phase 10/12
--   create IN_APP rows only.
--
-- VARIABLES
--   Placeholders are {name} and are substituted by engines/notifications.ts.
--   The `variables` column lists what each template expects, so a missing
--   variable is detectable rather than silently rendering "undefined".
--
-- IDEMPOTENT: re-running replaces the ACTIVE row for each
-- (event_key, channel, locale) rather than accumulating versions.
-- =============================================================================

BEGIN;

DELETE FROM notification_templates WHERE status = 'ACTIVE';

INSERT INTO notification_templates (event_key, channel, locale, body_template, variables, updated_by_user_id)
VALUES
-- BOOKING_CONFIRMED ----------------------------------------------------------
('BOOKING_CONFIRMED', 'IN_APP', 'en',
 'Your {cropName} booking {bookingCode} is confirmed at {centreName} on {serviceDate} at {scheduledStartLocal}. Token {tokenNumber}.',
 '["cropName","bookingCode","centreName","serviceDate","scheduledStartLocal","tokenNumber"]'::jsonb,
 :'configured_by'::uuid),
('BOOKING_CONFIRMED', 'IN_APP', 'hi',
 'आपकी {cropName} की बुकिंग {bookingCode} {centreName} पर {serviceDate} को {scheduledStartLocal} बजे के लिए पक्की हो गई है। टोकन {tokenNumber}।',
 '["cropName","bookingCode","centreName","serviceDate","scheduledStartLocal","tokenNumber"]'::jsonb,
 :'configured_by'::uuid),

-- BOOKING_ARRIVED ------------------------------------------------------------
('BOOKING_ARRIVED', 'IN_APP', 'en',
 'Your arrival at {centreName} has been recorded. Booking {bookingCode}, token {tokenNumber}. Please wait for your turn.',
 '["centreName","bookingCode","tokenNumber"]'::jsonb,
 :'configured_by'::uuid),
('BOOKING_ARRIVED', 'IN_APP', 'hi',
 '{centreName} पर आपका आगमन दर्ज कर लिया गया है। बुकिंग {bookingCode}, टोकन {tokenNumber}। कृपया अपनी बारी की प्रतीक्षा करें।',
 '["centreName","bookingCode","tokenNumber"]'::jsonb,
 :'configured_by'::uuid),

-- PROCUREMENT_COMPLETED ------------------------------------------------------
('PROCUREMENT_COMPLETED', 'IN_APP', 'en',
 'Procurement for booking {bookingCode} has been recorded. Payment status: {paymentStatus}.',
 '["bookingCode","paymentStatus"]'::jsonb,
 :'configured_by'::uuid),
('PROCUREMENT_COMPLETED', 'IN_APP', 'hi',
 'बुकिंग {bookingCode} के लिए आपकी उपज की खरीद दर्ज कर ली गई है। भुगतान की स्थिति: {paymentStatus}।',
 '["bookingCode","paymentStatus"]'::jsonb,
 :'configured_by'::uuid),

-- PAYMENT_BLOCKED ------------------------------------------------------------
('PAYMENT_BLOCKED', 'IN_APP', 'en',
 'Payment for booking {bookingCode} is on hold because {blockedReasonText}. Please contact the procurement centre.',
 '["bookingCode","blockedReasonText"]'::jsonb,
 :'configured_by'::uuid),
('PAYMENT_BLOCKED', 'IN_APP', 'hi',
 'बुकिंग {bookingCode} का भुगतान अभी रुका हुआ है क्योंकि {blockedReasonText}। कृपया खरीद केंद्र से संपर्क करें।',
 '["bookingCode","blockedReasonText"]'::jsonb,
 :'configured_by'::uuid),

-- PAYMENT_UPDATED ------------------------------------------------------------
('PAYMENT_UPDATED', 'IN_APP', 'en',
 'Payment for booking {bookingCode} is now {paymentStatus}.{amountSuffix}',
 '["bookingCode","paymentStatus","amountSuffix"]'::jsonb,
 :'configured_by'::uuid),
('PAYMENT_UPDATED', 'IN_APP', 'hi',
 'बुकिंग {bookingCode} के भुगतान की स्थिति अब {paymentStatus} है।{amountSuffix}',
 '["bookingCode","paymentStatus","amountSuffix"]'::jsonb,
 :'configured_by'::uuid),

-- BOOKING_CANCELLED ----------------------------------------------------------
('BOOKING_CANCELLED', 'IN_APP', 'en',
 'Your booking {bookingCode} at {centreName} on {serviceDate} has been cancelled.',
 '["bookingCode","centreName","serviceDate"]'::jsonb,
 :'configured_by'::uuid),
('BOOKING_CANCELLED', 'IN_APP', 'hi',
 '{serviceDate} को {centreName} पर आपकी बुकिंग {bookingCode} रद्द कर दी गई है।',
 '["bookingCode","centreName","serviceDate"]'::jsonb,
 :'configured_by'::uuid),

-- NO_SHOW_RECORDED -----------------------------------------------------------
('NO_SHOW_RECORDED', 'IN_APP', 'en',
 'You were recorded as not having arrived for booking {bookingCode} at {centreName} on {serviceDate}.',
 '["bookingCode","centreName","serviceDate"]'::jsonb,
 :'configured_by'::uuid),
('NO_SHOW_RECORDED', 'IN_APP', 'hi',
 '{serviceDate} को {centreName} पर बुकिंग {bookingCode} के लिए आप उपस्थित नहीं हुए, यह दर्ज किया गया है।',
 '["bookingCode","centreName","serviceDate"]'::jsonb,
 :'configured_by'::uuid),

-- ONE_DAY_REMINDER -----------------------------------------------------------
-- Template exists so the copy is reviewable; NOTHING enqueues this event,
-- because REMINDER_SEND_HOUR_LOCAL has no approved value.
('ONE_DAY_REMINDER', 'IN_APP', 'en',
 'Reminder: your booking {bookingCode} at {centreName} is tomorrow, {serviceDate} at {scheduledStartLocal}. Token {tokenNumber}.',
 '["bookingCode","centreName","serviceDate","scheduledStartLocal","tokenNumber"]'::jsonb,
 :'configured_by'::uuid),
('ONE_DAY_REMINDER', 'IN_APP', 'hi',
 'याद दिलाना: {centreName} पर आपकी बुकिंग {bookingCode} कल {serviceDate} को {scheduledStartLocal} बजे है। टोकन {tokenNumber}।',
 '["bookingCode","centreName","serviceDate","scheduledStartLocal","tokenNumber"]'::jsonb,
 :'configured_by'::uuid),

-- QUEUE_APPROACHING ----------------------------------------------------------
-- Template exists so the copy is reviewable; NOTHING enqueues this event,
-- because approaching_position_threshold does not exist in the schema.
('QUEUE_APPROACHING', 'IN_APP', 'en',
 'Your turn at {centreName} is approaching. Booking {bookingCode}, token {tokenNumber}, queue position {queuePosition}.',
 '["centreName","bookingCode","tokenNumber","queuePosition"]'::jsonb,
 :'configured_by'::uuid),
('QUEUE_APPROACHING', 'IN_APP', 'hi',
 '{centreName} पर आपकी बारी नज़दीक है। बुकिंग {bookingCode}, टोकन {tokenNumber}, कतार में स्थान {queuePosition}।',
 '["centreName","bookingCode","tokenNumber","queuePosition"]'::jsonb,
 :'configured_by'::uuid);

DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM notification_templates WHERE status = 'ACTIVE';
    RAISE NOTICE 'notification templates: % ACTIVE rows (CONFIGURED, dlt_template_id NULL)', n;
END
$$;

COMMIT;
