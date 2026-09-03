-- =============================================================================
-- FarmQueue — 0015_notification_preferences   (Phase 12)
--
-- WHY THIS IS NEEDED
--   Phase 12 requires opt-out handling. Nothing in the schema records whether a
--   user wants a given kind of message on a given channel, and the dispatcher
--   has no way to suppress one without it. `notifications.suppressed_reason`
--   already exists and expects a reason; this table supplies the only reason
--   Phase 12 can honestly produce.
--
-- THE DEFAULT IS OPT-IN, AND THAT IS A DECISION
--   A row's absence means "no preference recorded", which resolves to ENABLED.
--   Rationale: every event FarmQueue sends is transactional and directly about
--   the farmer's own booking, arrival, procurement or payment — not marketing.
--   Withholding a payment-blocked message from a farmer who never expressed a
--   preference would be worse than sending it. A farmer can opt out per channel
--   at any time, and that choice is stored here.
--
--   This is documented rather than silently assumed: see
--   docs/phase-12-notification-contract.md §Preferences.
--
-- WHAT THIS DOES NOT DO
--   * No quiet hours, no daily cap, no retention policy — those remain
--     unspecified operational policy and are NOT invented here.
--   * No government data.
--   * No change to any existing table, constraint or trigger.
--
-- FORWARD-ONLY.
-- =============================================================================

BEGIN;

CREATE TABLE notification_preferences (
    id          uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid                  NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    channel     text                  NOT NULL,
    -- NULL event_key = a channel-wide preference. A row naming an event
    -- overrides the channel-wide row for that event only.
    event_key   notification_event_t,
    enabled     boolean               NOT NULL DEFAULT true,
    updated_at  timestamptz           NOT NULL DEFAULT now(),
    created_at  timestamptz           NOT NULL DEFAULT now(),

    CONSTRAINT notification_preferences_channel_allowed
        CHECK (channel IN ('SMS', 'IN_APP'))
);

-- One preference per (user, channel, event). The COALESCE is required for the
-- same reason migration 0013 needed it on MSP grades: two NULL event_keys would
-- never collide, leaving exactly the duplicate this index exists to prevent.
CREATE UNIQUE INDEX notification_preferences_one_per_scope
    ON notification_preferences (user_id, channel, COALESCE(event_key, ''));

CREATE INDEX notification_preferences_user_idx ON notification_preferences (user_id);

CREATE TRIGGER notification_preferences_set_updated_at
    BEFORE UPDATE ON notification_preferences
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE notification_preferences IS
    'Per-user notification opt-out. An ABSENT row means no preference recorded, '
    'which resolves to ENABLED — every event sent is transactional and about '
    'the user''s own procurement, never marketing. Phase 12.';

COMMENT ON COLUMN notification_preferences.event_key IS
    'NULL = applies to the whole channel. A row naming an event overrides the '
    'channel-wide row for that event only.';

INSERT INTO schema_migrations (version, name) VALUES ('0015', 'notification_preferences');

COMMIT;
