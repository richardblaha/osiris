-- Tokens of the language model used per calendar month (YYYY-MM, UTC), for the tenant's quota
CREATE TABLE usage_months (
  month TEXT PRIMARY KEY,
  tokens INTEGER NOT NULL DEFAULT 0
);
