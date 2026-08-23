CREATE TABLE `households` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`tier` text NOT NULL,
	`risk_tier` text DEFAULT 'standard' NOT NULL,
	`created_at` text NOT NULL,
	`archived_at` text,
	`frozen_at` text,
	`frozen_reason` text,
	`autopilot_enabled` text DEFAULT 'yes' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`provenance_source` text NOT NULL,
	`provenance_source_ref` text,
	`provenance_asserted_by` text NOT NULL,
	`provenance_asserted_at` text NOT NULL,
	`provenance_confidence` real NOT NULL,
	`provenance_status` text NOT NULL,
	`created_at` text NOT NULL,
	`superseded_by` text,
	`superseded_at` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `nodes_household_type_idx` ON `nodes` (`household_id`,`type`);--> statement-breakpoint
CREATE INDEX `nodes_household_status_idx` ON `nodes` (`household_id`,`provenance_status`);--> statement-breakpoint
CREATE TABLE `edges` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`type` text NOT NULL,
	`from_node_id` text NOT NULL,
	`to_node_id` text NOT NULL,
	`attrs` text DEFAULT '{}' NOT NULL,
	`provenance_source` text NOT NULL,
	`provenance_source_ref` text,
	`provenance_asserted_by` text NOT NULL,
	`provenance_asserted_at` text NOT NULL,
	`provenance_confidence` real NOT NULL,
	`provenance_status` text NOT NULL,
	`created_at` text NOT NULL,
	`superseded_by` text,
	`superseded_at` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `edges_household_type_idx` ON `edges` (`household_id`,`type`);--> statement-breakpoint
CREATE INDEX `edges_from_node_idx` ON `edges` (`from_node_id`);--> statement-breakpoint
CREATE INDEX `edges_to_node_idx` ON `edges` (`to_node_id`);--> statement-breakpoint
CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`subject_principal_id` text,
	`agent` text NOT NULL,
	`agent_version` text NOT NULL,
	`tool` text NOT NULL,
	`tool_version` text NOT NULL,
	`action_class` text NOT NULL,
	`domain` text NOT NULL,
	`inputs_hash` text NOT NULL,
	`outputs_hash` text,
	`amount_usd` real,
	`policy_id_authorizing` text,
	`approver_id` text,
	`approval_channel` text,
	`outcome` text NOT NULL,
	`summary` text NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `actions_household_created_at_idx` ON `actions` (`household_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `actions_household_outcome_idx` ON `actions` (`household_id`,`outcome`);--> statement-breakpoint
CREATE INDEX `actions_household_action_class_idx` ON `actions` (`household_id`,`action_class`);--> statement-breakpoint
CREATE INDEX `actions_household_policy_idx` ON `actions` (`household_id`,`policy_id_authorizing`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`sensitive` text DEFAULT 'no' NOT NULL,
	`metadata` text DEFAULT '{}',
	`at` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_household_at_idx` ON `audit_events` (`household_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_resource_idx` ON `audit_events` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`label` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`expires_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_actor_idx` ON `api_tokens` (`actor_type`,`actor_id`);--> statement-breakpoint
CREATE TABLE `household_grants` (
	`manager_id` text NOT NULL,
	`household_id` text NOT NULL,
	`role` text NOT NULL,
	`granted_at` text NOT NULL,
	`revoked_at` text,
	PRIMARY KEY(`manager_id`, `household_id`),
	FOREIGN KEY (`manager_id`) REFERENCES `managers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `household_grants_household_idx` ON `household_grants` (`household_id`);--> statement-breakpoint
CREATE TABLE `managers` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`email` text NOT NULL,
	`created_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `managers_email_unique` ON `managers` (`email`);--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`subject` text NOT NULL,
	`domain` text NOT NULL,
	`action_class` text NOT NULL,
	`effect` text DEFAULT 'allow' NOT NULL,
	`kind` text DEFAULT 'standing' NOT NULL,
	`autonomy_rank` real NOT NULL,
	`label` text NOT NULL,
	`spec` text NOT NULL,
	`provenance_source` text NOT NULL,
	`provenance_asserted_by` text NOT NULL,
	`provenance_asserted_at` text NOT NULL,
	`provenance_confidence` real NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	`consumed_by_action_id` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `policies_match_idx` ON `policies` (`household_id`,`domain`,`action_class`,`subject`);--> statement-breakpoint
CREATE INDEX `policies_household_idx` ON `policies` (`household_id`);--> statement-breakpoint
CREATE TABLE `orchestrator_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`intent_kind` text NOT NULL,
	`intent_attrs` text NOT NULL,
	`origin` text NOT NULL,
	`origin_by` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `orch_runs_household_created_at_idx` ON `orchestrator_runs` (`household_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`household_id` text NOT NULL,
	`agent` text NOT NULL,
	`agent_version` text NOT NULL,
	`kind` text NOT NULL,
	`inputs` text NOT NULL,
	`outputs` text,
	`state` text NOT NULL,
	`decision_summary` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `orchestrator_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tasks_run_idx` ON `tasks` (`run_id`);--> statement-breakpoint
CREATE INDEX `tasks_household_created_at_idx` ON `tasks` (`household_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`run_id` text NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`approver_type` text NOT NULL,
	`approver_id` text,
	`domain` text NOT NULL,
	`action_class` text NOT NULL,
	`tool_name` text NOT NULL,
	`tool_version` text NOT NULL,
	`tool_inputs` text NOT NULL,
	`proposed_attrs` text NOT NULL,
	`subject_principal_id` text,
	`amount_usd` real,
	`summary` text NOT NULL,
	`authority_policy_id` text,
	`proposed_by_agent` text NOT NULL,
	`proposed_by_agent_version` text NOT NULL,
	`reasons` text DEFAULT '[]' NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`resolved_by_type` text,
	`resolved_by_id` text,
	`resolved_at` text,
	`resolution_note` text,
	`result_action_id` text,
	`deadline_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `orchestrator_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `approvals_household_state_idx` ON `approvals` (`household_id`,`state`);--> statement-breakpoint
CREATE INDEX `approvals_run_idx` ON `approvals` (`run_id`);--> statement-breakpoint
CREATE INDEX `approvals_task_idx` ON `approvals` (`task_id`);--> statement-breakpoint
CREATE TABLE `model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text,
	`task_class` text NOT NULL,
	`min_tier` text NOT NULL,
	`selected_tier` text NOT NULL,
	`model_id` text NOT NULL,
	`provider` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_input_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd_estimated` real NOT NULL,
	`latency_ms` integer NOT NULL,
	`finish_reason` text NOT NULL,
	`router_reasons` text DEFAULT '[]' NOT NULL,
	`input_hash` text NOT NULL,
	`output_hash` text NOT NULL,
	`triggering_run_id` text,
	`triggering_task_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `model_calls_household_created_at_idx` ON `model_calls` (`household_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `model_calls_task_class_idx` ON `model_calls` (`task_class`);--> statement-breakpoint
CREATE TABLE `inbox_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`from_name` text NOT NULL,
	`from_address` text NOT NULL,
	`recipient_principal_id` text,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`received_at` text NOT NULL,
	`external_provider` text,
	`external_message_id` text,
	`external_thread_id` text,
	`status` text DEFAULT 'received' NOT NULL,
	`urgency` text,
	`recipient_class` text,
	`requires_reply` text DEFAULT 'unknown' NOT NULL,
	`triage_notes` text,
	`triaged_at` text,
	`draft_reply` text,
	`drafted_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inbox_household_status_idx` ON `inbox_messages` (`household_id`,`status`);--> statement-breakpoint
CREATE INDEX `inbox_household_received_at_idx` ON `inbox_messages` (`household_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `inbox_external_id_idx` ON `inbox_messages` (`external_provider`,`external_message_id`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`principal_ref` text,
	`credential` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	`last_used_at` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `credentials_household_provider_idx` ON `credentials` (`household_id`,`provider`);--> statement-breakpoint
CREATE INDEX `credentials_household_idx` ON `credentials` (`household_id`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`household_id` text NOT NULL,
	`provider` text NOT NULL,
	`cursor` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_result` text,
	PRIMARY KEY(`household_id`, `provider`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `calendar_events` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`external_provider` text NOT NULL,
	`external_calendar_id` text NOT NULL,
	`external_event_id` text NOT NULL,
	`title` text NOT NULL,
	`location` text,
	`description` text,
	`start_at` text NOT NULL,
	`end_at` text,
	`all_day` text DEFAULT 'no' NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`html_link` text,
	`external_updated_at` text,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `calendar_events_household_start_idx` ON `calendar_events` (`household_id`,`start_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_events_external_id_uidx` ON `calendar_events` (`external_provider`,`external_event_id`);--> statement-breakpoint
CREATE TABLE `contact_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`channel` text NOT NULL,
	`address` text NOT NULL,
	`principal_id` text,
	`label` text,
	`verified_at` text,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_endpoints_household_idx` ON `contact_endpoints` (`household_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `contact_endpoints_channel_address_uidx` ON `contact_endpoints` (`channel`,`address`);--> statement-breakpoint
CREATE TABLE `messaging_events` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`endpoint_id` text,
	`direction` text NOT NULL,
	`channel` text NOT NULL,
	`provider` text NOT NULL,
	`external_message_id` text,
	`from_address` text NOT NULL,
	`to_address` text NOT NULL,
	`body` text NOT NULL,
	`received_at` text NOT NULL,
	`planner_run_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messaging_events_household_idx` ON `messaging_events` (`household_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messaging_events_external_uidx` ON `messaging_events` (`provider`,`external_message_id`);--> statement-breakpoint
CREATE INDEX `messaging_events_received_at_idx` ON `messaging_events` (`household_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `pending_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`channel` text NOT NULL,
	`code` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`consumed_from_address` text,
	`consumed_endpoint_id` text,
	`label` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pending_verifications_code_idx` ON `pending_verifications` (`code`);--> statement-breakpoint
CREATE INDEX `pending_verifications_household_idx` ON `pending_verifications` (`household_id`);--> statement-breakpoint
CREATE TABLE `household_playbooks` (
	`household_id` text NOT NULL,
	`playbook_id` text NOT NULL,
	`enabled` text DEFAULT 'yes' NOT NULL,
	`config` text NOT NULL,
	`last_fire_at` text,
	`next_fire_at` text NOT NULL,
	`last_run_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`household_id`, `playbook_id`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `household_playbooks_next_fire_idx` ON `household_playbooks` (`next_fire_at`);--> statement-breakpoint
CREATE TABLE `document_blobs` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`sha256` text NOT NULL,
	`mime` text NOT NULL,
	`byte_size` integer NOT NULL,
	`storage_backend` text DEFAULT 'local' NOT NULL,
	`storage_ref` text NOT NULL,
	`original_filename` text,
	`uploaded_by` text NOT NULL,
	`uploaded_at` text NOT NULL,
	`document_node_id` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `document_blobs_household_sha_idx` ON `document_blobs` (`household_id`,`sha256`);--> statement-breakpoint
CREATE INDEX `document_blobs_household_idx` ON `document_blobs` (`household_id`);