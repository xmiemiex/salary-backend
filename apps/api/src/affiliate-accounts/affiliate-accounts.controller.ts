import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import {
  AffiliateAccountsService,
  CreateAffiliateAccountInput,
  UpdateAffiliateAccountInput,
} from './affiliate-accounts.service';

@Controller('affiliate-accounts')
export class AffiliateAccountsController {
  constructor(private readonly accounts: AffiliateAccountsService) {}

  @Post()
  @RequirePermissions('api_config.manage')
  create(@Body() body: CreateAffiliateAccountInput, @CurrentActor() actor: Actor) {
    return this.accounts.create(body, actor);
  }

  @Get()
  list(@Query() query: Record<string, string>) {
    return this.accounts.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.accounts.get(id);
  }

  @Patch(':id')
  @RequirePermissions('api_config.manage')
  update(@Param('id') id: string, @Body() body: UpdateAffiliateAccountInput, @CurrentActor() actor: Actor) {
    return this.accounts.update(id, body, actor);
  }

  @Patch(':id/disable')
  @RequirePermissions('api_config.manage')
  disable(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.accounts.disable(id, actor);
  }
}
