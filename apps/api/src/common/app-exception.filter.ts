import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_CODES, ErrorCode } from '@salary/shared';
import { AppError } from './app-error';

type ErrorBody = {
  success: false;
  error: {
    code: ErrorCode | 'INTERNAL_SERVER_ERROR';
    message: string;
    details?: unknown;
  };
};

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

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    const body = this.toBody(exception);
    response.status(this.toStatus(exception, body.error.code)).json(body);
  }

  private toBody(exception: unknown): ErrorBody {
    if (exception instanceof AppError) {
      const payload = exception.getResponse() as { code: ErrorCode; message: string; details?: unknown };
      const body: ErrorBody = {
        success: false,
        error: {
          code: payload.code,
          message: payload.message,
        },
      };
      if (payload.details !== undefined) body.error.details = payload.details;
      return body;
    }

    if (exception instanceof HttpException) {
      return {
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: exception.message || 'Internal server error.',
        },
      };
    }

    return {
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error.',
      },
    };
  }

  private toStatus(exception: unknown, code: ErrorBody['error']['code']): HttpStatus {
    if (code !== 'INTERNAL_SERVER_ERROR') return STATUS_BY_CODE[code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
    if (exception instanceof HttpException && !(exception instanceof AppError)) return exception.getStatus();
    return STATUS_BY_CODE[ERROR_CODES.AUDIT_WRITE_FAILED] ?? HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
