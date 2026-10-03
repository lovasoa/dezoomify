// Native transport tests need deliberately malformed HTTP and connection reuse.
// Node owns sockets; the Rust test supplies response bytes over JSON-line stdio.
import net from "node:net";
import readline from "node:readline";

const sockets = new Map();
let connection = 0;
let request = 0;
const server = net.createServer((socket) => {
  const id = ++connection;
  let buffer = Buffer.alloc(0);
  socket.on("error", () => {}); // Cancellation may close a pending response.
  socket.on("data", (bytes) => {
    buffer = Buffer.concat([buffer, bytes]);
    for (;;) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) break;
      const head = buffer.subarray(0, end + 4).toString();
      const length = Number(head.match(/\r\ncontent-length:\s*(\d+)/i)?.[1] ?? 0);
      if (buffer.length < end + 4 + length) break;
      buffer = buffer.subarray(end + 4 + length);
      const rid = ++request;
      sockets.set(rid, socket);
      process.stdout.write(
        `${JSON.stringify({ id: rid, connection: id, head, path: head.split(" ")[1] })}\n`,
      );
    }
  });
  socket.on("close", () => {
    for (const [rid, pending] of sockets) if (pending === socket) sockets.delete(rid);
  });
});
const host = process.argv[2] ?? "127.0.0.1";
if (!/^127\.0\.0\.[12]$/.test(host)) throw new Error("loopback only");
server.listen(0, host, () =>
  process.stdout.write(
    `${JSON.stringify({ origin: `http://${host}:${server.address().port}` })}\n`,
  ),
);
readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const { id, bytes, close } = JSON.parse(line);
    const socket = sockets.get(id);
    sockets.delete(id);
    if (!socket || socket.destroyed) return;
    const response = Buffer.from(bytes, "base64");
    if (close) socket.end(response);
    else socket.write(response);
  })
  .on("close", () => process.exit(0));
