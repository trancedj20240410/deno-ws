import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

const logcb = (...args: any[]) => console.log.bind(globalThis, ...args);
const errcb = (...args: any[]) => console.error.bind(globalThis, ...args);

const uuid = (Deno.env.get("UUID") || "d82aae53-a582-4d7b-889a-60ea535f3219").replaceAll("-", "");
const port = parseInt(Deno.env.get("PORT") || "30000");

console.log(`WebSocket server is running on :${port}`);

// 使用 Deno 的 HTTP 服务器处理 WebSocket 连接
serve(async (req) => {
  // 检查是否是 WebSocket 请求
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("请使用 WebSocket 连接", { status: 400 });
  }

  // 创建 WebSocket 连接
  const { socket: ws, response } = Deno.upgradeWebSocket(req);

  // 处理 WebSocket 消息
  ws.onmessage = async (event) => {
    // 确保数据是 Uint8Array
    const msg = event.data instanceof ArrayBuffer 
      ? new Uint8Array(event.data) 
      : typeof event.data === "string" 
        ? new TextEncoder().encode(event.data)
        : event.data;
    
    const [VERSION] = msg;
    const id = msg.slice(1, 17);
    if (!id.every((v, i) => v == parseInt(uuid.substr(i * 2, 2), 16))) return;
    
    let i = msg[17] + 19;
    const targetPort = (msg[i] << 8) | msg[i + 1];
    i += 2;
    const ATYP = msg[i++];
    
    let host = "";
    if (ATYP == 1) {
      // IPv4
      host = Array.from(msg.slice(i, i + 4)).join(".");
      i += 4;
    } else if (ATYP == 2) {
      // Domain
      const len = msg[i];
      host = new TextDecoder().decode(msg.slice(i + 1, i + 1 + len));
      i += len + 1;
    } else if (ATYP == 3) {
      // IPv6
      host = Array.from(msg.slice(i, i + 16))
        .reduce((s: number[][], b, i, a) => (i % 2 ? s : [...s, [a[i], a[i + 1]]]), [])
        .map(pair => ((pair[0] << 8) | pair[1]).toString(16))
        .join(":");
      i += 16;
    }

    console.log(`连接到: ${host}:${targetPort}`);
    ws.send(new Uint8Array([VERSION, 0]));

    try {
      const conn = await Deno.connect({ hostname: host, port: targetPort });
      
      // 发送初始数据
      await conn.write(msg.slice(i));
      
      // 处理 WebSocket 到 TCP 的数据转发
      ws.onmessage = async (e) => {
        try {
          const data = e.data instanceof ArrayBuffer 
            ? new Uint8Array(e.data) 
            : typeof e.data === "string" 
              ? new TextEncoder().encode(e.data)
              : e.data;
          await conn.write(data);
        } catch (error) {
          console.error("E1:", error);
        }
      };

      // 处理 TCP 到 WebSocket 的数据转发
      (async () => {
        const buf = new Uint8Array(8192);
        try {
          while (true) {
            const n = await conn.read(buf);
            if (n === null) break;
            ws.send(buf.slice(0, n));
          }
        } catch (error) {
          console.error("E2:", error);
        } finally {
          try { conn.close(); } catch {}
          try { ws.close(); } catch {}
        }
      })();
    } catch (error) {
      console.error("连接错误:", { host, port: targetPort, error });
    }
  };

  ws.onclose = () => console.log("WebSocket 连接关闭");
  ws.onerror = (e) => console.error("WebSocket 错误:", e);

  return response;
}, { port });