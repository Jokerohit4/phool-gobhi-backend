CREATE SCHEMA IF NOT EXISTS notification;

CREATE TABLE IF NOT EXISTS notification.campaign (
  id uuid PRIMARY KEY,
  config jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','completed','cancelled')),
  next_at timestamptz,
  run_count integer NOT NULL DEFAULT 0,
  created_by integer NOT NULL,
  updated_by integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_campaign_due ON notification.campaign (next_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS notification_campaign_event ON notification.campaign ((config->>'event')) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS notification.run (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES notification.campaign(id),
  kind text NOT NULL CHECK (kind IN ('scheduled','event','test')),
  config jsonb NOT NULL,
  due_at timestamptz NOT NULL,
  cursor integer NOT NULL DEFAULT 0,
  expanded boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS notification_run_due ON notification.run (due_at) WHERE NOT expanded;
CREATE INDEX IF NOT EXISTS notification_run_campaign ON notification.run (campaign_id, due_at DESC);

CREATE TABLE IF NOT EXISTS notification.delivery (
  run_id uuid NOT NULL REFERENCES notification.run(id),
  user_id integer NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','accepted','failed','skipped','unknown')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  PRIMARY KEY (run_id, user_id)
);
CREATE INDEX IF NOT EXISTS notification_delivery_pending ON notification.delivery (run_id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS notification_delivery_sending ON notification.delivery (updated_at) WHERE status = 'sending';

CREATE TABLE IF NOT EXISTS notification.event_receipt (
  user_id integer NOT NULL,
  id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS notification_event_received ON notification.event_receipt (received_at);

CREATE TABLE IF NOT EXISTS notification.event_frequency (
  campaign_id uuid NOT NULL REFERENCES notification.campaign(id),
  user_id integer NOT NULL,
  count integer NOT NULL,
  latest_at timestamptz NOT NULL,
  PRIMARY KEY (campaign_id, user_id)
);

CREATE TABLE IF NOT EXISTS notification.worker_lease (
  name text PRIMARY KEY,
  holder uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
