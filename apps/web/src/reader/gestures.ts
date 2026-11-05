/**
 * 觸控手勢（iPad 等觸控螢幕）：兩指縮放與兩指平移。
 *
 * - 一指：閱讀模式下由瀏覽器原生捲動；畫筆模式＋「只用觸控筆」時也是原生捲動（書寫層設定 touch-action: pan-x pan-y）
 * - 兩指：由這裡處理，交給 pdf.js 的 updateScale。縮放過程中 pdf.js 先用 CSS 放大（drawingDelay），
 *   停下來後才重新繪製，所以手勢很順
 * - Apple Pencil（touchType = "stylus"）不參與手勢，交給書寫層
 *
 * 同時擋掉 Safari 的整頁縮放（gesturestart），避免連工具列一起被放大。
 */

interface ScalableViewer {
  currentScale: number;
  updateScale(options: { drawingDelay?: number; scaleFactor?: number; origin?: number[]; pan?: number[] }): void;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
/** 停止縮放多久後重新繪製（毫秒） */
const REDRAW_DELAY = 300;

function fingers(list: TouchList): Touch[] {
  // iPadOS 的 Apple Pencil 觸控 touchType 為 "stylus"
  return Array.from(list).filter((t) => (t as Touch & { touchType?: string }).touchType !== "stylus");
}

export function attachTouchGestures(
  container: HTMLElement,
  getViewer: () => ScalableViewer | undefined,
  { onPinchStart }: { onPinchStart?: () => void } = {},
): () => void {
  let pinch: { startDist: number; startScale: number; lastMid: [number, number] } | null = null;
  /**
   * 觸控事件永遠送到「手指一開始碰到的元素」。縮放時 pdf.js 會移除、重建頁面裡的元素，
   * 被移除的元素收到的事件不會再傳到容器，所以縮放開始時也直接在那些元素上監聽。
   */
  let targets: EventTarget[] = [];
  const handled = new WeakSet<Event>();

  const measure = (a: Touch, b: Touch) => ({
    dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
    mid: [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2] as [number, number],
  });

  const onStart = (e: TouchEvent) => {
    const f = fingers(e.touches);
    if (f.length === 2 && getViewer()) {
      e.preventDefault();
      const { dist, mid } = measure(f[0], f[1]);
      pinch = { startDist: Math.max(dist, 1), startScale: getViewer()!.currentScale, lastMid: mid };
      watchTargets(f.map((t) => t.target));
      onPinchStart?.();
    }
  };

  const watchTargets = (list: EventTarget[]) => {
    for (const t of list) {
      if (targets.includes(t) || t === container) continue;
      t.addEventListener("touchmove", onMove as EventListener, { passive: false });
      t.addEventListener("touchend", onEnd as EventListener);
      t.addEventListener("touchcancel", onEnd as EventListener);
      targets.push(t);
    }
  };

  const unwatchTargets = () => {
    for (const t of targets) {
      t.removeEventListener("touchmove", onMove as EventListener);
      t.removeEventListener("touchend", onEnd as EventListener);
      t.removeEventListener("touchcancel", onEnd as EventListener);
    }
    targets = [];
  };

  const onMove = (e: TouchEvent) => {
    if (!pinch || handled.has(e)) return;
    handled.add(e);
    const f = fingers(e.touches);
    const viewer = getViewer();
    if (f.length < 2 || !viewer) return;
    e.preventDefault();
    const { dist, mid } = measure(f[0], f[1]);
    const pan = [mid[0] - pinch.lastMid[0], mid[1] - pinch.lastMid[1]];
    pinch.lastMid = mid;
    const target = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (pinch.startScale * dist) / pinch.startDist));
    // pdf.js 會把縮放比例四捨五入到 0.01，變化太小時只平移
    if (Math.abs(target - viewer.currentScale) >= 0.01) {
      viewer.updateScale({ drawingDelay: REDRAW_DELAY, scaleFactor: target / viewer.currentScale, origin: mid, pan });
    } else if (pan[0] || pan[1]) {
      container.scrollLeft -= pan[0];
      container.scrollTop -= pan[1];
    }
  };

  const onEnd = (e: TouchEvent) => {
    if (pinch && fingers(e.touches).length < 2) {
      pinch = null;
      unwatchTargets();
    }
  };

  // Safari 的整頁縮放手勢
  const onGesture = (e: Event) => e.preventDefault();

  // capture：手指放在書寫層上時也能收到
  container.addEventListener("touchstart", onStart, { passive: false, capture: true });
  container.addEventListener("touchmove", onMove, { passive: false, capture: true });
  container.addEventListener("touchend", onEnd, { capture: true });
  container.addEventListener("touchcancel", onEnd, { capture: true });
  container.addEventListener("gesturestart", onGesture);
  container.addEventListener("gesturechange", onGesture);
  return () => {
    unwatchTargets();
    container.removeEventListener("touchstart", onStart, { capture: true });
    container.removeEventListener("touchmove", onMove, { capture: true });
    container.removeEventListener("touchend", onEnd, { capture: true });
    container.removeEventListener("touchcancel", onEnd, { capture: true });
    container.removeEventListener("gesturestart", onGesture);
    container.removeEventListener("gesturechange", onGesture);
  };
}
