import type { Channel } from "@tool/notes/sync";
import { deflateSync, inflateSync } from "fflate";

/**
 * 區網連線：WebRTC DataChannel（裝置之間直接連線，資料不經過伺服器）。
 *
 * 為什麼不用 WebSocket：網頁版放在 https 網址，瀏覽器不准 https 頁面連 ws:// 的區網位址（混合內容；
 * Chrome 另外要「區域網路存取」權限），iPad Safari 完全擋掉。WebRTC 不受這個限制，
 * 而且同一個 Wi-Fi 下會直接走區網（用 mDNS 的 .local 名稱找到對方）。
 *
 * 建立連線前，雙方要交換一次連線資訊（SDP）。目前（技術驗證）用「邀請碼／回覆碼」手動交換，
 * 完全不需要網路伺服器；之後可以換成配對伺服器自動交換（見 docs/w7-lan-spike.md）。
 */

const CODE_PREFIX = "GN1";
/** 收集連線位址最多等多久（區網的位址通常幾十毫秒就收集完） */
const GATHER_TIMEOUT = 3000;
/** 收到位址後多久沒有新的位址就當作收集完 */
const GATHER_QUIET = 400;

function toBase64Url(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string) {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

type Kind = "offer" | "answer";

export function encodeCode(kind: Kind, sdp: string): string {
  const body = deflateSync(new TextEncoder().encode(sdp), { level: 9 });
  return `${CODE_PREFIX}${kind === "offer" ? "o" : "a"}${toBase64Url(body)}`;
}

export function decodeCode(code: string, expected: Kind): string {
  const text = code.replace(/\s+/g, "");
  if (!text.startsWith(CODE_PREFIX)) throw new Error("這不是連線碼，請確認複製完整。");
  const kind = text[CODE_PREFIX.length];
  if (kind !== (expected === "offer" ? "o" : "a")) {
    throw new Error(expected === "offer" ? "這是「回覆碼」，請貼上另一台裝置的「邀請碼」。" : "這是「邀請碼」，請貼上另一台裝置產生的「回覆碼」。");
  }
  try {
    return new TextDecoder().decode(inflateSync(fromBase64Url(text.slice(CODE_PREFIX.length + 1))));
  } catch {
    throw new Error("連線碼不完整，請重新複製。");
  }
}

/**
 * 等收集完本機的連線位址（不用逐一傳送，一次放進連線碼）。
 * 有些環境的瀏覽器一直不回報「收集完成」，所以收到位址後安靜一小段時間就當作完成。
 */
function gathered(pc: RTCPeerConnection): Promise<string> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(quiet);
      clearTimeout(limit);
      resolve(pc.localDescription!.sdp);
    };
    if (pc.iceGatheringState === "complete") return done();
    const limit = setTimeout(done, GATHER_TIMEOUT);
    pc.addEventListener("icecandidate", (e) => {
      if (!e.candidate) return done();
      clearTimeout(quiet);
      quiet = setTimeout(done, GATHER_QUIET);
    });
    pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && done());
  });
}

/** 把 RTCDataChannel 包成同步協定用的 Channel */
function wrap(pc: RTCPeerConnection, dc: RTCDataChannel): Channel {
  dc.binaryType = "arraybuffer";
  dc.bufferedAmountLowThreshold = 256 * 1024;
  const closers = new Set<() => void>();
  let closed = false;
  const fireClose = () => {
    if (closed) return;
    closed = true;
    closers.forEach((c) => c());
    pc.close();
  };
  dc.addEventListener("close", fireClose);
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") fireClose();
  });
  return {
    send(data) {
      if (dc.readyState === "open") dc.send(data as Uint8Array<ArrayBuffer>);
    },
    get bufferedAmount() {
      return dc.bufferedAmount;
    },
    waitDrain() {
      return new Promise<void>((resolve) => {
        if (dc.bufferedAmount <= dc.bufferedAmountLowThreshold || dc.readyState !== "open") return resolve();
        const done = () => {
          dc.removeEventListener("bufferedamountlow", done);
          dc.removeEventListener("close", done);
          resolve();
        };
        dc.addEventListener("bufferedamountlow", done);
        dc.addEventListener("close", done);
      });
    },
    onMessage(cb) {
      const handler = (e: MessageEvent) => cb(new Uint8Array(e.data as ArrayBuffer));
      dc.addEventListener("message", handler);
      return () => dc.removeEventListener("message", handler);
    },
    onClose(cb) {
      closers.add(cb);
      return () => closers.delete(cb);
    },
    close() {
      dc.close();
      fireClose();
    },
  };
}

function opened(pc: RTCPeerConnection, dc: RTCDataChannel, timeoutMs: number): Promise<Channel> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pc.close();
      reject(new Error("連不上另一台裝置。請確認兩台裝置連在同一個 Wi-Fi，而且連線碼沒有過期。"));
    }, timeoutMs);
    const ok = () => {
      clearTimeout(timer);
      resolve(wrap(pc, dc));
    };
    if (dc.readyState === "open") return ok();
    dc.addEventListener("open", ok, { once: true });
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed") {
        clearTimeout(timer);
        pc.close();
        reject(new Error("連不上另一台裝置。請確認兩台裝置連在同一個 Wi-Fi（有些公司、學校、飯店的 Wi-Fi 不允許裝置互連）。"));
      }
    });
  });
}

export function webrtcSupported(): boolean {
  return typeof RTCPeerConnection !== "undefined";
}

/** 不設定 STUN／TURN：只走區網，不需要網路，也不會把位址送到外面的伺服器 */
const RTC_CONFIG: RTCConfiguration = { iceServers: [] };

export interface Invitation {
  code: string;
  /** 貼上對方的回覆碼後開始連線 */
  accept(answerCode: string, timeoutMs?: number): Promise<Channel>;
  cancel(): void;
}

/** 邀請方：產生邀請碼 */
export async function createInvitation(): Promise<Invitation> {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const dc = pc.createDataChannel("guganote", { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  const code = encodeCode("offer", await gathered(pc));
  return {
    code,
    async accept(answerCode, timeoutMs = 20000) {
      const sdp = decodeCode(answerCode, "answer");
      await pc.setRemoteDescription({ type: "answer", sdp });
      return opened(pc, dc, timeoutMs);
    },
    cancel: () => pc.close(),
  };
}

export interface Reply {
  code: string;
  /** 邀請方貼上回覆碼後完成連線 */
  connected: Promise<Channel>;
  cancel(): void;
}

/** 加入方：貼上邀請碼，產生回覆碼 */
export async function answerInvitation(offerCode: string, timeoutMs = 5 * 60 * 1000): Promise<Reply> {
  const sdp = decodeCode(offerCode, "offer");
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const channel = new Promise<RTCDataChannel>((resolve) => pc.addEventListener("datachannel", (e) => resolve(e.channel), { once: true }));
  await pc.setRemoteDescription({ type: "offer", sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  const code = encodeCode("answer", await gathered(pc));
  return {
    code,
    connected: channel.then((dc) => opened(pc, dc, timeoutMs)),
    cancel: () => pc.close(),
  };
}

/** 給對方看的裝置名稱 */
export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Android 裝置";
  if (/Windows/.test(ua)) return "Windows 電腦";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Linux/.test(ua)) return "Linux 電腦";
  return "另一台裝置";
}
