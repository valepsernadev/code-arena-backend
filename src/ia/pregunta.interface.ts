export interface Pregunta {
  enunciado: string;
  opciones: string[];
  respuestaCorrecta: number;
  dificultad: 'fácil' | 'media' | 'difícil';
}

export function validarPregunta(obj: any): obj is Pregunta {
  if (typeof obj.enunciado !== 'string') return false;
  if (obj.enunciado.length < 10 || obj.enunciado.length > 500) return false;
  if (!Array.isArray(obj.opciones) || obj.opciones.length !== 4) return false;
  if (
    !obj.opciones.every(
      (o: any) => typeof o === 'string' && o.length >= 2 && o.length <= 100,
    )
  )
    return false;
  if (
    typeof obj.respuestaCorrecta !== 'number' ||
    obj.respuestaCorrecta < 0 ||
    obj.respuestaCorrecta > 3
  )
    return false;
  if (!Number.isInteger(obj.respuestaCorrecta)) return false;
  if (!['fácil', 'media', 'difícil'].includes(obj.dificultad)) return false;
  return true;
}
