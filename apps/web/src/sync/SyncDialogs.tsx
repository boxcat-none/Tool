import { Notebook } from "@tool/notes/notebook";
import { exchangeHello, PeerLink, SYNC_PROTOCOL, SyncSession, type Channel, type Hello } from "@tool/notes/sync";
import { useEffect, useRef, useState } from "react";
import type { Library } from "../lib/library";
import { formatBytes } from "../lib/format";
import { syncHub, type Peer } from "./hub";
import { answerInvitation, createInvitation, deviceName, webrtcSupported, type Invitation, type Reply } from "./webrtc";

/**
 * 連線到另一台裝置（技術驗證版）：用「邀請碼／回覆碼」交換連線資訊，裝置之間直接連線（WebRTC）。
 *
 *   邀請方（開著筆記本）：產生邀請碼 → 傳給對方 → 貼上對方的回覆碼 → 連線
 *   加入方（書櫃）：貼上邀請碼 → 產生回覆碼 → 傳回去 → 連線後收到整本筆記本
 */

const hello = (notebookId: string, title: string): Hello => ({
  app: "guganote",
  protocol: SYNC_PROTOCOL,
  notebookId,
  title,
  device: deviceName(),
});

async function copy(text: string, el: HTMLTextAreaElement | null) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 不支援剪貼簿 API（或沒有權限）：選取起來讓使用者自己複製
    el?.focus();
    el?.select();
    return document.execCommand?.("copy") ?? false;
  }
}

function CodeBox({ label, code }: { label: string; code: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <textarea ref={ref} className="sync__code" readOnly value={code} rows={4} onFocus={(e) => e.target.select()} aria-label={label} />
      <span>
        <button type="button" className="btn" onClick={() => void copy(code, ref.current).then(setCopied)}>
          {copied ? "已複製" : "複製"}
        </button>
      </span>
    </div>
  );
}

const unsupported = <p className="note note--error">這個瀏覽器不支援裝置之間直接連線（WebRTC）。請改用 Safari、Chrome 或 Edge。</p>;

const PRIVACY = "連線資料只在兩台裝置之間直接傳送，不經過伺服器。兩台裝置要連在同一個 Wi-Fi。";

// ─────────────────────────────────────────────────────────────

/** 邀請方：在開著的筆記本裡邀請其他裝置 */
export function InviteDialog({
  notebookId,
  title,
  peers,
  presence = {},
  onGoToPage,
  onClose,
}: {
  notebookId: string;
  title: string;
  peers: Peer[];
  /** 每台裝置正在看第幾頁（key = Peer.key） */
  presence?: Record<number, number | undefined>;
  onGoToPage?: (page: number) => void;
  onClose: () => void;
}) {
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<string | null>(null);
  const invRef = useRef<Invitation | null>(null);

  // 關閉視窗時取消還沒完成的邀請
  useEffect(() => () => invRef.current?.cancel(), []);

  const invite = async () => {
    setError(null);
    setJoined(null);
    setBusy("產生邀請碼…");
    try {
      const inv = await createInvitation();
      invRef.current = inv;
      setInvitation(inv);
      setAnswer("");
    } catch (e) {
      setError((e as Error).message || "無法產生邀請碼。");
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    if (!invitation) return;
    setError(null);
    setBusy("連線中…");
    let link: PeerLink | undefined;
    try {
      const channel = await invitation.accept(answer);
      link = new PeerLink(channel);
      const remote = await exchangeHello(link, hello(notebookId, title));
      if (remote.notebookId && remote.notebookId !== notebookId) throw new Error("對方開的是另一本筆記本。");
      syncHub.add(notebookId, link, remote);
      invRef.current = null;
      setInvitation(null);
      setJoined(remote.device);
    } catch (e) {
      link?.close();
      // 回覆碼貼錯時，邀請碼仍然有效，可以重貼
      setError((e as Error).message || "連線失敗。");
      if (link) {
        invRef.current = null;
        setInvitation(null);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="invite-title">
      <div className="notice modal__box sync">
        <div className="notice__title" id="invite-title">連線到其他裝置（測試版）</div>
        {!webrtcSupported() ? unsupported : (
          <>
            <p>讓另一台裝置（例如 iPad 和電腦）同時開這本筆記本，兩邊的修改會即時同步。{PRIVACY}</p>

            {peers.length > 0 && (
              <ul className="sync__peers" aria-label="已連線的裝置">
                {peers.map((p) => (
                  <li key={p.key}>
                    <span className="sync__dot" aria-hidden="true" />已連線：{p.remote.device}
                    {presence[p.key] && (
                      <button type="button" className="link" onClick={() => onGoToPage?.(presence[p.key]!)}>正在看第 {presence[p.key]} 頁</button>
                    )}
                    <button type="button" className="btn btn--small" onClick={() => p.link.close()}>中斷</button>
                  </li>
                ))}
              </ul>
            )}
            {joined && <div className="status status--done" role="status">已連上 {joined}，開始同步。</div>}

            {invitation ? (
              <ol className="sync__steps">
                <li>
                  <CodeBox label="① 把這段邀請碼傳到另一台裝置" code={invitation.code} />
                  <span className="field__hint">例如用 LINE、訊息或 Email 傳過去；在那台裝置的書櫃按「加入其他裝置的筆記本」，貼上邀請碼。</span>
                </li>
                <li>
                  <label className="field">
                    <span className="field__label">② 貼上對方產生的回覆碼</span>
                    <textarea className="sync__code" rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} aria-label="回覆碼" />
                  </label>
                </li>
              </ol>
            ) : null}

            {busy && <div className="status status--busy"><span className="spinner" aria-hidden="true" />{busy}</div>}
            {error && <div className="status status--error" role="alert">{error}</div>}

            <div className="notice__actions">
              {invitation ? (
                <button type="button" className="primary" disabled={!answer.trim() || !!busy} onClick={() => void connect()}>連線</button>
              ) : (
                <button type="button" className="primary" disabled={!!busy} onClick={() => void invite()}>
                  {peers.length ? "再邀請一台裝置" : "邀請另一台裝置"}
                </button>
              )}
              <button type="button" className="btn" onClick={onClose}>{invitation ? "取消" : "關閉"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────

/** 加入方：在書櫃貼上邀請碼，收到整本筆記本後開啟 */
export function JoinDialog({ library, onJoined, onClose }: { library: Library; onJoined: (notebookId: string) => void; onClose: () => void }) {
  const [offer, setOffer] = useState("");
  const [reply, setReply] = useState<Reply | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  const replyRef = useRef<Reply | null>(null);
  const linkRef = useRef<PeerLink | null>(null);

  useEffect(
    () => () => {
      cancelled.current = true;
      replyRef.current?.cancel();
      linkRef.current?.close();
    },
    [],
  );

  const makeReply = async () => {
    setError(null);
    setBusy("產生回覆碼…");
    try {
      const r = await answerInvitation(offer);
      replyRef.current = r;
      setReply(r);
      setBusy("等待對方貼上回覆碼…");
      const channel = await r.connected;
      if (cancelled.current) return channel.close();
      await receive(channel);
    } catch (e) {
      if (cancelled.current) return;
      setBusy(null);
      setReply(null);
      replyRef.current = null;
      linkRef.current?.close();
      linkRef.current = null;
      setError((e as Error).message || "連線失敗。");
    }
  };

  const receive = async (channel: Channel) => {
    const link = new PeerLink(channel);
    linkRef.current = link;
    setBusy("已連線，接收筆記本…");
    const remote = await exchangeHello(link, hello("", ""));
    if (!remote.notebookId) throw new Error("對方沒有開啟筆記本。");

    if (!(await library.get(remote.notebookId))) {
      // 新的筆記本：先收完內容與原始檔，再加入書櫃
      const nb = new Notebook();
      const session = new SyncSession(link, nb, library.blobs, {
        onProgress: (p) => p.total && setBusy(`接收檔案… ${formatBytes(p.received)} / ${formatBytes(p.total)}`),
      });
      const offClose = link.onClose(() => !cancelled.current && setError("連線已中斷。"));
      await session.synced;
      const missing = await session.whenFilesReady();
      session.close();
      offClose();
      if (link.closed) throw new Error("連線已中斷。");
      if (missing.length) throw new Error("對方的筆記本缺少原始檔案，無法開啟。");
      const added = await library.add(nb, { title: nb.title, pageCount: nb.pageIds.length, fileIds: nb.usedFileIds });
      added.close();
    }
    // 已經有這本筆記本（之前同步過）：直接開啟，連線後自動補上雙方的修改
    if (cancelled.current) return;
    syncHub.add(remote.notebookId, link, remote);
    // 連線交給筆記本畫面，關閉這個視窗時不要中斷
    linkRef.current = null;
    replyRef.current = null;
    onJoined(remote.notebookId);
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="join-title">
      <div className="notice modal__box sync">
        <div className="notice__title" id="join-title">加入其他裝置的筆記本（測試版）</div>
        {!webrtcSupported() ? unsupported : (
          <>
            <p>在另一台裝置開啟筆記本，按「連線」→「邀請另一台裝置」取得邀請碼。{PRIVACY}</p>
            <ol className="sync__steps">
              <li>
                <label className="field">
                  <span className="field__label">① 貼上邀請碼</span>
                  <textarea className="sync__code" rows={3} value={offer} readOnly={!!reply} onChange={(e) => setOffer(e.target.value)} aria-label="邀請碼" />
                </label>
              </li>
              {reply && (
                <li>
                  <CodeBox label="② 把這段回覆碼傳回邀請的裝置貼上" code={reply.code} />
                </li>
              )}
            </ol>
            {busy && <div className="status status--busy" role="status"><span className="spinner" aria-hidden="true" />{busy}</div>}
            {error && <div className="status status--error" role="alert">{error}</div>}
            <div className="notice__actions">
              {!reply && (
                <button type="button" className="primary" disabled={!offer.trim() || !!busy} onClick={() => void makeReply()}>產生回覆碼</button>
              )}
              <button type="button" className="btn" onClick={onClose}>取消</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
