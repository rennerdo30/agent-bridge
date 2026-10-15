/** qrcode-generator 2.0.4, Copyright Kazuhiko Arase, MIT. Narrow ESM wrapper. */
export default function qrcode(typeNumber: 0, errorCorrection: "M"): {
  addData(text: string): void;
  make(): void;
  createSvgTag(options: { cellSize: number; margin: number; scalable: boolean }): string;
};
