import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '@salary/shared';
import { AppError } from './app-error';
import { AppExceptionFilter } from './app-exception.filter';

describe('AppExceptionFilter', () => {
  function catchException(exception: unknown) {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;

    new AppExceptionFilter().catch(exception, host);
    return { status, json };
  }

  it.each([
    [ERROR_CODES.VALIDATION_ERROR, HttpStatus.BAD_REQUEST],
    [ERROR_CODES.PERMISSION_DENIED, HttpStatus.FORBIDDEN],
    [ERROR_CODES.MONTH_LOCKED, HttpStatus.CONFLICT],
    [ERROR_CODES.SETTLEMENT_NOT_FOUND, HttpStatus.NOT_FOUND],
  ])('maps %s to %s', (code, expectedStatus) => {
    const { status, json } = catchException(new AppError(code, 'message', { field: 'x' }));

    expect(status).toHaveBeenCalledWith(expectedStatus);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: {
        code,
        message: 'message',
        details: { field: 'x' },
      },
    });
  });

  it('returns 500 for unknown errors without stack', () => {
    const error = new Error('boom');
    error.stack = 'secret-stack';

    const { status, json } = catchException(error);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error.',
      },
    });
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('secret-stack');
  });
});
