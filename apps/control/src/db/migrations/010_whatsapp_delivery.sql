CREATE TABLE wa_deliveries (
  message_id TEXT PRIMARY KEY,
  phone_number_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL,
  status_at INTEGER NOT NULL,
  error_code TEXT
);
CREATE INDEX wa_deliveries_time ON wa_deliveries(status_at);
