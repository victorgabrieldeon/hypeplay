/**
 * Is the page drawn without the graphics card? Discord's own "Hardware Acceleration" switch turned off (or a blocked
 * GPU) leaves WebGL to a software renderer, and games stutter there; overlay.ts then says how to turn it back on.
 * `renderer`: WebGL's unmasked renderer name, null when there's no WebGL at all.
 */
export function slowRenderer(renderer: string | null): boolean {
  return renderer === null || /swiftshader|llvmpipe|softpipe|basic render|software/i.test(renderer);
}

/** The renderer's name in this page, or null without WebGL. */
export function rendererName(doc: Document = document): string | null {
  const gl = doc.createElement("canvas").getContext("webgl");
  if (!gl) return null;
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return typeof name === "string" ? name : "";
}
