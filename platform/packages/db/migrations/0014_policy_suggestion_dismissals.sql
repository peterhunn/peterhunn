CREATE TABLE `policy_suggestion_dismissals` (
	`household_id` text NOT NULL,
	`action_class` text NOT NULL,
	`subject_principal_id` text NOT NULL,
	`dismissed_at_approval_id` text NOT NULL,
	`dismissed_at` text NOT NULL,
	`dismissed_by` text NOT NULL,
	PRIMARY KEY(`household_id`, `action_class`, `subject_principal_id`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
