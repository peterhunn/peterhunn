ALTER TABLE `contact_endpoints` ADD `consent_status` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `contact_endpoints` ADD `consent_recorded_at` text;--> statement-breakpoint
ALTER TABLE `contact_endpoints` ADD `consent_source` text;