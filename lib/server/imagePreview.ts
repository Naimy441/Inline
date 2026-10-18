import { imageSize } from "@/lib/doc/docx";
import { resizedSize } from "@/lib/server/imageTokens";
import { decodePng, encodePng, PngError, shrinkBitmap } from "@/lib/server/png";

export type ImagePreview = { data: Uint8Array; mime: string; text: string; image: boolean };

/**
 * A picture for the model to look at before it is placed. Files that already
 * fit the standard visual-token cap are unchanged. A larger PNG is scaled
 * down; the file on disk is not. The page screenshot stays a separate,
 * full capture.
 */
export function imagePreview(path: string, data: Uint8Array, mime: string): ImagePreview {
  const size = imageSize(data);
  const bytes = `${data.byteLength} bytes`;
  if (!size) return { data, mime, image: true, text: `${path} (${mime}, ${bytes}).` };
  const [width, height] = resizedSize(size.width, size.height);
  if (width === size.width && height === size.height) return { data, mime, image: true, text: `${path} (${mime}, ${bytes}).` };
  if (mime === "image/png") {
    try {
      const shrunk = shrinkBitmap(decodePng(data), width, height);
      return {
        data: encodePng(shrunk),
        mime: "image/png",
        image: true,
        text: `${path}: downscaled preview, ${size.width}×${size.height} to ${shrunk.width}×${shrunk.height} (${bytes} on disk, unchanged). This is a look before placement. After the figure is on the page, screenshot_page is the picture; do not read this file again.`,
      };
    } catch (error) {
      if (!(error instanceof PngError)) throw error;
    }
  }
  return {
    data,
    mime,
    image: false,
    text: `${path} is ${size.width}×${size.height} (${mime}, ${bytes}), larger than a preview, and was not added to the transcript. Place it and use screenshot_page to see it. The file on disk is unchanged.`,
  };
}
