declare module 'qrcode/lib/server.js' {
  const QRCode: { toDataURL(text: string, options?: { errorCorrectionLevel?: string; width?: number }): Promise<string> };
  export default QRCode;
}
