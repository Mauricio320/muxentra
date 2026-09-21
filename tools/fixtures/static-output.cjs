// No lee archivos ni usa red. Cierra solo este proceso al recibir Ctrl+C.
for (let i = 0; i < 1000; i++) console.log(`PTY-ROW-${i}`);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', data => { if (data.includes(3)) process.exit(0); });
process.stdin.resume();
