// Camera access with friendly error messages.
export async function startCamera(video, { facingMode = 'user' } = {}) {
  if (!window.isSecureContext) {
    throw new Error('The camera only works on https:// pages or on localhost.');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser does not support camera access.');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (err) {
    const messages = {
      NotAllowedError: 'Camera permission was denied. Allow camera access in your browser, or upload a photo instead.',
      SecurityError: 'Camera access is blocked on this page. Upload a photo instead.',
      NotFoundError: 'No camera was found. Upload a photo instead.',
      OverconstrainedError: 'Your camera does not support the requested mode.',
      NotReadableError: 'Your camera is being used by another app.',
    };
    throw new Error(messages[err?.name] || `Could not start the camera (${err?.message || err}).`);
  }
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  if (!video.videoWidth) {
    await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
  }
  return stream;
}

export function stopCamera(video) {
  const stream = video.srcObject;
  if (stream) for (const track of stream.getTracks()) track.stop();
  video.srcObject = null;
}
