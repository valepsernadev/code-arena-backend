import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { Pregunta, validarPregunta } from './pregunta.interface';

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';
const TIMEOUT_MS = 10000;
const MAX_INTENTOS = 3;

const PREGUNTA_RESPALDO: Pregunta = {
  enunciado:
    '¿Cuál de los siguientes es un principio fundamental de la programación orientada a objetos?',
  opciones: [
    'A) Encapsulamiento',
    'B) Compilación',
    'C) Indexación',
    'D) Serialización',
  ],
  respuestaCorrecta: 0,
  dificultad: 'fácil',
};

@Injectable()
export class IaService {
  private readonly logger = new Logger(IaService.name);

  constructor(private readonly configService: ConfigService) {}

  async generarPregunta(tema: string): Promise<Pregunta> {
    const apiKey = this.configService.get<string>('DEEPSEEK_API_KEY');

    for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
      try {
        const { data } = await axios.post(
          DEEPSEEK_URL,
          {
            model: DEEPSEEK_MODEL,
            messages: [
              { role: 'user', content: this.construirPrompt(tema) },
            ],
            temperature: 0.7,
            max_tokens: 500,
            top_p: 0.95,
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: TIMEOUT_MS,
          },
        );

        const contenido = data?.choices?.[0]?.message?.content;
        const parseada = JSON.parse(contenido);

        if (validarPregunta(parseada)) {
          return parseada;
        }

        this.logger.warn(
          `Intento ${intento}: la pregunta no paso la validacion de formato`,
        );
      } catch (error) {
        this.logger.warn(`Intento ${intento}: fallo la llamada a DeepSeek`);
      }

      if (intento < MAX_INTENTOS) {
        await this.esperar(Math.pow(2, intento) * 1000);
      }
    }

    this.logger.warn('Se agotaron los intentos: se usa la pregunta de respaldo');

    return PREGUNTA_RESPALDO;
  }

  private construirPrompt(tema: string): string {
    return `Tema: ${tema}

Genera UNA pregunta de opción múltiple sobre ${tema} para desarrolladores de software.

REQUISITOS:
- El enunciado debe ser claro y técnicamente exacto
- Debe haber exactamente 4 opciones (A, B, C, D)
- Exactamente UNA opción es correcta
- La dificultad debe ser realista

RESPONDE SOLO EN ESTE FORMATO JSON (sin markdown, sin código):
{
  "enunciado": "¿Cuál es...",
  "opciones": [
    "A) Primera opción",
    "B) Segunda opción",
    "C) Tercera opción",
    "D) Cuarta opción"
  ],
  "respuestaCorrecta": 0,
  "dificultad": "media"
}

NOTAS:
- respuestaCorrecta es el ÍNDICE (0-3), no la letra
- dificultad puede ser "fácil", "media" o "difícil"
- NO incluyas explicaciones, SOLO JSON`;
  }

  private esperar(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
