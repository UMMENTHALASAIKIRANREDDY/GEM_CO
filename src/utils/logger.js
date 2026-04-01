/**
 * Structured logger — metadata only.
 * NEVER logs conversation content, prompts, responses, or credentials.
 */
export function getLogger(name) {
  const prefix = `[${name}]`;

  const format = (level, msg) => {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    return `${ts}  ${level.padEnd(5)}  ${prefix}  ${msg}`;
  };

  return {
    info:  msg => console.error(format('INFO',  msg)),
    warn:  msg => console.error(format('WARN',  msg)),
    error: msg => console.error(format('ERROR', msg))
  };
}
