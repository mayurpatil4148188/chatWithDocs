export type ExtractedPage = { pageNo: number; text: string; ocrUsed: boolean };

export function assertExtractionLimits(pages: ExtractedPage[], maxPages: number, maxTextBytes: number) {
  if (pages.length > maxPages) throw new Error(`Document exceeds the maximum page count of ${maxPages}`);
  const extractedBytes = Buffer.byteLength(pages.map((page) => page.text).join('\n'), 'utf8');
  if (extractedBytes > maxTextBytes) throw new Error(`Document exceeds the maximum extracted text size of ${maxTextBytes} bytes`);
}
