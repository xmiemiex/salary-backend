import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { CreateEmployeeInput, EmployeesService, UpdateEmployeeInput } from './employees.service';

@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Post()
  @RequirePermissions('employee.manage')
  create(@Body() body: CreateEmployeeInput, @CurrentActor() actor: Actor) {
    return this.employees.create(body, actor);
  }

  @Get()
  list(@Query() query: Record<string, string>) {
    return this.employees.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.employees.get(id);
  }

  @Patch(':id')
  @RequirePermissions('employee.manage')
  update(@Param('id') id: string, @Body() body: UpdateEmployeeInput, @CurrentActor() actor: Actor) {
    return this.employees.update(id, body, actor);
  }

  @Patch(':id/disable')
  @RequirePermissions('employee.manage')
  disable(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.employees.disable(id, actor);
  }
}
