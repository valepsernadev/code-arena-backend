import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SalasModule } from './salas/salas.module';
import { IaModule } from './ia/ia.module';
import { ArenasGateway } from './websockets/arenas.gateway';
import { SupabaseService } from './database/supabase.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    SalasModule,
    IaModule,
  ],
  controllers: [AppController],
  providers: [AppService, ArenasGateway, SupabaseService],
})
export class AppModule {}
