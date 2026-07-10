import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '@salary/shared';

const STATUS_BY_CODE: Partial<Record<ErrorCode, HttpStatus>> = {
  VALIDATION_ERROR: HttpStatus.BAD_REQUEST,
  UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  PERMISSION_DENIED: HttpStatus.FORBIDDEN,
  MONTH_LOCKED: HttpStatus.CONFLICT,
  DUPLICATE_RESOURCE: HttpStatus.CONFLICT,
  CONFLICT: HttpStatus.CONFLICT,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  SETTLEMENT_NOT_FOUND: HttpStatus.NOT_FOUND,
  SETTLEMENT_ALREADY_LOCKED: HttpStatus.CONFLICT,
  SETTLEMENT_PRECHECK_FAILED: HttpStatus.BAD_REQUEST,
  SETTLEMENT_WARNING_ACK_REQUIRED: HttpStatus.BAD_REQUEST,
  IMPORT_TEMPLATE_INVALID: HttpStatus.BAD_REQUEST,
  IMPORT_ROW_INVALID: HttpStatus.BAD_REQUEST,
  AUDIT_WRITE_FAILED: HttpStatus.INTERNAL_SERVER_ERROR,
};

export class AppError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    details?: unknown,
  ) {
    super({ code, message, details }, STATUS_BY_CODE[code] ?? HttpStatus.INTERNAL_SERVER_ERROR);
  }
}
