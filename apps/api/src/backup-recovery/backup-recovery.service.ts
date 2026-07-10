import { Injectable } from '@nestjs/common';
import { BackupStatus, BackupType, Prisma, RestoreDrillStatus } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { summarizeAuditValue } from '../audit/audit-sanitizer';
import { Actor } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { publicJson, safeAlias, safeChecksum, safeJson, safeOptionalText, safeRecordKey } from './backup-recovery-sanitizer';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class BackupRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listBackups(query: Record<string, unknown>) {
    const page = positiveInt(query.page, 1, 100000);
    const pageSize = positiveInt(query.pageSize, 20, 100);
    const where: Prisma.BackupRecordWhereInput = {
      status: enumValue(query.status, BackupStatus),
      backupType: enumValue(query.type ?? query.backupType, BackupType),
      storageAlias: optionalAlias(query.storageAlias),
      startedAt: dateRange(query.startedAtFrom, query.startedAtTo),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.backupRecord.count({ where }),
      this.prisma.backupRecord.findMany({ where, orderBy: { startedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return { total, page, pageSize, items: items.map(backupListDto) };
  }

  async getBackup(idInput: string) {
    const item = await this.prisma.backupRecord.findUnique({ where: { id: uuid(idInput) } });
    if (!item) throw new AppError(ERROR_CODES.NOT_FOUND, 'Backup record not found.');
    return backupDto(item);
  }

  async createBackup(body: Record<string, unknown>, actor: Actor) {
    const data = backupInput(body, actor.userId);
    try {
      const created = await this.prisma.backupRecord.create({ data });
      await this.audit.success(auditInput('backup_record.created', actor, created.id, created.backupKey, undefined, backupDto(created), Object.keys(data)));
      return backupDto(created);
    } catch (error) {
      if (isUniqueError(error)) throw new AppError(ERROR_CODES.CONFLICT, 'backupKey already exists.');
      throw error;
    }
  }

  async updateBackup(idInput: string, body: Record<string, unknown>, actor: Actor) {
    const id = uuid(idInput);
    const before = await this.prisma.backupRecord.findUnique({ where: { id } });
    if (!before) throw new AppError(ERROR_CODES.NOT_FOUND, 'Backup record not found.');
    const data = backupInput(body, actor.userId, true);
    try {
      const updated = await this.prisma.backupRecord.update({ where: { id }, data });
      await this.audit.success(auditInput('backup_record.updated', actor, updated.id, updated.backupKey, backupDto(before), backupDto(updated), Object.keys(data)));
      return backupDto(updated);
    } catch (error) {
      if (isUniqueError(error)) throw new AppError(ERROR_CODES.CONFLICT, 'backupKey already exists.');
      throw error;
    }
  }

  async listDrills(query: Record<string, unknown>) {
    const page = positiveInt(query.page, 1, 100000);
    const pageSize = positiveInt(query.pageSize, 20, 100);
    const where: Prisma.RestoreDrillRecordWhereInput = {
      status: enumValue(query.status, RestoreDrillStatus),
      environmentAlias: optionalAlias(query.environmentAlias),
      startedAt: dateRange(query.startedAtFrom, query.startedAtTo),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.restoreDrillRecord.count({ where }),
      this.prisma.restoreDrillRecord.findMany({ where, orderBy: { startedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return { total, page, pageSize, items: items.map(drillListDto) };
  }

  async getDrill(idInput: string) {
    const item = await this.prisma.restoreDrillRecord.findUnique({ where: { id: uuid(idInput) } });
    if (!item) throw new AppError(ERROR_CODES.NOT_FOUND, 'Restore drill record not found.');
    return drillDto(item);
  }

  async createDrill(body: Record<string, unknown>, actor: Actor) {
    const data = drillInput(body, actor.userId);
    try {
      const created = await this.prisma.restoreDrillRecord.create({ data });
      await this.audit.success(auditInput('restore_drill.created', actor, created.id, created.drillKey, undefined, drillDto(created), Object.keys(data)));
      return drillDto(created);
    } catch (error) {
      if (isUniqueError(error)) throw new AppError(ERROR_CODES.CONFLICT, 'drillKey already exists.');
      throw error;
    }
  }

  async updateDrill(idInput: string, body: Record<string, unknown>, actor: Actor) {
    const id = uuid(idInput);
    const before = await this.prisma.restoreDrillRecord.findUnique({ where: { id } });
    if (!before) throw new AppError(ERROR_CODES.NOT_FOUND, 'Restore drill record not found.');
    const data = drillInput(body, actor.userId, true);
    try {
      const updated = await this.prisma.restoreDrillRecord.update({ where: { id }, data });
      await this.audit.success(auditInput('restore_drill.updated', actor, updated.id, updated.drillKey, drillDto(before), drillDto(updated), Object.keys(data)));
      return drillDto(updated);
    } catch (error) {
      if (isUniqueError(error)) throw new AppError(ERROR_CODES.CONFLICT, 'drillKey already exists.');
      throw error;
    }
  }
}

function backupInput(body: Record<string, unknown>, actorId: string, partial = false): Prisma.BackupRecordUncheckedCreateInput & Prisma.BackupRecordUncheckedUpdateInput {
  const data: Record<string, unknown> = { updatedBy: actorId };
  assign(data, 'backupKey', body.backupKey, (v) => safeRecordKey(v, 'backupKey'), partial);
  assign(data, 'status', body.status, (v) => enumRequired(v, BackupStatus, 'status'), partial);
  assign(data, 'backupType', body.backupType, (v) => enumRequired(v, BackupType, 'backupType'), partial);
  assign(data, 'startedAt', body.startedAt, (v) => dateRequired(v, 'startedAt'), partial);
  assign(data, 'completedAt', body.completedAt, (v) => optionalDate(v, 'completedAt'), true);
  assign(data, 'storageAlias', body.storageAlias, (v) => safeAlias(v, 'storageAlias'), partial);
  assign(data, 'fileSizeBytes', body.fileSizeBytes, optionalBigInt, true);
  assign(data, 'checksumSha256', body.checksumSha256, safeChecksum, true);
  assign(data, 'encrypted', body.encrypted, booleanRequired, partial);
  assign(data, 'encryptionAlias', body.encryptionAlias, (v) => safeAlias(v, 'encryptionAlias', false), true);
  assign(data, 'scopeSummary', body.scopeSummary, (v) => safeJson(v, 'scopeSummary'), true);
  assign(data, 'safeMetadata', body.safeMetadata, (v) => safeJson(v, 'safeMetadata'), true);
  assign(data, 'failureReason', body.failureReason, (v) => safeOptionalText(v, 'failureReason'), true);
  if (!partial) data.createdBy = actorId;
  return data as Prisma.BackupRecordUncheckedCreateInput & Prisma.BackupRecordUncheckedUpdateInput;
}

function drillInput(body: Record<string, unknown>, actorId: string, partial = false): Prisma.RestoreDrillRecordUncheckedCreateInput & Prisma.RestoreDrillRecordUncheckedUpdateInput {
  const data: Record<string, unknown> = { updatedBy: actorId };
  assign(data, 'drillKey', body.drillKey, (v) => safeRecordKey(v, 'drillKey'), partial);
  assign(data, 'status', body.status, (v) => enumRequired(v, RestoreDrillStatus, 'status'), partial);
  assign(data, 'environmentAlias', body.environmentAlias, (v) => safeAlias(v, 'environmentAlias'), partial);
  assign(data, 'backupKey', body.backupKey, (v) => (v === undefined || v === null || v === '' ? null : safeRecordKey(v, 'backupKey')), true);
  assign(data, 'startedAt', body.startedAt, (v) => dateRequired(v, 'startedAt'), partial);
  assign(data, 'completedAt', body.completedAt, (v) => optionalDate(v, 'completedAt'), true);
  assign(data, 'validationSummary', body.validationSummary, (v) => safeJson(v, 'validationSummary'), true);
  assign(data, 'safeMetadata', body.safeMetadata, (v) => safeJson(v, 'safeMetadata'), true);
  assign(data, 'failureReason', body.failureReason, (v) => safeOptionalText(v, 'failureReason'), true);
  if (!partial) data.createdBy = actorId;
  return data as Prisma.RestoreDrillRecordUncheckedCreateInput & Prisma.RestoreDrillRecordUncheckedUpdateInput;
}

function assign(data: Record<string, unknown>, field: string, value: unknown, parse: (value: unknown) => unknown, optional: boolean) {
  if (value === undefined && optional) return;
  data[field] = parse(value);
}

function backupDto(record: any) {
  return {
    id: record.id,
    backupKey: record.backupKey,
    status: record.status,
    backupType: record.backupType,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    storageAlias: record.storageAlias,
    fileSizeBytes: record.fileSizeBytes?.toString?.() ?? record.fileSizeBytes ?? null,
    checksumSha256: record.checksumSha256,
    encrypted: record.encrypted,
    encryptionAlias: record.encryptionAlias,
    scopeSummary: publicJson(record.scopeSummary),
    safeMetadata: publicJson(record.safeMetadata),
    failureReason: record.failureReason,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function backupListDto(record: any) {
  return {
    id: record.id,
    backupKey: record.backupKey,
    status: record.status,
    backupType: record.backupType,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    storageAlias: record.storageAlias,
    fileSizeBytes: record.fileSizeBytes?.toString?.() ?? record.fileSizeBytes ?? null,
    checksumPresent: Boolean(record.checksumSha256),
    encrypted: record.encrypted,
    encryptionAlias: record.encryptionAlias,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function drillDto(record: any) {
  return {
    id: record.id,
    drillKey: record.drillKey,
    status: record.status,
    environmentAlias: record.environmentAlias,
    backupKey: record.backupKey,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    validationSummary: publicJson(record.validationSummary),
    safeMetadata: publicJson(record.safeMetadata),
    failureReason: record.failureReason,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function drillListDto(record: any) {
  return {
    id: record.id,
    drillKey: record.drillKey,
    status: record.status,
    environmentAlias: record.environmentAlias,
    backupKey: record.backupKey,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function auditInput(action: string, actor: Actor, objectId: string, key: string, beforeData: unknown, afterData: unknown, changedFields: string[]) {
  return {
    actorUserId: actor.userId,
    actorRole: actor.roleCode,
    action,
    objectType: action.startsWith('backup') ? 'backup_record' : 'restore_drill',
    objectId,
    beforeData,
    afterData,
    changedFields,
    requestPayload: { key, status: (afterData as any)?.status, safeMetadataSummary: summarizeAuditValue((afterData as any)?.safeMetadata), timestamp: new Date().toISOString() },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  };
}

function positiveInt(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max) return value;
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'pagination value is invalid.');
}

function enumValue<T extends Record<string, string>>(value: unknown, enumObject: T): T[keyof T] | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'string' && Object.values(enumObject).includes(value)) return value as T[keyof T];
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'enum filter is invalid.');
}

function enumRequired<T extends Record<string, string>>(value: unknown, enumObject: T, field: string): T[keyof T] {
  const parsed = enumValue(value, enumObject);
  if (!parsed) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} is required.`);
  return parsed;
}

function dateRequired(value: unknown, field: string) {
  const date = optionalDate(value, field);
  if (!date) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} is required.`);
  return date;
}

function optionalDate(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} is invalid.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} is invalid.`);
  return date;
}

function optionalBigInt(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'fileSizeBytes is invalid.');
}

function booleanRequired(value: unknown) {
  if (typeof value === 'boolean') return value;
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'encrypted is required.');
}

function optionalAlias(value: unknown) {
  if (value === undefined || value === '') return undefined;
  return safeAlias(value, 'alias') ?? undefined;
}

function dateRange(from: unknown, to: unknown): Prisma.DateTimeFilter | undefined {
  const gte = optionalDate(from, 'startedAtFrom') ?? undefined;
  const lte = optionalDate(to, 'startedAtTo') ?? undefined;
  if (!gte && !lte) return undefined;
  return { gte, lte };
}

function uuid(value: unknown) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'id must be a valid UUID.');
  return value;
}

function isUniqueError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
