CREATE TABLE `conversation_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`principal_id` text,
	`started_at` text NOT NULL,
	`last_activity_at` text NOT NULL,
	`closed_at` text,
	`topic` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_sessions_household_idx` ON `conversation_sessions` (`household_id`);--> statement-breakpoint
CREATE INDEX `conversation_sessions_endpoint_open_idx` ON `conversation_sessions` (`endpoint_id`,`closed_at`);--> statement-breakpoint
ALTER TABLE `messaging_events` ADD `session_id` text;--> statement-breakpoint
CREATE INDEX `messaging_events_session_idx` ON `messaging_events` (`session_id`);