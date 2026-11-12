/**
 * Одна камера на переход «QR → экран сканера».
 *
 * getUserMedia вызывается прямо из обработчика нажатия (жест пользователя),
 * затем поток передаётся уже открытому сканеру. Поэтому камера открывается
 * сразу, без второй кнопки. Браузер спрашивает разрешение только пока оно
 * не выдано для сайта.
 */

let pending: MediaStream | null = null;

export async function requestCamera(): Promise<MediaStream | null> {
  try {
    if (!navigator.mediaDevices?.getUserMedia) return null;
    if (pending) return pending;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    pending = stream;
    return stream;
  } catch {
    return null;
  }
}

export function hasPendingCamera(): boolean {
  return pending !== null;
}

export function takeCamera(): MediaStream | null {
  const stream = pending;
  pending = null;
  return stream;
}

export function releaseCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}
