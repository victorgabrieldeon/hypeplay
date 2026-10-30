import { expect, test } from "bun:test";
import { slowRenderer } from "./gpu";

test("drawn without the graphics card (Discord's hardware acceleration off, or a blocked GPU): slow", () => {
  for (const r of ["Google SwiftShader", "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)", "llvmpipe (LLVM 15.0.7, 256 bits)", "Microsoft Basic Render Driver", null])
    expect(slowRenderer(r)).toBe(true);
  for (const r of ["ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)", "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)", "Apple M1", "WebKit WebGL"])
    expect(slowRenderer(r)).toBe(false);
});
