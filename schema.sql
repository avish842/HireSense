CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN ('ADMIN', 'RECRUITER', 'CANDIDATE')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    required_skills JSONB NOT NULL DEFAULT '[]',
    required_keywords JSONB NOT NULL DEFAULT '[]',
    min_skill_hit_ratio FLOAT NOT NULL DEFAULT 0.3,
    ats_threshold INT NOT NULL DEFAULT 50,
    score_threshold INT NOT NULL DEFAULT 70,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES users(id),
    job_id UUID REFERENCES jobs(id),
    file_key VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'UPLOADED',
    pre_filter_status VARCHAR(50),
    pre_filter_hit_ratio FLOAT,
    ats_score INT,
    ats_threshold_used INT,
    rejection_reason TEXT,
    rejection_stage VARCHAR(50) DEFAULT 'NONE',
    final_score FLOAT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(candidate_id, job_id)
);

CREATE TABLE ats_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID REFERENCES applications(id) UNIQUE,
    candidate_id UUID REFERENCES users(id),
    job_id UUID REFERENCES jobs(id),
    ats_score INT,
    keyword_match_score INT,
    formatting_score INT,
    section_completeness_score INT,
    quantification_score INT,
    matched_keywords JSONB,
    missing_keywords JSONB,
    formatting_issues JSONB,
    improvement_suggestions JSONB,
    raw_llm_response TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE extracted_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID REFERENCES applications(id) UNIQUE,
    candidate_id UUID REFERENCES users(id),
    name VARCHAR(255),
    email VARCHAR(255),
    skills JSONB,
    experience_years FLOAT,
    education JSONB,
    projects JSONB,
    location VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE interviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID REFERENCES applications(id) UNIQUE,
    candidate_id UUID REFERENCES users(id),
    job_id UUID REFERENCES jobs(id),
    scheduled_at TIMESTAMP WITH TIME ZONE,
    meeting_link VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_name VARCHAR(100) NOT NULL,
    job_id UUID,
    candidate_id UUID,
    action VARCHAR(255) NOT NULL,
    input_hash VARCHAR(255),
    output_summary TEXT,
    duration_ms INT,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
