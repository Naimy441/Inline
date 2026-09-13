import { PAGE_CONTENT_HEIGHT, PAGE_CONTENT_WIDTH } from "@/lib/pagination";

export const IMAGE_CLASS = "doc-image";
const HANDLES = ["nw", "ne", "sw", "se"] as const;

export function createImageElement(src: string): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = IMAGE_CLASS;
  wrap.contentEditable = "false";
  const img = document.createElement("img");
  img.src = src;
  img.alt = "Inserted image";
  img.draggable = false;
  wrap.appendChild(img);
  addHandles(wrap);
  return wrap;
}

export function constrainImage(img: HTMLImageElement) {
  const naturalW = img.naturalWidth || img.width;
  const naturalH = img.naturalHeight || img.height;
  if (!naturalW || !naturalH) return;

  const maxW = PAGE_CONTENT_WIDTH;
  const maxH = PAGE_CONTENT_HEIGHT;
  const styled = parseFloat(img.style.width);
  const width = Number.isFinite(styled) && styled > 0 ? styled : Math.min(naturalW, maxW);
  const height = (naturalH / naturalW) * width;
  const scale = Math.min(1, maxW / width, maxH / height);
  img.style.width = `${Math.max(48, Math.round(width * scale))}px`;
  img.style.height = "auto";
  img.style.maxWidth = "100%";
}

export function normalizeImages(root: HTMLElement) {
  root.querySelectorAll("img").forEach((img) => {
    const existing = img.closest(`.${IMAGE_CLASS}`);
    if (existing instanceof HTMLElement) {
      existing.contentEditable = "false";
      img.draggable = false;
      if (!existing.querySelector(".img-handle")) addHandles(existing);
      if (img.complete) constrainImage(img);
      else img.addEventListener("load", () => constrainImage(img), { once: true });
      return;
    }

    const wrap = document.createElement("div");
    wrap.className = IMAGE_CLASS;
    wrap.contentEditable = "false";
    img.replaceWith(wrap);
    wrap.appendChild(img);
    img.draggable = false;
    addHandles(wrap);
    if (img.complete) constrainImage(img);
    else img.addEventListener("load", () => constrainImage(img), { once: true });
  });
}

export function selectedImage(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(`.${IMAGE_CLASS}.is-selected`);
}

export function selectImage(root: HTMLElement, wrap: HTMLElement | null) {
  root.querySelectorAll(`.${IMAGE_CLASS}`).forEach((node) => {
    node.classList.toggle("is-selected", node === wrap);
  });
}

function addHandles(wrap: HTMLElement) {
  for (const handle of HANDLES) {
    const el = document.createElement("span");
    el.className = "img-handle";
    el.dataset.handle = handle;
    wrap.appendChild(el);
  }
}
