declare module 'pdf-parse' {
  type PdfPageRenderer = (pageData: any) => Promise<string>;
  type PdfParseOptions = { pagerender?: PdfPageRenderer };
  type PdfParseResult = { text: string; numpages: number };
  const pdfParse: (buffer: Buffer, options?: PdfParseOptions) => Promise<PdfParseResult>;
  export default pdfParse;
}
