import assert from 'node:assert/strict';
import { findLinks, linkUrl } from '../src/webview/links.ts';

const only = text => findLinks(text).map(link => link.text);

// Detección básica, con y sin esquema.
assert.deepEqual(only('abre https://ejemplo.com/a?b=1#c ya'), ['https://ejemplo.com/a?b=1#c']);
assert.deepEqual(only('mira www.ejemplo.com'), ['www.ejemplo.com']);
assert.equal(findLinks('mira www.ejemplo.com')[0].url, 'https://www.ejemplo.com/');
assert.deepEqual(only('sirviendo en http://localhost:3000/ok'), ['http://localhost:3000/ok']);
assert.deepEqual(only('http://127.0.0.1:8080/'), ['http://127.0.0.1:8080/']);

// IPv6 entre corchetes: así imprimen su dirección los servidores de desarrollo.
assert.deepEqual(only('sirviendo en http://[::1]:3069 ya'), ['http://[::1]:3069']);
assert.equal(findLinks('http://[::1]:3069')[0].url, 'http://[::1]:3069/');
assert.deepEqual(only('http://[::1]:3069/a/b?x=1'), ['http://[::1]:3069/a/b?x=1']);
assert.deepEqual(only('http://[2001:db8::8a2e:370:7334]:8080/p'), ['http://[2001:db8::8a2e:370:7334]:8080/p']);
assert.deepEqual(only('ver http://[::1]:3069.'), ['http://[::1]:3069']);
assert.deepEqual(only('(http://[::1]:3069)'), ['http://[::1]:3069']);
// Fuera del host los corchetes siguen delimitando.
assert.deepEqual(only('lista: [1] https://ejemplo.com'), ['https://ejemplo.com']);
assert.deepEqual(only('sin enlaces aquí'), []);

// Puntuación y delimitadores que pega la línea, no el enlace.
assert.deepEqual(only('ver https://ejemplo.com.'), ['https://ejemplo.com']);
assert.deepEqual(only('ver (https://ejemplo.com), gracias'), ['https://ejemplo.com']);
assert.deepEqual(only('[texto](https://ejemplo.com/a)'), ['https://ejemplo.com/a']);
assert.deepEqual(only('cita "https://ejemplo.com/a" fin'), ['https://ejemplo.com/a']);
assert.deepEqual(only('**https://ejemplo.com**'), ['https://ejemplo.com']);
// Los paréntesis que abre el propio enlace se conservan.
assert.deepEqual(only('https://es.wikipedia.org/wiki/Fa_(nota)'), ['https://es.wikipedia.org/wiki/Fa_(nota)']);

// Varios en la misma línea, en orden y con su posición.
const dos = findLinks('a https://uno.com b https://dos.com c');
assert.deepEqual(dos.map(l => l.text), ['https://uno.com', 'https://dos.com']);
assert.equal(dos[0].index, 2);
assert.equal(dos[1].index, 20);

// Solo http y https llegan al navegador.
assert.equal(linkUrl('file:///c:/Users/yo/secreto.txt'), undefined);
assert.equal(linkUrl('vscode://ext/instalar'), undefined);
assert.equal(linkUrl('javascript://x.com/%0aalert(1)'), undefined);
assert.equal(linkUrl('http://ejemplo.com/a'), 'http://ejemplo.com/a');
assert.equal(linkUrl('https://ejemplo.com'), 'https://ejemplo.com/');
// Sin host no se abre nada.
assert.equal(linkUrl('https://'), undefined);
assert.deepEqual(only('esquemas file:///c/x vscode://y javascript:alert(1)'), []);

console.log('PASS: enlaces con y sin esquema, IPv6 entre corchetes, puntuación recortada, varios por línea y esquemas no http descartados');
