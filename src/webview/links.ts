// Detección de enlaces en el texto de la terminal. Vive aparte de main.ts
// porque es la parte que se puede probar sin un navegador.

/** Un enlace encontrado en una línea lógica de la terminal. */
export interface LinkMatch {
  /** Posición del primer carácter dentro del texto que se analizó. */
  index: number;
  /** Texto tal como aparece en pantalla, ya recortado. */
  text: string;
  /** URL normalizada que se abrirá; siempre http o https. */
  url: string;
}

/**
 * Candidatos a enlace. Se excluyen los espacios, las comillas y los signos que
 * los shells usan para delimitar, para no tragarse el texto de alrededor. Los
 * corchetes solo cuentan dentro del enlace cuando encierran el host, que es como
 * se escribe una IPv6: http://[::1]:3069. En cualquier otro sitio delimitan (un
 * enlace de Markdown, una lista), así que ahí siguen cortando.
 */
const CANDIDATE = /(?:[a-z][a-z0-9+.-]*:\/\/(?:\[[0-9A-Fa-f:.]+\])?|www\.)[^\s"'`<>()[\]{}|\\^]*(?:[(][^\s"'`<>()]*[)])?[^\s"'`<>()[\]{}|\\^]*/gi;

/** Signos que terminan una frase, no una dirección. */
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', '*', '_', '~', "'", '"', '`', '>', '<']);

/**
 * Recorta lo que la línea pegó al final del enlace: la puntuación de la frase y
 * los paréntesis o corchetes que no abrió el propio enlace, como en
 * "mira (https://ejemplo.com)" o en los enlaces de Markdown.
 */
function trimTrailing(value: string): string {
  let out = value;
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (TRAILING.has(last)) {
      out = out.slice(0, -1);
      continue;
    }
    const open = last === ')' ? '(' : last === ']' ? '[' : last === '}' ? '{' : '';
    if (open && count(out, open) < count(out, last)) {
      out = out.slice(0, -1);
      continue;
    }
    break;
  }
  return out;
}

function count(value: string, char: string): number {
  let total = 0;
  for (const c of value) if (c === char) total++;
  return total;
}

/**
 * Convierte el texto en una URL abrible. Lo escribió el programa que corre en
 * la terminal, así que solo pasan http y https con un host de verdad: cualquier
 * otro esquema (file:, vscode:, javascript:) abriría algo del equipo.
 */
export function linkUrl(text: string): string | undefined {
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  // Un host vacío ("https://") no lleva a ninguna parte; localhost y las IP sí.
  if (!url.hostname || url.hostname.endsWith('.')) return undefined;
  return url.toString();
}

/** Todos los enlaces de una línea lógica, en orden de aparición. */
export function findLinks(text: string): LinkMatch[] {
  const found: LinkMatch[] = [];
  CANDIDATE.lastIndex = 0;
  for (let match = CANDIDATE.exec(text); match; match = CANDIDATE.exec(text)) {
    const trimmed = trimTrailing(match[0]);
    if (!trimmed) continue;
    // Deja el cursor justo tras lo que se aceptó: lo recortado puede abrir otro enlace.
    CANDIDATE.lastIndex = match.index + trimmed.length;
    const url = linkUrl(trimmed);
    if (url) found.push({ index: match.index, text: trimmed, url });
  }
  return found;
}
