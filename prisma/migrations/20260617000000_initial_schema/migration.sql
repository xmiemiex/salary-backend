-- CreateEnum
CREATE TYPE "CommonStatus" AS ENUM ('draft', 'confirmed', 'locked', 'active', 'disabled');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('draft', 'confirmed', 'locked');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('full_attendance', 'sick_leave', 'personal_leave', 'absent', 'other');

-- CreateEnum
CREATE TYPE "SalaryItemType" AS ENUM ('addition', 'deduction');

-- CreateEnum
CREATE TYPE "SalaryMode" AS ENUM ('single', 'group');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('airwallex', 'photonpay');

-- CreateEnum
CREATE TYPE "AuditResult" AS ENUM ('success', 'failure');

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "employee_code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "email" VARCHAR(255),
    "phone" VARCHAR(64),
    "status" "CommonStatus" NOT NULL DEFAULT 'active',
    "hired_at" DATE,
    "left_at" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_accounts" (
    "id" UUID NOT NULL,
    "platform" VARCHAR(64) NOT NULL,
    "account_code" VARCHAR(128) NOT NULL,
    "account_name" VARCHAR(255),
    "default_employee_id" UUID,
    "status" "CommonStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sub_id_mappings" (
    "id" UUID NOT NULL,
    "affiliate_account_id" UUID NOT NULL,
    "sub_field" VARCHAR(64) NOT NULL,
    "sub_value" VARCHAR(255) NOT NULL,
    "effective_month" DATE NOT NULL,
    "employee_id" UUID NOT NULL,
    "status" "CommonStatus" NOT NULL DEFAULT 'active',
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sub_id_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_bindings" (
    "id" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "card_id" VARCHAR(128) NOT NULL,
    "effective_month" DATE NOT NULL,
    "employee_id" UUID NOT NULL,
    "status" "CommonStatus" NOT NULL DEFAULT 'active',
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "card_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "income_records" (
    "id" UUID NOT NULL,
    "settlement_month" DATE NOT NULL,
    "affiliate_account_id" UUID,
    "employee_id" UUID,
    "source" VARCHAR(64) NOT NULL,
    "external_record_id" VARCHAR(128),
    "sub_field" VARCHAR(64),
    "sub_value" VARCHAR(255),
    "income_usd" DECIMAL(18,6) NOT NULL,
    "raw_data" JSONB,
    "status" "CommonStatus" NOT NULL DEFAULT 'draft',
    "imported_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "income_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_spend_events" (
    "id" UUID NOT NULL,
    "settlement_month" DATE NOT NULL,
    "provider" "Provider" NOT NULL,
    "card_id" VARCHAR(128) NOT NULL,
    "employee_id" UUID,
    "external_event_id" VARCHAR(128),
    "transaction_at" TIMESTAMP(3) NOT NULL,
    "spend_usd" DECIMAL(18,6) NOT NULL,
    "settled_at" TIMESTAMP(3),
    "source_status" VARCHAR(64),
    "source_updated_at" TIMESTAMP(3),
    "raw_data" JSONB,
    "status" "CommonStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "card_spend_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manual_card_spend_entries" (
    "id" UUID NOT NULL,
    "settlement_month" DATE NOT NULL,
    "provider_name" VARCHAR(128) NOT NULL,
    "card_identifier" VARCHAR(128),
    "employee_id" UUID NOT NULL,
    "settled_spend_usd" DECIMAL(18,6) NOT NULL,
    "fee_rate" DECIMAL(10,6) NOT NULL,
    "actual_spend_usd" DECIMAL(18,6) NOT NULL,
    "reason" TEXT,
    "status" "SettlementStatus" NOT NULL DEFAULT 'draft',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manual_card_spend_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_card_provider_fee_rates" (
    "id" UUID NOT NULL,
    "settlement_month" DATE NOT NULL,
    "provider" "Provider" NOT NULL,
    "fee_rate" DECIMAL(10,6) NOT NULL,
    "status" "CommonStatus" NOT NULL DEFAULT 'active',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monthly_card_provider_fee_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_exchange_rates" (
    "id" UUID NOT NULL,
    "settlement_month" DATE NOT NULL,
    "usd_to_rmb_rate" DECIMAL(18,8) NOT NULL,
    "status" "CommonStatus" NOT NULL DEFAULT 'active',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monthly_exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historical_negative_profits" (
    "id" UUID NOT NULL,
    "settlement_month" DATE NOT NULL,
    "employee_id" UUID NOT NULL,
    "amount_usd" DECIMAL(18,6) NOT NULL,
    "reason" TEXT,
    "status" "CommonStatus" NOT NULL DEFAULT 'active',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "historical_negative_profits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_performance_groups" (
    "id" UUID NOT NULL,
    "settlement_month" DATE NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "salary_mode" "SalaryMode" NOT NULL,
    "status" "CommonStatus" NOT NULL DEFAULT 'active',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monthly_performance_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_performance_group_members" (
    "id" UUID NOT NULL,
    "settlement_month" DATE NOT NULL,
    "group_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "allocation_ratio" DECIMAL(10,6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monthly_performance_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_item_configs" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "item_type" "SalaryItemType" NOT NULL,
    "status" "CommonStatus" NOT NULL DEFAULT 'active',
    "description" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salary_item_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_salary_manual_items" (
    "id" UUID NOT NULL,
    "settlement_month" DATE NOT NULL,
    "employee_id" UUID NOT NULL,
    "config_id" UUID NOT NULL,
    "amount_rmb" DECIMAL(18,2) NOT NULL,
    "remark" TEXT,
    "status" "CommonStatus" NOT NULL DEFAULT 'active',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monthly_salary_manual_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_settlements" (
    "id" UUID NOT NULL,
    "settlement_month" DATE NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'draft',
    "generated_at" TIMESTAMP(3),
    "generated_by" UUID,
    "confirmed_at" TIMESTAMP(3),
    "confirmed_by" UUID,
    "locked_at" TIMESTAMP(3),
    "locked_by" UUID,
    "lock_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monthly_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_settlement_details" (
    "id" UUID NOT NULL,
    "settlement_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "settlement_month" DATE NOT NULL,
    "attendance_status" "AttendanceStatus",
    "income_usd" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "card_spend_usd" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "gross_profit_usd" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "gross_profit_rmb" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "commission_rmb" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "manual_addition_rmb" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "manual_deduction_rmb" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "final_salary_rmb" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monthly_settlement_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "actor_role" VARCHAR(64),
    "action" VARCHAR(128) NOT NULL,
    "object_type" VARCHAR(128) NOT NULL,
    "object_id" VARCHAR(128),
    "settlement_month" DATE,
    "before_data" JSONB,
    "after_data" JSONB,
    "changed_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "request_payload" JSONB,
    "result" "AuditResult" NOT NULL,
    "failure_reason" TEXT,
    "error_message" TEXT,
    "ip_address" VARCHAR(64),
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "display_name" VARCHAR(128) NOT NULL,
    "email" VARCHAR(255),
    "employee_id" UUID,
    "status" "CommonStatus" NOT NULL DEFAULT 'active',
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "status" "CommonStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "code" VARCHAR(128) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_user_roles" (
    "admin_user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_user_roles_pkey" PRIMARY KEY ("admin_user_id","role_id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employees_employee_code_key" ON "employees"("employee_code");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_accounts_platform_account_code_key" ON "affiliate_accounts"("platform", "account_code");

-- CreateIndex
CREATE INDEX "sub_id_mappings_employee_id_effective_month_idx" ON "sub_id_mappings"("employee_id", "effective_month");

-- CreateIndex
CREATE UNIQUE INDEX "sub_id_mappings_affiliate_account_id_sub_field_sub_value_ef_key" ON "sub_id_mappings"("affiliate_account_id", "sub_field", "sub_value", "effective_month");

-- CreateIndex
CREATE INDEX "card_bindings_employee_id_effective_month_idx" ON "card_bindings"("employee_id", "effective_month");

-- CreateIndex
CREATE UNIQUE INDEX "card_bindings_provider_card_id_effective_month_key" ON "card_bindings"("provider", "card_id", "effective_month");

-- CreateIndex
CREATE INDEX "income_records_settlement_month_employee_id_idx" ON "income_records"("settlement_month", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "income_records_source_external_record_id_key" ON "income_records"("source", "external_record_id");

-- CreateIndex
CREATE INDEX "card_spend_events_settlement_month_employee_id_idx" ON "card_spend_events"("settlement_month", "employee_id");

-- CreateIndex
CREATE INDEX "card_spend_events_provider_settlement_month_status_idx" ON "card_spend_events"("provider", "settlement_month", "status");

-- CreateIndex
CREATE INDEX "card_spend_events_provider_card_id_settlement_month_idx" ON "card_spend_events"("provider", "card_id", "settlement_month");

-- CreateIndex
CREATE INDEX "card_spend_events_external_event_id_idx" ON "card_spend_events"("external_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "card_spend_events_provider_external_event_id_key" ON "card_spend_events"("provider", "external_event_id");

-- CreateIndex
CREATE INDEX "manual_card_spend_entries_settlement_month_employee_id_idx" ON "manual_card_spend_entries"("settlement_month", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_card_provider_fee_rates_settlement_month_provider_key" ON "monthly_card_provider_fee_rates"("settlement_month", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_exchange_rates_settlement_month_key" ON "monthly_exchange_rates"("settlement_month");

-- CreateIndex
CREATE INDEX "historical_negative_profits_settlement_month_employee_id_idx" ON "historical_negative_profits"("settlement_month", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_performance_groups_settlement_month_name_key" ON "monthly_performance_groups"("settlement_month", "name");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_performance_group_members_settlement_month_employee_key" ON "monthly_performance_group_members"("settlement_month", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_performance_group_members_group_id_employee_id_key" ON "monthly_performance_group_members"("group_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "salary_item_configs_code_key" ON "salary_item_configs"("code");

-- CreateIndex
CREATE INDEX "monthly_salary_manual_items_settlement_month_employee_id_idx" ON "monthly_salary_manual_items"("settlement_month", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_settlements_settlement_month_key" ON "monthly_settlements"("settlement_month");

-- CreateIndex
CREATE INDEX "monthly_settlement_details_settlement_month_employee_id_idx" ON "monthly_settlement_details"("settlement_month", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_settlement_details_settlement_id_employee_id_key" ON "monthly_settlement_details"("settlement_id", "employee_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_object_type_object_id_idx" ON "audit_logs"("object_type", "object_id");

-- CreateIndex
CREATE INDEX "audit_logs_settlement_month_idx" ON "audit_logs"("settlement_month");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- AddForeignKey
ALTER TABLE "affiliate_accounts" ADD CONSTRAINT "affiliate_accounts_default_employee_id_fkey" FOREIGN KEY ("default_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_id_mappings" ADD CONSTRAINT "sub_id_mappings_affiliate_account_id_fkey" FOREIGN KEY ("affiliate_account_id") REFERENCES "affiliate_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_id_mappings" ADD CONSTRAINT "sub_id_mappings_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_bindings" ADD CONSTRAINT "card_bindings_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "income_records" ADD CONSTRAINT "income_records_affiliate_account_id_fkey" FOREIGN KEY ("affiliate_account_id") REFERENCES "affiliate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "income_records" ADD CONSTRAINT "income_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_spend_events" ADD CONSTRAINT "card_spend_events_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_card_spend_entries" ADD CONSTRAINT "manual_card_spend_entries_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historical_negative_profits" ADD CONSTRAINT "historical_negative_profits_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_performance_group_members" ADD CONSTRAINT "monthly_performance_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "monthly_performance_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_performance_group_members" ADD CONSTRAINT "monthly_performance_group_members_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_salary_manual_items" ADD CONSTRAINT "monthly_salary_manual_items_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_salary_manual_items" ADD CONSTRAINT "monthly_salary_manual_items_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "salary_item_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_settlement_details" ADD CONSTRAINT "monthly_settlement_details_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "monthly_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_settlement_details" ADD CONSTRAINT "monthly_settlement_details_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
