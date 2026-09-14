import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { SupabaseService } from '../database/supabase.service';
import { IaService } from '../ia/ia.service';
import { Pregunta } from '../ia/pregunta.interface';

const MIN_X = -49;
const MAX_X = 49;
const MIN_Z = -49;
const MAX_Z = 49;
const MIN_Y = 0.5;
const MAX_Y = 50;

const PUNTOS_RESPUESTA_CORRECTA = 10;
const RESPUESTAS_PARA_GANAR = 5;
const DURACION_PARTIDA_MS = 300 * 1000;

const HABILIDADES = ['Boost', 'Attack', 'Shield'];

const DURACIONES: Record<string, number> = {
  Boost: 5,
  Attack: 0,
  Shield: 10,
};

const DESCRIPCIONES: Record<string, string> = {
  Boost: '+200% velocidad del drone',
  Attack: 'Dispara rayo visual a otro drone',
  Shield: '-50% daño recibido',
};

interface JugadorConectado {
  jugadorId: string;
  nickname: string;
  salaId: string;
  color: string;
}

@WebSocketGateway({
  cors: {
    origin: [
      'http://localhost:4200',
      'https://code-arena-frontend-delta.vercel.app',
    ],
  },
})
export class ArenasGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ArenasGateway.name);

  private salas = new Map<string, Socket[]>();
  private jugadores = new Map<string, JugadorConectado>();
  private preguntasPendientes = new Map<string, Pregunta>();
  private partidas = new Map<
    string,
    { inicio: number; intervalo: ReturnType<typeof setInterval> }
  >();
  private escudos = new Map<string, number>();

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly iaService: IaService,
  ) {}

  handleConnection(socket: Socket): void {
    this.handleConnect(socket);
  }

  handleConnect(socket: Socket): void {
    this.logger.log(`Socket conectado: ${socket.id}`);
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const info = this.jugadores.get(socket.id);

    if (!info) {
      return;
    }

    const supabase = this.supabaseService.getCliente();

    await supabase
      .from('jugadores')
      .update({ conectado: false })
      .eq('id', info.jugadorId);

    const clientes = this.salas.get(info.salaId) ?? [];
    this.salas.set(
      info.salaId,
      clientes.filter((cliente) => cliente.id !== socket.id),
    );

    this.jugadores.delete(socket.id);
    this.preguntasPendientes.delete(socket.id);

    this.emitirASala(info.salaId, 'jugadorDesconectado', {
      jugadorId: info.jugadorId,
      nickname: info.nickname,
    });

    const { data: jugadores } = await supabase
      .from('jugadores')
      .select('conectado')
      .eq('sala_id', info.salaId);

    const lista = jugadores ?? [];
    const conectados = lista.filter((j) => j.conectado).length;

    if (lista.length > 0 && conectados === 0) {
      await this.finalizarSala(info.salaId);
    }
  }

  @SubscribeMessage('unirseSala')
  async unirseSala(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: { salaId: string; nickname: string },
  ): Promise<void> {
    const supabase = this.supabaseService.getCliente();

    const { data } = await supabase
      .from('jugadores')
      .select('*')
      .eq('sala_id', payload.salaId)
      .eq('nickname', payload.nickname)
      .limit(1);

    const jugador = data?.[0];

    if (!jugador) {
      socket.emit('error', { error: 'Jugador no encontrado en la sala' });
      return;
    }

    const color = this.colorAleatorio();

    this.jugadores.set(socket.id, {
      jugadorId: jugador.id,
      nickname: jugador.nickname,
      salaId: payload.salaId,
      color,
    });

    const clientes = this.salas.get(payload.salaId) ?? [];
    if (!clientes.some((cliente) => cliente.id === socket.id)) {
      clientes.push(socket);
    }
    this.salas.set(payload.salaId, clientes);

    this.emitirASala(payload.salaId, 'jugadorUnido', {
      nickname: jugador.nickname,
      posicion_x: jugador.posicion_x,
      posicion_y: jugador.posicion_y,
      posicion_z: jugador.posicion_z,
      color,
    });

    await this.emitirEstadoSala(payload.salaId);
  }

  @SubscribeMessage('moverDrone')
  async moverDrone(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    payload: {
      salaId: string;
      jugadorId: string;
      x: number;
      y: number;
      z: number;
    },
  ): Promise<void> {
    const x = Math.max(MIN_X, Math.min(MAX_X, payload.x));
    const y = Math.max(MIN_Y, Math.min(MAX_Y, payload.y));
    const z = Math.max(MIN_Z, Math.min(MAX_Z, payload.z));

    const supabase = this.supabaseService.getCliente();

    await supabase
      .from('jugadores')
      .update({ posicion_x: x, posicion_y: y, posicion_z: z })
      .eq('id', payload.jugadorId);

    this.emitirASalaExcepto(payload.salaId, socket.id, 'actualizarPosicion', {
      jugadorId: payload.jugadorId,
      x,
      y,
      z,
      timestamp: Date.now(),
    });
  }

  @SubscribeMessage('pedirPregunta')
  async pedirPregunta(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: { salaId: string; tema: string },
  ): Promise<void> {
    const pregunta = await this.iaService.generarPregunta(payload.tema);

    this.preguntasPendientes.set(socket.id, pregunta);

    socket.emit('preguntaRecibida', {
      enunciado: pregunta.enunciado,
      opciones: pregunta.opciones,
      respuestaCorrecta: pregunta.respuestaCorrecta,
      dificultad: pregunta.dificultad,
    });
  }

  @SubscribeMessage('responderPregunta')
  async responderPregunta(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    payload: {
      salaId: string;
      respuestaUsuario: number;
      respuestaCorrecta: number;
    },
  ): Promise<void> {
    const info = this.jugadores.get(socket.id);

    if (!info) {
      return;
    }

    const supabase = this.supabaseService.getCliente();

    const { data: jugador } = await supabase
      .from('jugadores')
      .select('*')
      .eq('id', info.jugadorId)
      .maybeSingle();

    if (!jugador) {
      return;
    }

    const esCorrecta = payload.respuestaUsuario === payload.respuestaCorrecta;
    const pendiente = this.preguntasPendientes.get(socket.id);

    await supabase.from('preguntas_respondidas').insert({
      sala_id: payload.salaId,
      jugador_id: jugador.id,
      enunciado: pendiente ? pendiente.enunciado : '',
      respuesta_usuario: payload.respuestaUsuario,
      respuesta_correcta: payload.respuestaCorrecta,
      es_correcta: esCorrecta,
      dificultad: pendiente ? pendiente.dificultad : 'media',
    });

    this.preguntasPendientes.delete(socket.id);

    if (esCorrecta) {
      const respuestasConsecutivas = jugador.respuestas_correctas_seguidas + 1;
      const puntajeTotal = jugador.puntaje + PUNTOS_RESPUESTA_CORRECTA;
      const habilidad =
        HABILIDADES[(respuestasConsecutivas - 1) % HABILIDADES.length];

      await supabase
        .from('jugadores')
        .update({
          puntaje: puntajeTotal,
          respuestas_correctas_seguidas: respuestasConsecutivas,
          habilidad_desbloqueada: habilidad,
        })
        .eq('id', jugador.id);

      socket.emit('respuestaCorrecta', {
        puntajeSumado: PUNTOS_RESPUESTA_CORRECTA,
        puntajeTotal,
        habilidadDesbloqueada: habilidad,
        respuestasConsecutivas,
      });

      socket.emit('habilidadDesbloqueada', {
        habilidad,
        duracion: DURACIONES[habilidad],
        descripcion: DESCRIPCIONES[habilidad],
      });

    } else {
      const vidasRestantes = Math.max(0, jugador.vidas - 1);

      await supabase
        .from('jugadores')
        .update({
          vidas: vidasRestantes,
          respuestas_correctas_seguidas: 0,
        })
        .eq('id', jugador.id);

      socket.emit('respuestaIncorrecta', {
        vidasRestantes,
        mensaje: `Respuesta incorrecta. Te quedan ${vidasRestantes} vidas.`,
      });

    }

    await this.verificarVictoria(payload.salaId);
    await this.emitirEstadoSala(payload.salaId);
  }

  @SubscribeMessage('iniciarPartida')
  async iniciarPartida(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: { salaId: string },
  ): Promise<void> {
    const supabase = this.supabaseService.getCliente();

    const { data: sala } = await supabase
      .from('salas')
      .select('*')
      .eq('id', payload.salaId)
      .maybeSingle();

    if (!sala || sala.estado !== 'WAITING' || sala.jugador_count < 2) {
      return;
    }

    await supabase
      .from('salas')
      .update({ estado: 'PLAYING' })
      .eq('id', sala.id);

    await this.emitirEstadoSala(payload.salaId);
  }

  @SubscribeMessage('usarHabilidad')
  async usarHabilidad(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    payload: { salaId: string; jugadorId: string; habilidad: string },
  ): Promise<void> {
    const supabase = this.supabaseService.getCliente();

    const { data: jugador } = await supabase
      .from('jugadores')
      .select('*')
      .eq('id', payload.jugadorId)
      .maybeSingle();

    if (!jugador || jugador.habilidad_desbloqueada !== payload.habilidad) {
      return;
    }

    const duracion = DURACIONES[payload.habilidad];

    if (duracion === undefined) {
      return;
    }

    let objetivoId: string | null = null;
    let anulado = false;

    if (payload.habilidad === 'Attack') {
      const { data: rivales } = await supabase
        .from('jugadores')
        .select('*')
        .eq('sala_id', payload.salaId)
        .neq('id', jugador.id)
        .order('creado_en', { ascending: true });

      const objetivo = (rivales ?? [])[0];

      if (objetivo) {
        objetivoId = objetivo.id;
        anulado = this.escudoActivo(objetivo.id);

        if (anulado) {
          this.escudos.delete(objetivo.id);
        } else {
          const vidasRestantes = Math.max(0, objetivo.vidas - 1);

          await supabase
            .from('jugadores')
            .update({ vidas: vidasRestantes })
            .eq('id', objetivo.id);
        }
      }
    }

    if (payload.habilidad === 'Shield') {
      this.escudos.set(jugador.id, Date.now() + duracion * 1000);
    }

    this.emitirASala(payload.salaId, 'habilidadUsada', {
      jugadorId: jugador.id,
      habilidad: payload.habilidad,
      duracion,
      objetivoId,
      anulado,
    });

    await this.verificarVictoria(payload.salaId);
    await this.emitirEstadoSala(payload.salaId);
  }

  private escudoActivo(jugadorId: string): boolean {
    const expiraEn = this.escudos.get(jugadorId);

    if (!expiraEn) {
      return false;
    }

    if (Date.now() >= expiraEn) {
      this.escudos.delete(jugadorId);
      return false;
    }

    return true;
  }

  @SubscribeMessage('reconectarSala')
  async reconectarSala(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: { salaId: string; jugadorId: string },
  ): Promise<void> {
    const supabase = this.supabaseService.getCliente();

    await supabase
      .from('jugadores')
      .update({ conectado: true })
      .eq('id', payload.jugadorId);

    const { data: jugador } = await supabase
      .from('jugadores')
      .select('*')
      .eq('id', payload.jugadorId)
      .maybeSingle();

    if (!jugador) {
      return;
    }

    this.jugadores.set(socket.id, {
      jugadorId: jugador.id,
      nickname: jugador.nickname,
      salaId: payload.salaId,
      color: this.colorAleatorio(),
    });

    const clientes = this.salas.get(payload.salaId) ?? [];
    if (!clientes.some((cliente) => cliente.id === socket.id)) {
      clientes.push(socket);
    }
    this.salas.set(payload.salaId, clientes);

    this.emitirASala(payload.salaId, 'jugadorReconectado', {
      jugadorId: payload.jugadorId,
    });

    await this.emitirEstadoSala(payload.salaId);
  }

  private async emitirEstadoSala(salaId: string): Promise<void> {
    const supabase = this.supabaseService.getCliente();

    const { data: sala } = await supabase
      .from('salas')
      .select('*')
      .eq('id', salaId)
      .maybeSingle();

    this.iniciarRelojSiCorresponde(salaId, sala);

    const { data: jugadores } = await supabase
      .from('jugadores')
      .select('*')
      .eq('sala_id', salaId);

    this.emitirASala(salaId, 'estadoSala', {
      jugadores: jugadores ?? [],
      sala,
      tiempoRestante: this.tiempoRestante(salaId),
      timestamp: Date.now(),
    });
  }

  private tiempoRestante(salaId: string): number | null {
    const partida = this.partidas.get(salaId);

    if (!partida) {
      return null;
    }

    const restante = DURACION_PARTIDA_MS - (Date.now() - partida.inicio);

    return Math.max(0, Math.round(restante / 1000));
  }

  private async verificarVictoria(salaId: string): Promise<void> {
    const supabase = this.supabaseService.getCliente();

    const { data: sala } = await supabase
      .from('salas')
      .select('*')
      .eq('id', salaId)
      .maybeSingle();

    if (!sala || sala.estado !== 'PLAYING') {
      this.detenerReloj(salaId);
      return;
    }

    const { data: jugadores } = await supabase
      .from('jugadores')
      .select('*')
      .eq('sala_id', salaId);

    const lista = jugadores ?? [];

    if (lista.length === 0) {
      return;
    }

    const racha = lista.find(
      (j) => j.respuestas_correctas_seguidas >= RESPUESTAS_PARA_GANAR,
    );

    if (racha) {
      await this.cerrarConGanador(
        salaId,
        racha,
        `${RESPUESTAS_PARA_GANAR} respuestas correctas consecutivas`,
      );
      return;
    }

    const vivos = lista.filter((j) => j.vidas > 0);

    if (vivos.length === 1) {
      await this.cerrarConGanador(salaId, vivos[0], 'Último jugador vivo');
      return;
    }

    const partida = this.partidas.get(salaId);

    if (partida && Date.now() - partida.inicio >= DURACION_PARTIDA_MS) {
      const ganador = await this.ganadorPorPuntaje(salaId, lista);

      if (ganador) {
        await this.cerrarConGanador(
          salaId,
          ganador,
          'Mayor puntaje al agotarse el tiempo',
        );
      }
    }
  }

  private async ganadorPorPuntaje(
    salaId: string,
    jugadores: any[],
  ): Promise<any> {
    const supabase = this.supabaseService.getCliente();

    const { data } = await supabase
      .from('preguntas_respondidas')
      .select('jugador_id')
      .eq('sala_id', salaId);

    const respondidas = new Map<string, number>();

    (data ?? []).forEach((pregunta) => {
      respondidas.set(
        pregunta.jugador_id,
        (respondidas.get(pregunta.jugador_id) ?? 0) + 1,
      );
    });

    const ordenados = [...jugadores].sort((a, b) => {
      if (b.puntaje !== a.puntaje) {
        return b.puntaje - a.puntaje;
      }

      return (respondidas.get(b.id) ?? 0) - (respondidas.get(a.id) ?? 0);
    });

    return ordenados[0];
  }

  private iniciarRelojSiCorresponde(salaId: string, sala: any): void {
    if (!sala || sala.estado !== 'PLAYING' || this.partidas.has(salaId)) {
      return;
    }

    const intervalo = setInterval(() => {
      void this.verificarVictoria(salaId);
    }, 1000);

    this.partidas.set(salaId, { inicio: Date.now(), intervalo });
  }

  private detenerReloj(salaId: string): void {
    const partida = this.partidas.get(salaId);

    if (!partida) {
      return;
    }

    clearInterval(partida.intervalo);
    this.partidas.delete(salaId);
  }

  private async cerrarConGanador(
    salaId: string,
    ganador: any,
    razon: string,
  ): Promise<void> {
    await this.finalizarSala(salaId);

    this.emitirASala(salaId, 'partidaTerminada', {
      ganador: ganador.nickname,
      razon,
      puntajeFinal: ganador.puntaje,
    });
  }

  private async finalizarSala(salaId: string): Promise<void> {
    this.detenerReloj(salaId);

    const supabase = this.supabaseService.getCliente();

    await supabase
      .from('salas')
      .update({
        estado: 'FINISHED',
        finalizado_en: new Date().toISOString(),
      })
      .eq('id', salaId);
  }

  private emitirASala(salaId: string, evento: string, payload: any): void {
    const clientes = this.salas.get(salaId) ?? [];

    clientes.forEach((cliente) => cliente.emit(evento, payload));
  }

  private emitirASalaExcepto(
    salaId: string,
    socketId: string,
    evento: string,
    payload: any,
  ): void {
    const clientes = this.salas.get(salaId) ?? [];

    clientes
      .filter((cliente) => cliente.id !== socketId)
      .forEach((cliente) => cliente.emit(evento, payload));
  }

  private colorAleatorio(): string {
    const color = Math.floor(Math.random() * 0xffffff) + 1;

    return `#${color.toString(16).padStart(6, '0')}`;
  }
}
