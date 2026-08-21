# Task 101 PhotonPay governance release notes

## Scope

- PhotonPay-only historical employee email aliases.
- Administrator test-card accounting exclusions selected from discovered `ProviderCard` rows.
- Controlled unmatched-card rematching without Card Detail or transaction-history replay.
- Permission, audit, safe preview, and append-only resolution evidence.

This release does not change employee primary email, CAKE/Everflow income, manual income adjustments,
salary formulas, RC tags, webhooks, scheduler settings, or automatic sync settings.

## Migration

Migration: `20260821010000_add_photonpay_alias_and_card_exclusion`.

Additive objects:

- `ProviderCardMatchStatus.excluded`;
- `ProviderCardMatchSource` and `ProviderCardExclusionReason` enums;
- nullable `provider_cards.match_source`;
- `provider_email_aliases`;
- `provider_card_accounting_exclusions`;
- append-only `provider_card_match_resolutions`;
- four narrowly scoped permissions granted only to the existing `super_admin` role by migration.

Database constraints:

- provider email aliases are restricted to `provider = photonpay`;
- alias and exclusion statuses are restricted to `active` or `disabled`;
- end timestamps must be later than start timestamps;
- unique keys prevent identical period starts;
- triggers take transaction-scoped advisory locks and reject overlapping active periods, including concurrent writes;
- foreign keys require aliases to reference employees and exclusions to reference already discovered provider cards.

There is no data backfill, row deletion, existing-table rewrite, or expected application downtime. The API/Web
restart remains the only service interruption boundary.

## Deployment and rollback

Run `deploy/scripts/task101-production-rollout.sh` only from the approved root shell after validating the exact
commit-bound archive. The script requires:

1. the existing production release gate to pass;
2. a new successful encrypted full backup and backup-health pass;
3. pre-migration evidence showing exactly the Task 101 migration pending and no drift;
4. successful `prisma migrate deploy`;
5. post-migration evidence showing zero pending migrations and no drift;
6. healthy API/Web containers, zero restarts, public and loopback HTTP checks, and a passing release gate;
7. `SYNC_PLANNER_ENABLED=false`, `SYNC_AUTO_EXECUTION_ENABLED=false`, and no PhotonPay webhook configuration.

On failure after service change, the script restores the previous immutable release tag, API/Web containers,
and operational gate helpers. The additive database schema is retained because the previous application ignores
the new nullable column and tables. Automatic reverse DDL is prohibited. If a later approved full schema rollback
is required, first export the Task 101 tables, verify there are no business records that must be retained, then
drop the new triggers/functions/tables/column and enum types in dependency order during a separate maintenance
window. Restoring the full database backup is reserved for a data-integrity incident and requires the existing
restore SOP and explicit approval.

## Production configuration boundary

Production aliases and the one administrator test-card exclusion must be configured only in the protected admin
page. Operators must not copy full email addresses, provider card identifiers, mapping tables, credentials, or
logs into chat, tickets, screenshots, or release evidence. Mapping and exclusion writes require server-generated
previews and explicit confirmation. The workflow does not replay historical transactions or enable automation.
