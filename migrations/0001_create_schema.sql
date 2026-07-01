-- Steel Registry System - Unified D1 Database Schema
-- Version: 1.0
-- Description: Core schema for multi-role user management with profile attributes and matching

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Users: Central source of truth for all identities
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,              -- Public UUID for API references
    name TEXT NOT NULL,
    phone TEXT UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT,                      -- For JWT/session auth (bcrypt/argon2)
    auth_provider TEXT DEFAULT 'local',      -- 'local', 'google', 'apple', 'phone_otp'
    auth_provider_id TEXT,                   -- External provider user ID
    is_active BOOLEAN DEFAULT 1,
    is_verified BOOLEAN DEFAULT 0,
    last_login_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Roles: Lookup table for role definitions (extensible without migrations)
CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,               -- 'patient', 'helper', 'actor', 'karaoke_singer', etc.
    display_name TEXT NOT NULL,
    description TEXT,
    is_system_role BOOLEAN DEFAULT 1,        -- System roles vs custom
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- User-Roles: Many-to-many for cross-role functionality (user can be helper AND karaoke_singer)
CREATE TABLE IF NOT EXISTS user_roles (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    assigned_by INTEGER REFERENCES users(id), -- Admin who assigned
    is_primary BOOLEAN DEFAULT 0,            -- Primary role for UI/defaults
    PRIMARY KEY (user_id, role_id)
);

-- Sessions: For session-based auth (alternative to stateless JWT)
CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,                     -- Session token (secure random)
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip_address TEXT,
    user_agent TEXT,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- PROFILE ATTRIBUTE TABLES (One-to-One with users)
-- ============================================================================

-- Patient Profiles: Medical and care-related attributes
CREATE TABLE IF NOT EXISTS patient_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    conditions TEXT,                         -- JSON array: ["diabetes", "hypertension"]
    medication_list TEXT,                    -- JSON array: [{"name": "metformin", "dosage": "500mg", "frequency": "2x daily"}]
    dietary_needs TEXT,                      -- JSON array: ["low_sodium", "diabetic_friendly"]
    allergies TEXT,                          -- JSON array: ["penicillin", "latex"]
    emergency_contact_name TEXT,
    emergency_contact_phone TEXT,
    emergency_contact_relationship TEXT,
    preferred_hospital TEXT,
    insurance_provider TEXT,
    insurance_policy_number TEXT,
    care_level TEXT DEFAULT 'independent',   -- 'independent', 'assisted', 'full_care'
    mobility_aids TEXT,                      -- JSON array: ["walker", "wheelchair"]
    cognitive_status TEXT,                   -- 'alert', 'mild_impairment', 'moderate_impairment'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Helper Profiles: Service provider attributes
CREATE TABLE IF NOT EXISTS helper_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    skills TEXT,                             -- JSON array: ["wound_care", "medication_admin", "mobility_assist"]
    certifications TEXT,                     -- JSON array: [{"name": "CNA", "expiry": "2026-12-31", "issuer": "State Board"}]
    hourly_rate REAL,                        -- In local currency
    currency TEXT DEFAULT 'USD',
    vetting_status TEXT DEFAULT 'pending',   -- 'pending', 'in_review', 'approved', 'rejected', 'suspended'
    vetting_notes TEXT,
    vetted_at DATETIME,
    vetted_by INTEGER REFERENCES users(id),
    experience_years INTEGER DEFAULT 0,
    experience_details TEXT,                 -- Free text or JSON
    availability_schedule TEXT,              -- JSON: {"mon": ["09:00-17:00"], "tue": ["09:00-17:00"]}
    service_radius_km INTEGER DEFAULT 25,
    languages_spoken TEXT,                   -- JSON array: ["en", "es", "zh"]
    background_check_status TEXT DEFAULT 'pending', -- 'pending', 'clear', 'flagged', 'expired'
    background_check_at DATETIME,
    rating_avg REAL DEFAULT 0.0,
    rating_count INTEGER DEFAULT 0,
    is_available BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Actor Profiles: Entertainment/performance attributes
CREATE TABLE IF NOT EXISTS actor_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    headshot_url TEXT,
    portfolio_urls TEXT,                     -- JSON array of URLs
    acting_monologue_links TEXT,             -- JSON array: [{"title": "Hamlet", "url": "...", "duration_sec": 120}]
    experience TEXT,                         -- Free text or JSON
    training TEXT,                           -- JSON array: ["method_acting", "improv", "voice"]
    special_skills TEXT,                     -- JSON array: ["singing", "dancing", "stage_combat", "accents"]
    height_cm INTEGER,
    weight_kg INTEGER,
    clothing_size TEXT,
    shoe_size TEXT,
    hair_color TEXT,
    eye_color TEXT,
    union_affiliation TEXT,                  -- 'SAG-AFTRA', 'Equity', 'Non-union'
    representation_agent TEXT,
    representation_contact TEXT,
    availability_notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Karaoke Singer Profiles: Entertainment attributes
CREATE TABLE IF NOT EXISTS karaoke_singer_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    stage_name TEXT,
    vocal_range TEXT,                        -- 'bass', 'baritone', 'tenor', 'alto', 'mezzo_soprano', 'soprano'
    preferred_genres TEXT,                   -- JSON array: ["pop", "rock", "r&b", "ballads"]
    song_repertoire TEXT,                    -- JSON array of known songs
    equipment_owned TEXT,                    -- JSON array: ["mic", "mixer", "speaker", "lighting"]
    performance_experience TEXT,             -- 'beginner', 'intermediate', 'pro', 'semi_pro'
    hourly_rate REAL,
    currency TEXT DEFAULT 'USD',
    availability_schedule TEXT,              -- JSON schedule
    service_radius_km INTEGER DEFAULT 50,
    social_media_links TEXT,                 -- JSON: {"youtube": "...", "instagram": "...", "tiktok": "..."}
    sample_audio_urls TEXT,                  -- JSON array of demo URLs
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- SUPPORTING TABLES
-- ============================================================================

-- Matches: Links helpers to patients for care matching
CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    helper_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'pending',           -- 'pending', 'accepted', 'active', 'completed', 'cancelled', 'declined'
    match_score REAL,                        -- Algorithmic compatibility score 0-100
    match_reason TEXT,                       -- JSON: {"skills_match": 0.8, "distance_km": 5, "availability_overlap": 0.9}
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    responded_at DATETIME,
    started_at DATETIME,
    completed_at DATETIME,
    cancelled_at DATETIME,
    cancellation_reason TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(helper_id, patient_id, status)    -- Prevent duplicate pending matches
);

-- Match History: Audit trail for match lifecycle
CREATE TABLE IF NOT EXISTS match_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    changed_by INTEGER REFERENCES users(id),
    change_reason TEXT,
    metadata TEXT,                           -- JSON for additional context
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Emergency Contacts: Standalone for quick emergency lookups
CREATE TABLE IF NOT EXISTS emergency_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_name TEXT NOT NULL,
    contact_phone TEXT NOT NULL,
    relationship TEXT,
    priority INTEGER DEFAULT 1,              -- 1 = primary, 2 = secondary, etc.
    can_make_decisions BOOLEAN DEFAULT 0,
    has_medical_access BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- User Preferences: App-level settings per user
CREATE TABLE IF NOT EXISTS user_preferences (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    notification_email BOOLEAN DEFAULT 1,
    notification_sms BOOLEAN DEFAULT 1,
    notification_push BOOLEAN DEFAULT 1,
    language TEXT DEFAULT 'en',
    timezone TEXT DEFAULT 'UTC',
    theme TEXT DEFAULT 'system',             -- 'light', 'dark', 'system'
    privacy_profile_visibility TEXT DEFAULT 'matched_only', -- 'public', 'matched_only', 'private'
    data_sharing_consent BOOLEAN DEFAULT 0,
    marketing_opt_in BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Audit Log: Security and compliance trail
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,                    -- 'login', 'profile_update', 'match_create', 'role_assign', etc.
    resource_type TEXT,                      -- 'user', 'match', 'profile', 'session'
    resource_id TEXT,
    ip_address TEXT,
    user_agent TEXT,
    metadata TEXT,                           -- JSON for flexible context
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- INDEXES FOR JOIN OPTIMIZATION
-- ============================================================================

-- Users indexes
CREATE INDEX IF NOT EXISTS idx_users_uuid ON users(uuid);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);

-- User-Roles indexes (critical for cross-role queries)
CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role_id ON user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_is_primary ON user_roles(is_primary);

-- Sessions indexes
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);

-- Profile indexes (for JOIN performance)
CREATE INDEX IF NOT EXISTS idx_patient_profiles_user_id ON patient_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_helper_profiles_user_id ON helper_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_helper_profiles_vetting_status ON helper_profiles(vetting_status);
CREATE INDEX IF NOT EXISTS idx_helper_profiles_is_available ON helper_profiles(is_available);
CREATE INDEX IF NOT EXISTS idx_helper_profiles_service_radius ON helper_profiles(service_radius_km);
CREATE INDEX IF NOT EXISTS idx_actor_profiles_user_id ON actor_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_karaoke_singer_profiles_user_id ON karaoke_singer_profiles(user_id);

-- Matches indexes (emergency lookups & matching queries)
CREATE INDEX IF NOT EXISTS idx_matches_helper_id ON matches(helper_id);
CREATE INDEX IF NOT EXISTS idx_matches_patient_id ON matches(patient_id);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_helper_status ON matches(helper_id, status);
CREATE INDEX IF NOT EXISTS idx_matches_patient_status ON matches(patient_id, status);
CREATE INDEX IF NOT EXISTS idx_matches_created_at ON matches(created_at);

-- Match History indexes
CREATE INDEX IF NOT EXISTS idx_match_history_match_id ON match_history(match_id);
CREATE INDEX IF NOT EXISTS idx_match_history_created_at ON match_history(created_at);

-- Emergency Contacts indexes
CREATE INDEX IF NOT EXISTS idx_emergency_contacts_user_id ON emergency_contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_emergency_contacts_priority ON emergency_contacts(user_id, priority);

-- Audit Log indexes
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

-- ============================================================================
-- VIEWS FOR COMMON QUERY PATTERNS
-- ============================================================================

-- Active users with primary role (for PWA feature unlocking)
CREATE VIEW IF NOT EXISTS v_active_users_with_primary_role AS
SELECT
    u.id,
    u.uuid,
    u.name,
    u.phone,
    u.email,
    u.is_verified,
    u.created_at,
    r.slug AS primary_role,
    r.display_name AS primary_role_name
FROM users u
JOIN user_roles ur ON u.id = ur.user_id AND ur.is_primary = 1
JOIN roles r ON ur.role_id = r.id
WHERE u.is_active = 1;

-- Helpers available for matching (emergency lookup optimized)
CREATE VIEW IF NOT EXISTS v_available_helpers AS
SELECT
    u.id,
    u.uuid,
    u.name,
    u.phone,
    u.email,
    hp.hourly_rate,
    hp.currency,
    hp.vetting_status,
    hp.experience_years,
    hp.skills,
    hp.certifications,
    hp.service_radius_km,
    hp.languages_spoken,
    hp.rating_avg,
    hp.rating_count,
    hp.availability_schedule
FROM users u
JOIN helper_profiles hp ON u.id = hp.user_id
JOIN user_roles ur ON u.id = ur.user_id
JOIN roles r ON ur.role_id = r.id
WHERE u.is_active = 1
  AND hp.is_available = 1
  AND hp.vetting_status = 'approved'
  AND r.slug = 'helper';

-- Patients needing care (for helper dashboards)
CREATE VIEW IF NOT EXISTS v_patients_needing_care AS
SELECT
    u.id,
    u.uuid,
    u.name,
    u.phone,
    u.email,
    pp.conditions,
    pp.medication_list,
    pp.dietary_needs,
    pp.allergies,
    pp.care_level,
    pp.mobility_aids,
    pp.cognitive_status,
    pp.emergency_contact_name,
    pp.emergency_contact_phone,
    pp.preferred_hospital
FROM users u
JOIN patient_profiles pp ON u.id = pp.user_id
JOIN user_roles ur ON u.id = ur.user_id
JOIN roles r ON ur.role_id = r.id
WHERE u.is_active = 1
  AND r.slug = 'patient';

-- Active matches with full context (for PWA real-time features)
CREATE VIEW IF NOT EXISTS v_active_matches_detail AS
SELECT
    m.id AS match_id,
    m.status,
    m.match_score,
    m.match_reason,
    m.requested_at,
    m.responded_at,
    m.started_at,
    -- Helper details
    h.id AS helper_id,
    h.uuid AS helper_uuid,
    h.name AS helper_name,
    h.phone AS helper_phone,
    hp.hourly_rate,
    hp.skills,
    -- Patient details
    p.id AS patient_id,
    p.uuid AS patient_uuid,
    p.name AS patient_name,
    p.phone AS patient_phone,
    pp.conditions,
    pp.care_level,
    pp.emergency_contact_name,
    pp.emergency_contact_phone
FROM matches m
JOIN users h ON m.helper_id = h.id
JOIN helper_profiles hp ON h.id = hp.user_id
JOIN users p ON m.patient_id = p.id
JOIN patient_profiles pp ON p.id = pp.user_id
WHERE m.status IN ('accepted', 'active');

-- ============================================================================
-- TRIGGERS FOR AUTOMATIC TIMESTAMP UPDATES
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS trigger_users_updated_at
AFTER UPDATE ON users
BEGIN
    UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trigger_patient_profiles_updated_at
AFTER UPDATE ON patient_profiles
BEGIN
    UPDATE patient_profiles SET updated_at = CURRENT_TIMESTAMP WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER IF NOT EXISTS trigger_helper_profiles_updated_at
AFTER UPDATE ON helper_profiles
BEGIN
    UPDATE helper_profiles SET updated_at = CURRENT_TIMESTAMP WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER IF NOT EXISTS trigger_actor_profiles_updated_at
AFTER UPDATE ON actor_profiles
BEGIN
    UPDATE actor_profiles SET updated_at = CURRENT_TIMESTAMP WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER IF NOT EXISTS trigger_karaoke_singer_profiles_updated_at
AFTER UPDATE ON karaoke_singer_profiles
BEGIN
    UPDATE karaoke_singer_profiles SET updated_at = CURRENT_TIMESTAMP WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER IF NOT EXISTS trigger_matches_updated_at
AFTER UPDATE ON matches
BEGIN
    UPDATE matches SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trigger_emergency_contacts_updated_at
AFTER UPDATE ON emergency_contacts
BEGIN
    UPDATE emergency_contacts SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trigger_user_preferences_updated_at
AFTER UPDATE ON user_preferences
BEGIN
    UPDATE user_preferences SET updated_at = CURRENT_TIMESTAMP WHERE user_id = NEW.user_id;
END;

-- ============================================================================
-- INITIAL ROLE SEED DATA
-- ============================================================================

INSERT OR IGNORE INTO roles (slug, display_name, description, is_system_role) VALUES
    ('patient', 'Patient', 'Receives care and assistance services', 1),
    ('helper', 'Helper', 'Provides care and assistance services', 1),
    ('actor', 'Actor', 'Performs acting roles for entertainment', 1),
    ('karaoke_singer', 'Karaoke Singer', 'Provides karaoke entertainment services', 1);

-- ============================================================================
-- FOREIGN KEY ENFORCEMENT (D1 requires explicit pragma)
-- ============================================================================

PRAGMA foreign_keys = ON;