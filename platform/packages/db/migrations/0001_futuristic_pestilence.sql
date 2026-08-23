CREATE TABLE `audit_export_state` (
	`sink` text PRIMARY KEY NOT NULL,
	`last_exported_event_id` text,
	`last_exported_at` text,
	`batches_exported` integer DEFAULT 0 NOT NULL,
	`events_exported` integer DEFAULT 0 NOT NULL
);
