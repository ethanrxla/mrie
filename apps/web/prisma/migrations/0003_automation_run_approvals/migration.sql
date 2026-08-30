ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS subject_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS approvals_pending_action_idx
  ON approvals(user_id, action_type, subject_id, arguments_hash)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS approvals_expiry_idx
  ON approvals(status, expires_at);

-- Audit records are append-only. Corrections are represented by subsequent
-- events instead of changing or deleting prior evidence.
CREATE OR REPLACE FUNCTION mre_reject_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are immutable';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_immutable ON audit_events;
CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION mre_reject_audit_event_mutation();

DROP TRIGGER IF EXISTS audit_events_immutable_truncate ON audit_events;
CREATE TRIGGER audit_events_immutable_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION mre_reject_audit_event_mutation();
