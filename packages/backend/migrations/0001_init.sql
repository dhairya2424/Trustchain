-- TrustChain off-chain schema.
--
-- The chain is the source of truth for identity, roles and ownership. This database
-- holds only what the chain cannot: display data, encrypted personal fields, and an
-- indexed mirror of on-chain events for querying.
--
-- Two application roles, and neither is a superuser:
--
--   app_service  the API. Reads and writes everything, but still subject to RLS.
--   app_anon     the lowest-privilege role, used for any request acting on behalf of an
--                end user. Read-only, and can see only public rows or the caller's own.
--                If a key ever leaks to a browser, this is the one it should be.
--
-- Row ownership is decided by current_setting('app.did_hash'), set per transaction with
-- SET LOCAL. Using SET LOCAL matters: a plain SET would leak the identity to whichever
-- request picks up that pooled connection next.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

CREATE ROLE app_service NOLOGIN;
CREATE ROLE app_anon NOLOGIN;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE profiles (
    did_hash          text PRIMARY KEY,
    address           text        NOT NULL,
    display_name      text,
    bio               text,
    avatar_uri        text,
    role              text,
    is_public         boolean     NOT NULL DEFAULT false,
    -- AES-256-GCM ciphertext produced by src/db/crypto.ts. Never plaintext, and never
    -- readable by app_anon: the column grant below omits these entirely.
    email_encrypted    bytea,
    kyc_ref_encrypted  bytea,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assets (
    token_id     bigint PRIMARY KEY,
    owner_did    text        NOT NULL REFERENCES profiles (did_hash),
    token_uri    text        NOT NULL,
    soulbound    boolean     NOT NULL DEFAULT false,
    is_public    boolean     NOT NULL DEFAULT true,
    minted_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credentials (
    credential_hash text PRIMARY KEY,
    did_hash        text        NOT NULL REFERENCES profiles (did_hash),
    schema_id       text        NOT NULL,
    issuer          text        NOT NULL,
    issued_at       timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz,
    revoked         boolean     NOT NULL DEFAULT false,
    revocation_reason integer
);

CREATE TABLE audit_log (
    entry_id     bigint PRIMARY KEY,
    did_hash     text,
    action_code  smallint    NOT NULL,
    ref_hash     text,
    caller       text        NOT NULL,
    block_number bigint      NOT NULL,
    occurred_at  timestamptz NOT NULL
);

CREATE INDEX assets_owner_did_idx ON assets (owner_did);
CREATE INDEX credentials_did_hash_idx ON credentials (did_hash);
CREATE INDEX audit_log_did_hash_idx ON audit_log (did_hash);
CREATE INDEX audit_log_occurred_at_idx ON audit_log (occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log   ENABLE ROW LEVEL SECURITY;

-- app_service: unrestricted, but still governed by a policy rather than by bypass, so
-- the rule is visible in the catalogue instead of implied by role attributes.
CREATE POLICY profiles_service    ON profiles    FOR ALL TO app_service USING (true) WITH CHECK (true);
CREATE POLICY assets_service      ON assets      FOR ALL TO app_service USING (true) WITH CHECK (true);
CREATE POLICY credentials_service ON credentials FOR ALL TO app_service USING (true) WITH CHECK (true);
CREATE POLICY audit_service       ON audit_log   FOR ALL TO app_service USING (true) WITH CHECK (true);

-- app_anon: SELECT only. There is deliberately NO insert, update or delete policy —
-- absence denies, so a future GRANT alone cannot accidentally make it writable.
CREATE POLICY profiles_anon_select ON profiles FOR SELECT TO app_anon
    USING (is_public OR did_hash = current_setting('app.did_hash', true));

CREATE POLICY assets_anon_select ON assets FOR SELECT TO app_anon
    USING (is_public OR owner_did = current_setting('app.did_hash', true));

-- Credentials are never public: a verifier checks a hash it was already shown, so
-- browsing other people's credentials serves no purpose and leaks who holds what.
CREATE POLICY credentials_anon_select ON credentials FOR SELECT TO app_anon
    USING (did_hash = current_setting('app.did_hash', true));

-- The audit trail is public on-chain, but scoping it here stops the API becoming a
-- convenient index of everyone's activity.
CREATE POLICY audit_anon_select ON audit_log FOR SELECT TO app_anon
    USING (did_hash = current_setting('app.did_hash', true));

-- ---------------------------------------------------------------------------
-- Grants — least privilege
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO app_service, app_anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON profiles, assets, credentials, audit_log TO app_service;

-- Column-level grant, not table-level. Even if an RLS policy were widened by mistake,
-- app_anon still cannot read the encrypted columns: they are simply not granted.
GRANT SELECT (did_hash, address, display_name, bio, avatar_uri, role, is_public, created_at, updated_at)
    ON profiles TO app_anon;
GRANT SELECT ON assets, credentials, audit_log TO app_anon;

-- Explicitly withhold everything else. app_anon must never write.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON profiles, assets, credentials, audit_log FROM app_anon;
