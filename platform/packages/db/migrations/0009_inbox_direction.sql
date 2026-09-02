ALTER TABLE `inbox_messages` ADD `to_address` text;--> statement-breakpoint
ALTER TABLE `inbox_messages` ADD `direction` text DEFAULT 'inbound' NOT NULL;