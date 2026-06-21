CREATE TABLE links (
    id BIGSERIAL PRIMARY KEY,
    code VARCHAR(10) UNIQUE,
    long_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- psql -U postgres -d url_shortener -c "ALTER TABLE links ADD COLUMN click_count BIGINT NOT NULL DEFAULT 0;"