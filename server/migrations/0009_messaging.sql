-- =============================================================================
-- FarmQueue — 0009_messaging
-- Notification templates and the transactional outbox.
--
-- The outbox row is written in the SAME transaction as the business change that
-- caused it, so a notification can never exist for an event that did not happen,
-- and can never be lost for one that did.
--
-- Duplicate suppression is a UNIQUE constraint, not an application check. If the
-- reminder job runs twice, the second INSERT violates dedupe_key and is
-- discarded — which is the only approach that survives concurrency.
--
-- No template text is seeded here. Templates are authored in Phase 12 and must
-- be DLT-registerable before a real SMS provider is connected.
--
-- STATUS: WRITTEN, NOT EXECUTED.
-- =============================================================================

BEGIN;

CREATE TABLE notification_templates (
    id                  uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
    event_key           notification_event_t  NOT NULL,
    channel             text                  NOT NULL,
    locale              locale_t              NOT NULL,
    body_template       text                  NOT NULL,
    -- TRAI DLT registration identifier, required before commercial SMS may be
    -- sent to Indian numbers. NULL while using the mock provider.
    dlt_template_id     text,
    variables           jsonb                 NOT NULL DEFAULT '[]'::jsonb,
    status              text                  NOT NULL DEFAULT 'ACTIVE',
    version             integer               NOT NULL DEFAULT 1,
    updated_by_user_id  uuid                  REFERENCES users (id) ON DELETE RESTRICT,
    created_at          timestamptz           NOT NULL DEFAULT now(),
    updated_at          timestamptz           NOT NULL DEFAULT now(),

    CONSTRAINT notification_templates_channel_allowed
        CHECK (channel IN ('SMS', 'IN_APP')),

    CONSTRAINT notification_templates_status_allowed
        CHECK (status IN ('ACTIVE', 'INACTIVE')),

    CONSTRAINT notification_templates_version_positive
        CHECK (version > 0),

    CONSTRAINT notification_templates_body_not_blank
        CHECK (btrim(body_template) <> ''),

    CONSTRAINT notification_templates_variables_is_array
        CHECK (jsonb_typeof(variables) = 'array'),

    CONSTRAINT notification_templates_version_unique
        UNIQUE (event_key, channel, locale, version)
);

COMMENT ON TABLE notification_templates IS
    'One template per event, channel, locale and version. Per-locale templates '
    'are what allow a Hindi-preferring farmer to receive Hindi SMS: rendering '
    'never happens in a single hardcoded language.';

-- Exactly one template may be live for a given event, channel and locale.
CREATE UNIQUE INDEX notification_templates_one_active_per_event_channel_locale
    ON notification_templates (event_key, channel, locale)
    WHERE status = 'ACTIVE';

CREATE INDEX notification_templates_updated_by_idx ON notification_templates (updated_by_user_id);

CREATE TRIGGER notification_templates_set_updated_at
    BEFORE UPDATE ON notification_templates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- notifications — the outbox, and simultaneously the in-app notification feed.
-- channel = 'IN_APP' rows replace the prototype's client-side synthesised array
-- with real, persisted, timestamped, read/unread events.
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
    id                   uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              uuid                  NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    booking_id           uuid                  REFERENCES bookings (id) ON DELETE RESTRICT,
    event_key            notification_event_t  NOT NULL,
    channel              text                  NOT NULL,
    locale               locale_t              NOT NULL,
    template_id          uuid                  REFERENCES notification_templates (id) ON DELETE RESTRICT,

    -- IDEMPOTENCY, ENFORCED BY THE DATABASE.
    -- e.g. 'booking:<uuid>:ONE_DAY_REMINDER:2026-03-12'
    dedupe_key           text                  NOT NULL UNIQUE,

    rendered_body        text                  NOT NULL,
    to_phone_e164        e164_t,

    status               text                  NOT NULL DEFAULT 'QUEUED',
    scheduled_for        timestamptz           NOT NULL DEFAULT now(),
    attempts             smallint              NOT NULL DEFAULT 0,
    max_attempts         smallint              NOT NULL DEFAULT 5,
    last_error           text,
    suppressed_reason    text,
    provider_message_id  text,
    sent_at              timestamptz,
    read_at              timestamptz,
    created_at           timestamptz           NOT NULL DEFAULT now(),
    updated_at           timestamptz           NOT NULL DEFAULT now(),

    CONSTRAINT notifications_channel_allowed
        CHECK (channel IN ('SMS', 'IN_APP')),

    CONSTRAINT notifications_status_allowed
        CHECK (status IN ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SUPPRESSED')),

    CONSTRAINT notifications_attempts_within_limit
        CHECK (attempts >= 0 AND attempts <= max_attempts),

    CONSTRAINT notifications_max_attempts_positive
        CHECK (max_attempts > 0),

    CONSTRAINT notifications_dedupe_key_not_blank
        CHECK (btrim(dedupe_key) <> ''),

    CONSTRAINT notifications_body_not_blank
        CHECK (btrim(rendered_body) <> ''),

    -- An SMS must have somewhere to go.
    CONSTRAINT notifications_sms_requires_phone
        CHECK (channel <> 'SMS' OR to_phone_e164 IS NOT NULL),

    CONSTRAINT notifications_suppressed_requires_reason
        CHECK (status <> 'SUPPRESSED' OR suppressed_reason IS NOT NULL),

    CONSTRAINT notifications_sent_consistent
        CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
);

COMMENT ON TABLE notifications IS
    'Transactional outbox. Rows are inserted by the business transaction and '
    'dispatched by the worker with SELECT ... FOR UPDATE SKIP LOCKED. Read state '
    'for the in-app feed is read_at; delivery state is status.';
COMMENT ON COLUMN notifications.dedupe_key IS
    'Unique. Makes duplicate sends impossible even if a scheduler runs twice or '
    'two workers race. Never rely on an application-level "have we sent this?".';

-- The dispatcher's claim query: oldest due, queued first.
CREATE INDEX notifications_dispatch_idx
    ON notifications (scheduled_for)
    WHERE status IN ('QUEUED', 'SENDING');

-- The farmer's notification feed.
CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at DESC);

-- Unread badge count.
CREATE INDEX notifications_user_unread_idx
    ON notifications (user_id)
    WHERE read_at IS NULL AND channel = 'IN_APP';

CREATE INDEX notifications_booking_id_idx  ON notifications (booking_id);
CREATE INDEX notifications_template_id_idx ON notifications (template_id);

CREATE TRIGGER notifications_set_updated_at
    BEFORE UPDATE ON notifications
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO schema_migrations (version, name) VALUES ('0009', 'messaging');

COMMIT;
