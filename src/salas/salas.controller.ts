import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { SalasService } from './salas.service';
import { CrearSalaDto } from './dto/crear-sala.dto';
import { UnirseSalaDto } from './dto/unirse-sala.dto';

@Controller('salas')
export class SalasController {
  constructor(private readonly salasService: SalasService) {}

  @Post()
  crearSala(@Body() dto: CrearSalaDto) {
    return this.salasService.crearSala(dto.tema, dto.nickname);
  }

  @Get()
  listarSalas(@Query('estado') estado?: string) {
    return this.salasService.listarSalas(estado);
  }

  @Get(':codigo')
  obtenerSala(@Param('codigo') codigo: string) {
    return this.salasService.obtenerSala(codigo);
  }

  @Post(':codigo/unirse')
  unirseASala(@Param('codigo') codigo: string, @Body() dto: UnirseSalaDto) {
    return this.salasService.unirseASala(codigo, dto.nickname);
  }
}
