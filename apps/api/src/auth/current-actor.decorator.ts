import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Actor, RequestWithActor } from './auth.types';

export function actorFromRequest(request: Pick<RequestWithActor, 'actor' | 'user'>): Actor {
  const actor = request.actor ?? request.user;
  if (!actor) {
    throw new Error('Current actor is not available on request.');
  }
  return actor;
}

export const CurrentActor = createParamDecorator((_data: unknown, context: ExecutionContext): Actor => {
  const request = context.switchToHttp().getRequest<RequestWithActor>();
  return actorFromRequest(request);
});
