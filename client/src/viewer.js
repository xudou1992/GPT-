import { state } from './state.js';
import { imageViewer, viewerImage, viewerTitle, viewerMeta, viewerCopy, viewerDownload, viewerPrev, viewerNext } from './dom.js';

export function openViewer(url) {
  const index = state.currentImages.findIndex(image => image.url === url);
  state.viewerIndex = Math.max(0, index);
  updateViewer();
  imageViewer.hidden = false;
  document.body.classList.add('viewer-open');
}

export function closeViewer() {
  imageViewer.hidden = true;
  document.body.classList.remove('viewer-open');
}

export function stepViewer(delta) {
  if (!state.currentImages.length) return;
  state.viewerIndex = (state.viewerIndex + delta + state.currentImages.length) % state.currentImages.length;
  updateViewer();
}

function updateViewer() {
  const image = state.currentImages[state.viewerIndex];
  if (!image) return;
  const absoluteUrl = new URL(image.url, window.location.href).href;
  viewerImage.src = image.url;
  viewerImage.alt = image.filename || '生成图片预览';
  viewerTitle.textContent = image.filename || '图片预览';
  const viewerPrompt = document.querySelector('#viewerPrompt');
  if (viewerPrompt) viewerPrompt.textContent = image.prompt || '';
  viewerMeta.textContent = `${state.viewerIndex + 1} / ${state.currentImages.length} · ${image.model || ''} · ${image.size || ''}`;
  viewerCopy.dataset.copyUrl = absoluteUrl;
  viewerCopy.textContent = '复制链接';
  viewerDownload.href = image.url;
  viewerDownload.download = image.filename || 'image.png';
  viewerPrev.disabled = state.currentImages.length <= 1;
  viewerNext.disabled = state.currentImages.length <= 1;
}
