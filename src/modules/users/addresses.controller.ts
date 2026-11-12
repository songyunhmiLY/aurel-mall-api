import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import type { UserPrincipal } from '../../common/auth/user-principal';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { parseRouteId } from '../../common/http/parse-id';
import { AddressesService } from './addresses.service';
import { AddressDto } from './dto/address.dto';

@Controller('me/addresses')
@UseGuards(MiniProgramTokenGuard)
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  @Get()
  list(@CurrentUser() user: UserPrincipal) {
    return this.addresses.list(user.id);
  }

  @Post()
  @HttpCode(200)
  create(@CurrentUser() user: UserPrincipal, @Body() body: AddressDto) {
    return this.addresses.create(user.id, body);
  }

  @Put(':id')
  update(@CurrentUser() user: UserPrincipal, @Param('id') id: string, @Body() body: AddressDto) {
    return this.addresses.update(user.id, parseRouteId(id), body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: UserPrincipal, @Param('id') id: string) {
    return this.addresses.remove(user.id, parseRouteId(id));
  }

  @Post(':id/default')
  @HttpCode(200)
  setDefault(@CurrentUser() user: UserPrincipal, @Param('id') id: string) {
    return this.addresses.setDefault(user.id, parseRouteId(id));
  }
}
