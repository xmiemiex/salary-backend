import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { CreateSubIdMappingInput, SubIdMappingsService, UpdateSubIdMappingInput } from './sub-id-mappings.service';

@Controller('sub-id-mappings')
export class SubIdMappingsController {
  constructor(private readonly mappings: SubIdMappingsService) {}

  @Post()
  @RequirePermissions('sub_id_mapping.manage')
  create(@Body() body: CreateSubIdMappingInput, @CurrentActor() actor: Actor) {
    return this.mappings.create(body, actor);
  }

  @Get()
  list(@Query() query: Record<string, string>) {
    return this.mappings.list(query);
  }

  @Patch(':id')
  @RequirePermissions('sub_id_mapping.manage')
  update(@Param('id') id: string, @Body() body: UpdateSubIdMappingInput, @CurrentActor() actor: Actor) {
    return this.mappings.update(id, body, actor);
  }

  @Patch(':id/disable')
  @RequirePermissions('sub_id_mapping.manage')
  disable(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.mappings.disable(id, actor);
  }
}
