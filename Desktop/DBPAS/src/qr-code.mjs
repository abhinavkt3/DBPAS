import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const QRCode = require("../vendor/QRCode");
const QRErrorCorrectLevel = require("../vendor/QRCode/QRErrorCorrectLevel");

export function buildQrSvgDataUrl(text, options = {}) {
  const payload = String(text ?? "").trim();
  if (!payload) {
    return null;
  }

  const border = Math.max(0, Number(options.border ?? 4));
  const dark = options.dark ?? "#102131";
  const light = options.light ?? "#ffffff";

  const qrcode = new QRCode(-1, QRErrorCorrectLevel.M);
  qrcode.addData(payload);
  qrcode.make();

  const moduleCount = qrcode.getModuleCount();
  const size = moduleCount + border * 2;
  const commands = [];

  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      if (qrcode.isDark(row, col)) {
        const x = col + border;
        const y = row + border;
        commands.push(`M${x},${y}h1v1h-1z`);
      }
    }
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code">`,
    `<rect width="${size}" height="${size}" fill="${light}"/>`,
    `<path d="${commands.join("")}" fill="${dark}"/>`,
    "</svg>"
  ].join("");

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
