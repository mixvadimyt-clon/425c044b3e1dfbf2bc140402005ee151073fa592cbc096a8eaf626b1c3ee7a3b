/** PDF начинается с «%PDF-»; перед сигнатурой допускается короткий мусор. У DOCX (zip) и XML сигнатуры нет. */
export const looksLikePdf = (data: ArrayBuffer): boolean => {
  const head = new TextDecoder('latin1').decode(new Uint8Array(data, 0, Math.min(1024, data.byteLength)));
  return head.includes('%PDF-');
};
