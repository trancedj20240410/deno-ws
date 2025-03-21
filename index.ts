import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

const logcb = (...args: any[]) => console.log.bind(globalThis, ...args);
const errcb = (...args: any[]) => console.error.bind(globalThis, ...args);

const uuid = (Deno.env.get("UUID") || "a530341a-2b1e-4e2f-b196-bf2aca5b755f").replaceAll("-", "");
const port = parseInt(Deno.env.get("PORT") || "30000");

console.log(`WebSocket server is running on :${port}`);

// 使用 Deno 的 HTTP 服务器处理 WebSocket 连接
serve(async (req) => {
  // 检查是否是 WebSocket 请求
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("Hello word", { status: 400 });
  }

  // 创建 WebSocket 连接
  const { socket: ws, response } = Deno.upgradeWebSocket(req);

  // 添加连接打开的处理
  ws.onopen = () => console.log("WebSocket 连接已建立");

  // 处理 WebSocket 消息
  ws.onmessage = async (event) => {
    try {
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
            console.error("WebSocket 到 TCP 转发错误:", error);
            try { conn.close(); } catch {}
            try { 
              if (ws.readyState === 1) {
                ws.close(1011, "数据转发错误"); 
              }
            } catch {}
          }
        };
  
        // 处理 TCP 到 WebSocket 的数据转发
        (async () => {
          const buf = new Uint8Array(8192);
          try {
            while (true) {
              const n = await conn.read(buf);
              if (n === null) {
                console.log("TCP 连接已关闭");
                break;
              }
              if (ws.readyState === 1) { // 确保 WebSocket 仍然开启
                ws.send(buf.slice(0, n));
              } else {
                console.log("WebSocket 已关闭，停止数据转发");
                break;
              }
            }
          } catch (error) {
            console.error("TCP 到 WebSocket 转发错误:", error);
          } finally {
            console.log("关闭 TCP 和 WebSocket 连接");
            try { conn.close(); } catch (e) { console.error("关闭 TCP 连接错误:", e); }
            try { 
              if (ws.readyState === 1) {
                ws.close(); 
              }
            } catch (e) { console.error("关闭 WebSocket 连接错误:", e); }
          }
        })();
      } catch (error) {
        console.error("连接错误:", { host, port: targetPort, error });
        try {
          if (ws.readyState === 1) {
            ws.send(new Uint8Array([VERSION, 1])); // 发送错误状态
            ws.close(1011, `无法连接到 ${host}:${targetPort}`);
          }
        } catch (closeError) {
          console.error("发送错误状态或关闭 WebSocket 时出错:", closeError);
        }
      }
    } catch (error) {
      console.error("WebSocket 消息处理错误:", error);
      try {
        ws.close(1011, "内部服务器错误");
      } catch (closeError) {
        console.error("关闭 WebSocket 时出错:", closeError);
      }
    }
  }; // 添加了缺失的括号
  
    ws.onclose = (event) => {
      console.log(`WebSocket 连接关闭: 代码=${event.code}, 原因='${event.reason}'`);
    };
    
    ws.onerror = (e) => {
      console.error("WebSocket 错误:", e);
      // 尝试优雅地关闭连接
      try {
        if (ws.readyState === 1) { // OPEN
          ws.close(1001, "发生错误，连接关闭");
        }
      } catch (closeError) {
        console.error("尝试关闭错误的 WebSocket 连接时出错:", closeError);
      }
    };

    return response;
}, { port });
