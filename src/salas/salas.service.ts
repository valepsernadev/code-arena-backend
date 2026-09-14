import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../database/supabase.service';

const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MAX_INTENTOS_CODIGO = 20;

@Injectable()
export class SalasService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async crearSala(tema: string, nickname: string) {
    const supabase = this.supabaseService.getCliente();

    if (!tema || !nickname) {
      throw new BadRequestException({
        error: 'El tema y el nickname son obligatorios',
      });
    }

    const codigo = await this.generarCodigoUnico();

    const { data: sala, error: errorSala } = await supabase
      .from('salas')
      .insert({ codigo, tema, jugador_count: 1 })
      .select()
      .single();

    if (errorSala) {
      throw new BadRequestException({ error: errorSala.message });
    }

    const { error: errorJugador } = await supabase
      .from('jugadores')
      .insert({ sala_id: sala.id, nickname, conectado: true });

    if (errorJugador) {
      throw new BadRequestException({ error: errorJugador.message });
    }

    return sala;
  }

  async unirseASala(codigo: string, nickname: string) {
    const supabase = this.supabaseService.getCliente();

    if (!nickname) {
      throw new BadRequestException({ error: 'El nickname es obligatorio' });
    }

    const { data, error } = await supabase.rpc('unirse_a_sala', {
      p_codigo: codigo,
      p_nickname: nickname,
    });

    if (error) {
      throw new BadRequestException({ error: error.message });
    }

    if (data && data.error) {
      throw new BadRequestException({ error: data.error });
    }

    await this.iniciarPartidaSiCorresponde(codigo);

    return this.obtenerSala(codigo);
  }

  private async iniciarPartidaSiCorresponde(codigo: string): Promise<void> {
    const supabase = this.supabaseService.getCliente();

    const { data: sala } = await supabase
      .from('salas')
      .select('*')
      .eq('codigo', codigo)
      .maybeSingle();

    if (
      !sala ||
      sala.estado !== 'WAITING' ||
      sala.jugador_count < sala.capacidad
    ) {
      return;
    }

    await supabase
      .from('salas')
      .update({ estado: 'PLAYING' })
      .eq('id', sala.id);
  }

  async obtenerSala(codigo: string) {
    const supabase = this.supabaseService.getCliente();

    const { data: sala, error: errorSala } = await supabase
      .from('salas')
      .select('*')
      .eq('codigo', codigo)
      .maybeSingle();

    if (errorSala) {
      throw new BadRequestException({ error: errorSala.message });
    }

    if (!sala) {
      throw new BadRequestException({ error: 'Sala no encontrada' });
    }

    const { data: jugadores, error: errorJugadores } = await supabase
      .from('jugadores')
      .select('*')
      .eq('sala_id', sala.id);

    if (errorJugadores) {
      throw new BadRequestException({ error: errorJugadores.message });
    }

    return { sala, jugadores };
  }

  async listarSalas(estado?: string) {
    const supabase = this.supabaseService.getCliente();

    let consulta = supabase.from('salas').select('*');

    if (estado) {
      consulta = consulta.eq('estado', estado);
    }

    const { data, error } = await consulta;

    if (error) {
      throw new BadRequestException({ error: error.message });
    }

    return data;
  }

  private async generarCodigoUnico(): Promise<string> {
    const supabase = this.supabaseService.getCliente();

    for (let intento = 0; intento < MAX_INTENTOS_CODIGO; intento++) {
      const codigo = this.generarCodigo();

      const { data } = await supabase
        .from('salas')
        .select('id')
        .eq('codigo', codigo)
        .maybeSingle();

      if (!data) {
        return codigo;
      }
    }

    throw new BadRequestException({
      error: 'No se pudo generar un código de sala único',
    });
  }

  private generarCodigo(): string {
    let letras = '';
    for (let i = 0; i < 3; i++) {
      letras += LETRAS.charAt(Math.floor(Math.random() * LETRAS.length));
    }

    let numeros = '';
    for (let i = 0; i < 3; i++) {
      numeros += Math.floor(Math.random() * 10).toString();
    }

    return `SALA-${letras}-${numeros}`;
  }
}
