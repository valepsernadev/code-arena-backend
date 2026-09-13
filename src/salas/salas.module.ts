import { Module } from '@nestjs/common';
import { SalasController } from './salas.controller';
import { SalasService } from './salas.service';
import { SupabaseService } from '../database/supabase.service';

@Module({
  controllers: [SalasController],
  providers: [SalasService, SupabaseService],
})
export class SalasModule {}
