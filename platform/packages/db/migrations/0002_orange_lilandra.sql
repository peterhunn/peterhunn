CREATE TABLE `manager_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`manager_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text DEFAULT '[]',
	`device_label` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`manager_id`) REFERENCES `managers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manager_credentials_credential_id_unique` ON `manager_credentials` (`credential_id`);--> statement-breakpoint
CREATE INDEX `mgr_creds_manager_idx` ON `manager_credentials` (`manager_id`);--> statement-breakpoint
CREATE TABLE `webauthn_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`ceremony` text NOT NULL,
	`challenge` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
