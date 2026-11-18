// Reads a line from the terminal without showing what's typed.
export function askHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stderr.write(question);
    input.setRawMode(true); input.resume(); input.setEncoding('utf8');
    let value = '';
    const done = result => { input.setRawMode(false); input.pause(); input.off('data', onData); process.stderr.write('\n'); result instanceof Error ? reject(result) : resolve(result); };
    const onData = chunk => {
      // Ignore bracketed-paste markers some terminals add around pasted text.
      chunk = chunk.replace(/\x1b\[20[01]~/g, '');
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(value);
        if (ch === '\u0003') return done(new Error('Cancelled.'));           // Ctrl+C
        if (ch === '\u007f' || ch === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (ch >= ' ') value += ch;
      }
    };
    input.on('data', onData);
  });
}
export async function readPipedLine() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.split(/\r?\n/)[0];
}
