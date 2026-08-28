CREATE TABLE `audit_event_hashes` (
	`event_id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`hash` text NOT NULL,
	`prev_household_hash` text,
	`prev_person_hashes` text DEFAULT '[]' NOT NULL,
	`principal_ids` text DEFAULT '[]' NOT NULL,
	`household_sequence` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_hash_household_seq_idx` ON `audit_event_hashes` (`household_id`,`household_sequence`);--> statement-breakpoint
CREATE INDEX `audit_hash_hash_idx` ON `audit_event_hashes` (`hash`);--> statement-breakpoint
CREATE TABLE `audit_chain_heads` (
	`household_id` text NOT NULL,
	`chain_key` text NOT NULL,
	`head_hash` text NOT NULL,
	`head_event_id` text NOT NULL,
	`head_at` text NOT NULL,
	`event_count` integer NOT NULL,
	PRIMARY KEY(`household_id`, `chain_key`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);